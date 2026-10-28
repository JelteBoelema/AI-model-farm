import type { ContentFormat, SocialAccount } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { mockConsentCode, mockPlatformBehaviour } from "@/server/platforms/mock";
import { MockImageAdapter } from "@/server/providers/adapters/mock";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { redis } from "@/server/redis";
import { collectAccount, dispatchCollection } from "@/server/services/analytics-collect";
import { analyticsOverview } from "@/server/services/analytics";
import { autopilotUser, runAutopilot } from "@/server/services/autopilot";
import { computeInsights, decideExperiment, listInsights } from "@/server/services/insights";
import { storeGeneratedImage } from "@/server/services/media";
import { publishNow, runPublishJob } from "@/server/services/publishing";
import { completeConnect, startConnect } from "@/server/services/social";
import { acting, makeCreator, makeUser, uid } from "./helpers";
import { readyCreator } from "./pipeline-helpers";

const ORIGIN = "http://localhost:3000";
const H = 3_600_000;
let owner: ReturnType<typeof acting>;
let admin: ReturnType<typeof acting>;
let savedGlobal: Awaited<ReturnType<typeof db.autonomyPolicy.findFirst>>;

async function setMinSample(n: number | null, extra: Record<string, unknown> = {}) {
  await db.autonomyPolicy.deleteMany({ where: { scope: "GLOBAL" } });
  await db.autonomyPolicy.create({ data: { scope: "GLOBAL", maxGenerationsPerItem: 6, maxRetries: 3, analyticsMinSample: n, ...extra } });
}

async function mockAccount(creatorId: string) {
  const url = await startConnect(owner, { creatorId, platform: "INSTAGRAM" }, ORIGIN);
  const state = new URL(url, ORIGIN).searchParams.get("state")!;
  const a = await completeConnect(owner, { platform: "INSTAGRAM", state, code: mockConsentCode(`stats_${uid()}`), error: null });
  return db.socialAccount.findUniqueOrThrow({ where: { id: a.id } });
}

/** Publishes an approved image post to the mock platform and backdates it. */
async function publishedMockPost(account: SocialAccount, hoursAgo: number) {
  const item = await db.contentItem.create({ data: { creatorId: account.creatorId, title: `Post ${uid()}`, format: "IMAGE_POST", status: "APPROVED", caption: "x\n\nMade with AI", script: { shots: [{ scene: "x", purpose: "y" }] } } });
  const out = await new MockImageAdapter().generate({ capability: "IMAGE", model: "mock", prompt: `img ${item.id}`, params: { size: "1024x1536" } });
  const asset = await storeGeneratedImage({ bytes: out.outputs[0]!.bytes!, creatorId: account.creatorId, contentItemId: item.id, shotIndex: 0, providerKey: "mock-image", modelVersion: "mock", prompt: "img", params: {}, isMock: true });
  await db.mediaAsset.update({ where: { id: asset.id }, data: { status: "APPROVED" } });
  const job = await publishNow(owner, { contentItemId: item.id, socialAccountId: account.id });
  await runPublishJob({ jobId: job.id }, 0, AbortSignal.timeout(30_000));
  const done = await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } });
  expect(done.status).toBe("PUBLISHED");
  const when = new Date(Date.now() - hoursAgo * H);
  await db.publishingJob.update({ where: { id: job.id }, data: { confirmedAt: when } });
  await db.mockPlatformPost.update({ where: { externalPostId: done.externalPostId! }, data: { publishedAt: when } });
  return done;
}

/** A real (non-mock) account with measured results inserted as fixtures; never contacted. */
async function realAccount(creatorId: string) {
  return db.socialAccount.create({ data: { creatorId, platform: "INSTAGRAM", handle: `real_${uid()}`, status: "CONNECTED", isMock: false } });
}

async function measuredPost(account: SocialAccount, p: { pillar?: string; format?: ContentFormat; engagement: number; hoursAgo?: number; costEur?: number; origin?: "MEASURED" | "MOCK" }) {
  const item = await db.contentItem.create({ data: { creatorId: account.creatorId, title: `Measured ${uid()}`, format: p.format ?? "IMAGE_POST", pillar: p.pillar ?? null, status: "PUBLISHED" } });
  const confirmedAt = new Date(Date.now() - (p.hoursAgo ?? 100) * H);
  const job = await db.publishingJob.create({
    data: { contentItemId: item.id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: confirmedAt, status: "PUBLISHED", idempotencyKey: `t:${uid()}`, externalPostId: `ext_${uid()}`, confirmedAt, isMock: account.isMock },
  });
  await db.analyticsSnapshot.create({
    data: {
      socialAccountId: account.id,
      publishingJobId: job.id,
      contentItemId: item.id,
      capturedAt: new Date(confirmedAt.getTime() + 72 * H),
      ageHours: 72,
      origin: p.origin ?? "MEASURED",
      source: "test-fixture",
      collectionKey: `post:${job.id}:72h`,
      views: 1200n,
      reach: 1000n,
      likes: BigInt(Math.round(p.engagement * 1000)),
    },
  });
  if (p.costEur) await db.costLedger.create({ data: { entryType: "CHARGE", category: "IMAGE", basis: "MEASURED", amountMicros: BigInt(p.costEur * 1_000_000), creatorId: account.creatorId, contentItemId: item.id, idempotencyKey: `t:${uid()}` } });
  return { item, job };
}

beforeAll(async () => {
  owner = acting(await makeUser("OWNER"));
  admin = acting(await makeUser("ADMIN"));
  savedGlobal = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" } });
});

beforeEach(() => mockPlatformBehaviour.reset());

afterAll(async () => {
  mockPlatformBehaviour.reset();
  await db.autonomyPolicy.deleteMany({ where: { scope: "GLOBAL" } });
  if (savedGlobal) await db.autonomyPolicy.create({ data: savedGlobal });
  for (const q of ["analytics", "publishing", "generation-text"] as const) await getQueue(q).obliterate({ force: true });
  await closeQueues();
  redis().disconnect();
});

describe("snapshot collection", () => {
  it("stores one MOCK snapshot per checkpoint from the mock platform, cumulative and idempotent", async () => {
    const creator = await makeCreator();
    const account = await mockAccount(creator.id);
    const post = await publishedMockPost(account, 2);

    const first = await collectAccount(account.id);
    expect(first).toEqual({ posts: 1, account: true });
    const snap = await db.analyticsSnapshot.findFirstOrThrow({ where: { publishingJobId: post.id } });
    expect(snap).toMatchObject({ origin: "MOCK", source: "mock_platform:v1/insights", collectionKey: `post:${post.id}:1h`, ageHours: 2, contentItemId: post.contentItemId });
    expect(snap.raw).toMatchObject({ mock: true });
    expect(await db.analyticsSnapshot.findFirst({ where: { socialAccountId: account.id, publishingJobId: null } })).toMatchObject({ origin: "MOCK", followers: 1015n });

    // Again in the same slot: nothing new.
    expect(await collectAccount(account.id)).toEqual({ posts: 0, account: false });

    // Four hours later (six after publication) the 6 h checkpoint is due; the counters only grow.
    const later = new Date(Date.now() + 4 * H);
    mockPlatformBehaviour.clock = () => later;
    expect((await collectAccount(account.id, later)).posts).toBe(1);
    const snaps = await db.analyticsSnapshot.findMany({ where: { publishingJobId: post.id }, orderBy: { capturedAt: "asc" } });
    expect(snaps.map((s) => s.collectionKey)).toEqual([`post:${post.id}:1h`, `post:${post.id}:6h`]);
    expect(snaps[1]!.views!).toBeGreaterThan(snaps[0]!.views!);
  });

  it("never lets a mock account produce measured data (database trigger)", async () => {
    const account = await mockAccount((await makeCreator()).id);
    await expect(
      db.analyticsSnapshot.create({ data: { socialAccountId: account.id, capturedAt: new Date(), origin: "MEASURED", source: "x", collectionKey: `x:${uid()}` } }),
    ).rejects.toThrow(/mock account cannot produce MEASURED/);
  });

  it("marks the account for reconnection when the token is refused", async () => {
    const creator = await makeCreator();
    const account = await db.socialAccount.create({ data: { creatorId: creator.id, platform: "INSTAGRAM", handle: `gone_${uid()}`, status: "CONNECTED", isMock: true, externalAccountId: `mock-gone` } });
    const job = await db.publishingJob.create({ data: { contentItemId: (await db.contentItem.create({ data: { creatorId: creator.id, title: "t", format: "IMAGE_POST", status: "PUBLISHED" } })).id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: new Date(), status: "PUBLISHED", idempotencyKey: `t:${uid()}`, externalPostId: "x", confirmedAt: new Date(Date.now() - 2 * H), isMock: true } });
    expect(await collectAccount(account.id)).toMatchObject({ skipped: "token expired" });
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("TOKEN_EXPIRED");
    expect(await db.analyticsSnapshot.count({ where: { publishingJobId: job.id } })).toBe(0);
  });

  it("queues one collection per connected account per hour", async () => {
    const account = await mockAccount((await makeCreator()).id);
    const now = new Date();
    await dispatchCollection(now);
    await dispatchCollection(now);
    const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
    expect(await getQueue("analytics").getJob(`analytics~${account.id}~${hour}`)).toBeTruthy();
  });
});

describe("dashboards keep measured, mock and demo data apart", () => {
  it("aggregates per creator and format with cost per published item, one origin at a time", async () => {
    const creator = await makeCreator();
    const real = await realAccount(creator.id);
    await measuredPost(real, { engagement: 0.05, costEur: 2 });
    await measuredPost(real, { engagement: 0.07, format: "CAROUSEL", costEur: 4 });
    const mock = await mockAccount(creator.id);
    await measuredPost(mock, { engagement: 0.5, origin: "MOCK" });

    const measured = await analyticsOverview({ origin: "MEASURED", creatorId: creator.id });
    expect(measured.total).toMatchObject({ posts: 2, views: 2400, reach: 2000, costMicros: 6_000_000n, costPerPostMicros: 3_000_000n, costPer1kViewsMicros: 2_500_000n });
    expect(measured.total.engagement).toBeCloseTo(0.06);
    expect(measured.byFormat.map((g) => [g.key, g.posts])).toEqual(expect.arrayContaining([["IMAGE_POST", 1], ["CAROUSEL", 1]]));

    const mocked = await analyticsOverview({ origin: "MOCK", creatorId: creator.id });
    expect(mocked.total.posts).toBe(1);
    expect(mocked.total.engagement).toBeCloseTo(0.5);
    expect(mocked.total.costMicros).toBeNull(); // mock generation is never booked
  });
});

describe("insights: predictions with a minimum sample", () => {
  async function creatorWithResults(perGroup: number) {
    const creator = await readyCreator();
    await db.creator.update({ where: { id: creator.id }, data: { contentPillars: [{ name: "Coffee", description: "" }, { name: "Rain", description: "" }], autonomyMode: "ASSISTED" } });
    const account = await realAccount(creator.id);
    for (let i = 0; i < perGroup; i++) {
      await measuredPost(account, { pillar: "Coffee", engagement: 0.09 + (i % 3) * 0.005 });
      await measuredPost(account, { pillar: "Rain", engagement: 0.05 + (i % 3) * 0.005 });
    }
    return creator;
  }

  it("labels a pattern below the minimum sample and does not let it steer the autopilot", async () => {
    await setMinSample(10, { maxNewItemsPerDay: 2 });
    const creator = await creatorWithResults(4);
    await computeInsights();
    const [pattern] = (await listInsights({ origin: "MEASURED", creatorId: creator.id })).filter((i) => i.kind === "PATTERN" && i.dimension === "pillar");
    expect(pattern).toMatchObject({ leader: "Coffee", meetsMinSample: false, minSample: 10, sampleSize: 8 });
    expect(pattern!.pValue!).toBeLessThan(0.05);
    expect(pattern!.finding).toMatch(/Coffee posts had \d+% higher engagement/);

    // An experiment is proposed instead, sized to at least the minimum sample per variant.
    const experiment = (await listInsights({ origin: "MEASURED", creatorId: creator.id })).find((i) => i.kind === "EXPERIMENT" && i.dimension === "pillar");
    expect(experiment!.proposal).toMatchObject({ variants: ["Coffee", "Rain"] });
    expect((experiment!.proposal as { perVariant: number }).perVariant).toBeGreaterThanOrEqual(10);

    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]!.planning).toEqual([]);
    const items = await db.contentItem.findMany({ where: { creatorId: creator.id, createdById: (await autopilotUser()).id }, orderBy: { createdAt: "asc" } });
    expect(items.map((i) => i.pillar)).toEqual(["Coffee", "Rain"]); // plain rotation
  });

  it("steers every other new item to the measured leader once the minimum sample is met", async () => {
    await setMinSample(5, { maxNewItemsPerDay: 4 });
    const creator = await creatorWithResults(6);
    await db.creator.update({ where: { id: creator.id }, data: { contentPillars: [{ name: "Rain", description: "" }, { name: "Tea", description: "" }, { name: "Coffee", description: "" }] } });
    await computeInsights();
    const pattern = await db.insight.findFirstOrThrow({ where: { creatorId: creator.id, kind: "PATTERN", dimension: "pillar", origin: "MEASURED", status: "OPEN" } });
    expect(pattern).toMatchObject({ leader: "Coffee", meetsMinSample: true });
    expect(await db.insight.count({ where: { creatorId: creator.id, kind: "EXPERIMENT", dimension: "pillar", status: "OPEN" } })).toBe(0);

    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]!.planning).toHaveLength(2);
    const items = await db.contentItem.findMany({ where: { creatorId: creator.id, createdById: (await autopilotUser()).id }, orderBy: { createdAt: "asc" } });
    // Even items use the leader, odd items keep rotating (plain rotation would be Rain, Tea, Coffee, Rain).
    expect(items.map((i) => i.pillar)).toEqual(["Coffee", "Tea", "Coffee", "Rain"]);
    expect(items[0]!.idea).toMatch(/Chosen from analytics: measured pattern/);

    // Raising the minimum sample stops it immediately, before the insights are recomputed.
    await setMinSample(50, { maxNewItemsPerDay: 6 });
    const after = await runAutopilot({ creatorIds: [creator.id] });
    expect(after.creators[0]!.planning).toEqual([]);
  });

  it("never steers planning from mock data, however large the sample", async () => {
    await setMinSample(5, { maxNewItemsPerDay: 1 });
    const creator = await readyCreator();
    await db.creator.update({ where: { id: creator.id }, data: { contentPillars: [{ name: "Rain", description: "" }, { name: "Coffee", description: "" }], autonomyMode: "ASSISTED" } });
    const account = await mockAccount(creator.id);
    for (let i = 0; i < 8; i++) {
      await measuredPost(account, { pillar: "Coffee", engagement: 0.09 + (i % 3) * 0.005, origin: "MOCK" });
      await measuredPost(account, { pillar: "Rain", engagement: 0.05 + (i % 3) * 0.005, origin: "MOCK" });
    }
    await computeInsights();
    const mockPattern = await db.insight.findFirstOrThrow({ where: { creatorId: creator.id, kind: "PATTERN", dimension: "pillar", origin: "MOCK", status: "OPEN" } });
    expect(mockPattern.meetsMinSample).toBe(true);
    expect(await listInsights({ origin: "MEASURED", creatorId: creator.id })).toHaveLength(0);
    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]!.planning).toEqual([]);
    const [item] = await db.contentItem.findMany({ where: { creatorId: creator.id, createdById: (await autopilotUser()).id } });
    expect(item!.pillar).toBe("Rain");
  });

  it("lets a person accept an experiment, which the autopilot then alternates; agents and mock data cannot", async () => {
    await setMinSample(10, { maxNewItemsPerDay: 2 });
    const creator = await creatorWithResults(3);
    await computeInsights();
    const experiment = await db.insight.findFirstOrThrow({ where: { creatorId: creator.id, kind: "EXPERIMENT", dimension: "pillar", status: "OPEN" } });

    const pilot = await autopilotUser();
    await expect(decideExperiment({ ...pilot, role: "OWNER" }, experiment.id, true)).rejects.toThrow(/person/);
    const operator = acting(await makeUser("OPERATOR"));
    await expect(decideExperiment(operator, experiment.id, true)).rejects.toThrow(/admins/);
    await decideExperiment(admin, experiment.id, true, "worth a try");
    expect(await db.insight.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "ACCEPTED", decidedById: admin.id });

    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]!.planning.every((p) => p.startsWith("accepted experiment"))).toBe(true);
    const items = await db.contentItem.findMany({ where: { creatorId: creator.id, createdById: pilot.id }, orderBy: { createdAt: "asc" } });
    expect(items.map((i) => i.pillar)).toEqual(["Coffee", "Rain"]);

    // Recomputing keeps the accepted experiment and its variants; it does not propose a second one.
    await computeInsights();
    expect(await db.insight.count({ where: { creatorId: creator.id, kind: "EXPERIMENT", dimension: "pillar", status: { in: ["OPEN", "ACCEPTED"] } } })).toBe(1);

    // A proposal from mock data can only be dismissed.
    const mockCreator = await makeCreator();
    const mockAcc = await mockAccount(mockCreator.id);
    await db.creator.update({ where: { id: mockCreator.id }, data: { contentPillars: [{ name: "A", description: "" }, { name: "B", description: "" }] } });
    for (let i = 0; i < 3; i++) {
      await measuredPost(mockAcc, { pillar: "A", engagement: 0.09 + i * 0.01, origin: "MOCK" });
      await measuredPost(mockAcc, { pillar: "B", engagement: 0.05 + i * 0.01, origin: "MOCK" });
    }
    await computeInsights();
    const mockExperiment = await db.insight.findFirstOrThrow({ where: { creatorId: mockCreator.id, kind: "EXPERIMENT", origin: "MOCK", status: "OPEN", dimension: "pillar" } });
    await expect(decideExperiment(admin, mockExperiment.id, true)).rejects.toThrow(/mock or demo data/);
    await decideExperiment(admin, mockExperiment.id, false, "mock data");
  });
});
