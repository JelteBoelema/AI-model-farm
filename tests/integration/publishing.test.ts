import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setControlSwitch } from "@/server/controls";
import { mockConsentCode, mockPlatformBehaviour } from "@/server/platforms/mock";
import { MockImageAdapter } from "@/server/providers/adapters/mock";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { redis } from "@/server/redis";
import { requireSecret } from "@/server/secrets";
import { buildExportPackage } from "@/server/services/export-package";
import { storeGeneratedImage } from "@/server/services/media";
import {
  bulkSchedule,
  cancelPublication,
  dispatchDuePublications,
  markPublishedManually,
  publishNow,
  retryPublication,
  runPublishJob,
  schedulePublication,
} from "@/server/services/publishing";
import { completeConnect, decideConnection, refreshExpiringTokens, startConnect } from "@/server/services/social";
import { acting, makeCreator, makeUser, uid } from "./helpers";

const ORIGIN = "http://localhost:3000";
const signal = () => new AbortController().signal;
const HOUR = 3_600_000;

let owner: ReturnType<typeof acting>;
let admin: ReturnType<typeof acting>;
let operator: ReturnType<typeof acting>;

async function users() {
  owner ??= acting(await makeUser("OWNER"));
  admin ??= acting(await makeUser("ADMIN"));
  operator ??= acting(await makeUser("OPERATOR"));
}

/** Runs the mock OAuth round trip for a handle. */
async function connect(by: ReturnType<typeof acting>, creatorId: string, handle = `acc_${uid()}`) {
  const url = await startConnect(by, { creatorId, platform: "INSTAGRAM" }, ORIGIN);
  const state = new URL(url, ORIGIN).searchParams.get("state")!;
  return completeConnect(by, { platform: "INSTAGRAM", state, code: mockConsentCode(handle), error: null });
}

async function connectedAccount(creatorId: string, handle?: string) {
  const account = await connect(owner, creatorId, handle);
  return db.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
}

/** An approved image post with one approved (mock) image. */
async function approvedItem(creatorId: string, mock = true) {
  const item = await db.contentItem.create({ data: { creatorId, title: `Post ${uid()}`, format: "IMAGE_POST", status: "APPROVED", caption: "Rainy day layers\n\nMade with AI", hashtags: ["autumn", "style"], script: { shots: [{ scene: "x", purpose: "y" }] } } });
  const out = await new MockImageAdapter().generate({ capability: "IMAGE", model: "mock", prompt: `img ${item.id}`, params: { size: "1024x1536" } });
  const asset = await storeGeneratedImage({ bytes: out.outputs[0]!.bytes!, creatorId, contentItemId: item.id, shotIndex: 0, providerKey: "mock-image", modelVersion: "mock", prompt: "img", params: {}, isMock: mock });
  await db.mediaAsset.update({ where: { id: asset.id }, data: { status: "APPROVED" } });
  return item;
}

async function creatorWithSlots() {
  const creator = await makeCreator();
  return db.creator.update({
    where: { id: creator.id },
    data: { timezone: "Europe/Amsterdam", publishingSchedule: { slots: [{ platform: "INSTAGRAM", weekday: 2, time: "18:00" }, { platform: "INSTAGRAM", weekday: 5, time: "12:00" }] } },
  });
}

async function runUntilSettled(jobId: string) {
  for (let i = 0; i < 10; i++) {
    const job = await db.publishingJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!["QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION"].includes(job.status)) return job;
    await runPublishJob({ jobId }, 0, signal()).catch(() => undefined);
  }
  return db.publishingJob.findUniqueOrThrow({ where: { id: jobId } });
}

beforeEach(async () => {
  mockPlatformBehaviour.reset();
  await users();
});

afterAll(async () => {
  mockPlatformBehaviour.reset();
  await getQueue("publishing").obliterate({ force: true });
  await closeQueues();
  redis().disconnect();
});

describe("connecting accounts", () => {
  it("needs the owner's approval when an admin connects, and stores tokens only in the secret store", async () => {
    const creator = await makeCreator();
    const account = await connect(admin, creator.id, `lena_${uid()}`);
    expect(account.status).toBe("PENDING_APPROVAL");
    const row = await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.credentialRef).toBe(`local:social/${account.id}`);
    expect(row.isMock).toBe(true);
    const tokens = JSON.parse(await requireSecret(row.credentialRef!));
    expect(tokens.accessToken).toMatch(/^mock-token-/);
    expect(JSON.stringify(row)).not.toContain(tokens.accessToken);
    expect(await db.approval.findFirst({ where: { subjectType: "SOCIAL_ACCOUNT_LINK", subjectId: account.id } })).toMatchObject({ decision: "PENDING" });

    await expect(decideConnection(admin, account.id, true)).rejects.toThrow(/permission/);
    await decideConnection(owner, account.id, true);
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("CONNECTED");
  });

  it("is connected directly when the owner connects; rejecting a link removes the tokens", async () => {
    const creator = await makeCreator();
    const mine = await connect(owner, creator.id);
    expect(mine.status).toBe("CONNECTED");
    expect(await db.approval.findFirst({ where: { subjectId: mine.id } })).toMatchObject({ decision: "APPROVED" });

    const other = await connect(admin, (await makeCreator()).id);
    await decideConnection(owner, other.id, false, "Wrong account");
    const rejected = await db.socialAccount.findUniqueOrThrow({ where: { id: other.id } });
    expect(rejected).toMatchObject({ status: "NOT_CONNECTED", credentialRef: null });
  });

  it("rejects reused, foreign and unknown states, and operators may not connect", async () => {
    const creator = await makeCreator();
    const url = await startConnect(admin, { creatorId: creator.id, platform: "INSTAGRAM" }, ORIGIN);
    const state = new URL(url, ORIGIN).searchParams.get("state")!;
    await expect(completeConnect(owner, { platform: "INSTAGRAM", state, code: mockConsentCode("x_y"), error: null })).rejects.toThrow(/another session/);
    await expect(completeConnect(admin, { platform: "INSTAGRAM", state, code: mockConsentCode("x_y"), error: null })).rejects.toThrow(/expired or was already used/);
    await expect(completeConnect(admin, { platform: "INSTAGRAM", state: "nope", code: "x", error: null })).rejects.toThrow(/expired/);
    await expect(startConnect(operator, { creatorId: creator.id, platform: "INSTAGRAM" }, ORIGIN)).rejects.toThrow(/permission/);
    await expect(startConnect(admin, { creatorId: creator.id, platform: "TIKTOK" }, ORIGIN)).rejects.toThrow(/Instagram comes first/);
  });

  it("refreshes tokens that are about to expire", async () => {
    const account = await connectedAccount((await makeCreator()).id);
    await db.socialAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() + 2 * 86_400_000) } });
    const before = JSON.parse(await requireSecret(account.credentialRef!)).accessToken;
    await refreshExpiringTokens();
    const after = await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 86_400_000);
    expect(JSON.parse(await requireSecret(after.credentialRef!)).accessToken).not.toBe(before);
  });
});

describe("scheduling", () => {
  it("schedules approved content and enforces the daily limit and minimum gap in the creator's time zone", async () => {
    const creator = await creatorWithSlots();
    const account = await connectedAccount(creator.id);
    await db.socialAccount.update({ where: { id: account.id }, data: { maxPostsPerDay: 2, minGapMinutes: 60 } });
    const at = new Date("2030-06-04T16:00:00Z"); // 18:00 in Amsterdam
    const a = await approvedItem(creator.id);
    const job = await schedulePublication(operator, { contentItemId: a.id, socialAccountId: account.id, scheduledFor: at });
    expect(job).toMatchObject({ status: "SCHEDULED", isMock: true, caption: "Rainy day layers\n\nMade with AI\n\n#autumn #style" });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("SCHEDULED");

    const b = await approvedItem(creator.id);
    await expect(schedulePublication(operator, { contentItemId: b.id, socialAccountId: account.id, scheduledFor: new Date(at.getTime() + 30 * 60_000) })).rejects.toThrow(/Less than 60 minutes/);
    await schedulePublication(operator, { contentItemId: b.id, socialAccountId: account.id, scheduledFor: new Date(at.getTime() + 2 * HOUR) });
    const c = await approvedItem(creator.id);
    // 23:30 local is still the same day in Amsterdam (21:30 UTC)
    await expect(schedulePublication(operator, { contentItemId: c.id, socialAccountId: account.id, scheduledFor: new Date("2030-06-04T21:30:00Z") })).rejects.toThrow(/limit 2 per day/);
    // 00:30 local is the next day (22:30 UTC on the 4th)
    await schedulePublication(operator, { contentItemId: c.id, socialAccountId: account.id, scheduledFor: new Date("2030-06-04T22:30:00Z") });
    await expect(schedulePublication(operator, { contentItemId: a.id, socialAccountId: account.id, scheduledFor: new Date("2030-06-10T10:00:00Z") })).rejects.toThrow(/already scheduled/);
  });

  it("never sends mock media to a real account, and refuses unapproved links and content", async () => {
    const creator = await makeCreator();
    const real = await db.socialAccount.create({ data: { creatorId: creator.id, platform: "INSTAGRAM", handle: `real_${uid()}`, status: "CONNECTED", isMock: false, capabilities: { IMAGE_POST: { ok: true } } } });
    const item = await approvedItem(creator.id, true);
    await expect(schedulePublication(operator, { contentItemId: item.id, socialAccountId: real.id, scheduledFor: new Date(Date.now() + HOUR) })).rejects.toThrow(/Mock media can never be published to a real account/);

    const pending = await connect(admin, creator.id);
    await expect(schedulePublication(operator, { contentItemId: item.id, socialAccountId: pending.id, scheduledFor: new Date(Date.now() + HOUR) })).rejects.toThrow(/not approved/);
    const draft = await db.contentItem.create({ data: { creatorId: creator.id, title: "Draft", format: "IMAGE_POST", status: "READY" } });
    const ok = await connectedAccount(creator.id);
    await expect(schedulePublication(operator, { contentItemId: draft.id, socialAccountId: ok.id, scheduledFor: new Date(Date.now() + HOUR) })).rejects.toThrow(/Only approved/);
  });

  it("records missing permissions as needing a person, with the export package as alternative", async () => {
    const creator = await makeCreator();
    const limited = await connectedAccount(creator.id, `lena_${uid()}_limited`);
    expect(limited.status).toBe("INSUFFICIENT_SCOPE");
    const item = await approvedItem(creator.id);
    const job = await schedulePublication(operator, { contentItemId: item.id, socialAccountId: limited.id, scheduledFor: new Date(Date.now() + HOUR) });
    expect(job.status).toBe("NEEDS_MANUAL_ACTION");
    expect(job.lastError).toMatchObject({ message: expect.stringContaining("export package") });

    const pkg = await buildExportPackage(item.id);
    expect(pkg.filename).toMatch(/-MOCK\.zip$/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-"));
    writeFileSync(path.join(dir, "p.zip"), pkg.bytes);
    const names = execFileSync("python3", ["-c", "import zipfile,sys; print(','.join(zipfile.ZipFile(sys.argv[1]).namelist()))", path.join(dir, "p.zip")]).toString().trim();
    expect(names).toBe("01.png,caption.txt,checklist.md,metadata.json");

    await markPublishedManually(operator, job.id, "https://www.instagram.com/p/abc123/");
    expect(await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "PUBLISHED", externalUrl: "https://www.instagram.com/p/abc123/" });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("PUBLISHED");
  });

  it("spreads a batch over the creator's next free slots (in their time zone)", async () => {
    const creator = await creatorWithSlots();
    const account = await connectedAccount(creator.id);
    const items = [await approvedItem(creator.id), await approvedItem(creator.id), await approvedItem(creator.id)];
    const from = new Date("2030-06-03T08:00:00Z"); // a Monday
    const res = await bulkSchedule(operator, { socialAccountId: account.id, contentItemIds: items.map((i) => i.id), from }, from);
    expect(res.map((r) => r.scheduledFor?.toISOString())).toEqual(["2030-06-04T16:00:00.000Z", "2030-06-07T10:00:00.000Z", "2030-06-11T16:00:00.000Z"]);
  });
});

describe("publishing with the mock platform", () => {
  async function due(creatorId?: string) {
    const creator = creatorId ? { id: creatorId } : await makeCreator();
    const account = await connectedAccount(creator.id);
    const item = await approvedItem(creator.id);
    const job = await schedulePublication(operator, { contentItemId: item.id, socialAccountId: account.id, scheduledFor: new Date(Date.now() + 5 * 60_000) });
    await db.publishingJob.update({ where: { id: job.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    return { account, item, job };
  }

  it("dispatches due posts and publishes them once", async () => {
    const { account, item, job } = await due();
    const res = await dispatchDuePublications();
    expect(res.queued).toBeGreaterThanOrEqual(1);
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");
    const done = await runUntilSettled(job.id);
    expect(done).toMatchObject({ status: "PUBLISHED", attempt: 1, externalPostId: expect.stringMatching(/^mockpost_/) });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("PUBLISHED");
    const posts = await db.mockPlatformPost.findMany({ where: { socialAccountId: account.id } });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.caption).toContain("#autumn");
    expect(await runPublishJob({ jobId: job.id }, 0, signal())).toEqual({ skipped: true });
  });

  it("verifies the remote status after a timeout instead of publishing again", async () => {
    const { account, job } = await due();
    await dispatchDuePublications();
    mockPlatformBehaviour.loseNextPublishResponse = true;
    expect(await runPublishJob({ jobId: job.id }, 0, signal())).toEqual({ awaitingConfirmation: true });
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("AWAITING_CONFIRMATION");
    expect(await runPublishJob({ jobId: job.id }, 0, signal())).toMatchObject({ verified: true });
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PUBLISHED");
    expect(await db.mockPlatformPost.count({ where: { socialAccountId: account.id } })).toBe(1);
  });

  it("does not publish twice after a crash right after the publish call", async () => {
    const { account, job } = await due();
    await dispatchDuePublications();
    // Crash simulation: the platform published, but the worker died before recording it.
    mockPlatformBehaviour.loseNextPublishResponse = true;
    await runPublishJob({ jobId: job.id }, 0, signal());
    await db.publishingJob.update({ where: { id: job.id }, data: { status: "PUBLISHING" } }); // state as left by the crash
    await runUntilSettled(job.id);
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PUBLISHED");
    expect(await db.mockPlatformPost.count({ where: { socialAccountId: account.id } })).toBe(1);
  });

  it("re-publishes only after verifying that a crashed attempt did not go out", async () => {
    const { account, job } = await due();
    await dispatchDuePublications();
    mockPlatformBehaviour.processingPolls = 1;
    expect(await runPublishJob({ jobId: job.id }, 0, signal())).toEqual({ processing: true });
    const mid = await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } });
    // Crash before the platform received the publish call.
    await db.publishingJob.update({ where: { id: job.id }, data: { remoteState: { ...(mid.remoteState as object), publishAttemptedAt: new Date().toISOString() } } });
    const done = await runUntilSettled(job.id);
    expect(done.status).toBe("PUBLISHED");
    expect(done.attempt).toBe(2);
    expect(await db.mockPlatformPost.count({ where: { socialAccountId: account.id } })).toBe(1);
  });

  it("holds posts while publishing is paused", async () => {
    const { job } = await due();
    await setControlSwitch(owner.actor, { scope: "ALL_PUBLISHING", paused: true, reason: "test" });
    await dispatchDuePublications();
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SCHEDULED");
    await setControlSwitch(owner.actor, { scope: "ALL_PUBLISHING", paused: false, reason: "resume" });
    await dispatchDuePublications();
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");
  });

  it("turns an expired token into a reconnect request and lets a person retry", async () => {
    const { account, item, job } = await due();
    await dispatchDuePublications();
    mockPlatformBehaviour.failNextPublish = "auth";
    await runPublishJob({ jobId: job.id }, 0, signal()).catch(() => undefined);
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("NEEDS_MANUAL_ACTION");
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("TOKEN_EXPIRED");
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("SCHEDULED"); // waiting for a person
    await expect(retryPublication(operator, job.id)).rejects.toThrow(/not ready/);
    await db.socialAccount.update({ where: { id: account.id }, data: { status: "CONNECTED" } });
    await retryPublication(operator, job.id);
    expect((await runUntilSettled(job.id)).status).toBe("PUBLISHED");
    expect(await db.mockPlatformPost.count({ where: { socialAccountId: account.id } })).toBe(1);
  });

  it("publishes now: scheduled for the current minute and queued at once", async () => {
    const creator = await makeCreator();
    const account = await connectedAccount(creator.id);
    const item = await approvedItem(creator.id);
    const job = await publishNow(operator, { contentItemId: item.id, socialAccountId: account.id });
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");
    expect((await runUntilSettled(job.id)).status).toBe("PUBLISHED");
  });

  it("retries transient platform errors and cancels cleanly", async () => {
    const { job } = await due();
    await dispatchDuePublications();
    mockPlatformBehaviour.failNextPublish = "transient";
    expect(await runPublishJob({ jobId: job.id }, 0, signal())).toEqual({ retrying: true });
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");
    expect((await runUntilSettled(job.id)).status).toBe("PUBLISHED");

    const second = await due();
    await cancelPublication(operator, second.job.id);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: second.item.id } })).status).toBe("APPROVED");
  });
});
