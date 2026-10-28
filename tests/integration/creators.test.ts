import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { toMicros } from "@/lib/money";
import type { CreatorProfileInput } from "@/lib/schemas/creator";
import { assertNotPaused, PausedError } from "@/server/controls";
import { DomainError } from "@/server/errors";
import { proposeCreator } from "@/server/services/creator-wizard";
import {
  changeCreatorStatus,
  createCreator,
  duplicateCreator,
  setAutonomyMode,
  setCreatorBudget,
  updateCreator,
} from "@/server/services/creators";
import { acting, makeContent, makeSocialAccount, makeUser, uid } from "./helpers";

const profile = (name = `Creator ${uid()}`): CreatorProfileInput => ({
  name,
  niche: "Minimal fashion",
  targetAudience: "Women 22–35 in NL and BE",
  language: "nl-NL",
  targetRegions: ["NL", "BE"],
  personality: "Warm, curious",
  toneOfVoice: "Friendly and concise",
  backstory: "A fictional designer living in Utrecht.",
  contentPillars: [{ name: "How-to", description: "Styling tips" }],
  contentFormats: ["IMAGE_POST", "SHORT_VIDEO"],
  timezone: "Europe/Amsterdam",
  publishingSchedule: { slots: [{ platform: "INSTAGRAM", weekday: 2, time: "18:00" }] },
});

const character = {
  appearance: { ageRange: "25-30", build: "", skinTone: "", hair: "dark bob", eyes: "", face: "", distinguishingFeatures: "", wardrobe: "" },
  identityPrompt: "Synthetic adult woman with a dark bob haircut and freckles",
  negativePrompt: "",
  consistencyStrategy: { referenceWeight: 0.8, seed: null, notes: "" },
};

async function approvedCreator(by: ReturnType<typeof acting>) {
  const c = await createCreator(by, profile());
  await db.characterProfile.create({ data: { creatorId: c.id, version: 1, status: "APPROVED", identityPrompt: "x", approvedAt: new Date() } });
  return c;
}

describe("creating creators", () => {
  it("creates a draft with a unique slug, optional character draft and audit entry", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const name = `Lena ${uid()}`;
    const a = await createCreator(op, profile(name), { character, proposalSource: "mock-text:mock" });
    const b = await createCreator(op, profile(name));
    expect(b.slug).toBe(`${a.slug}-2`);
    const row = await db.creator.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe("DRAFT");
    expect(row.autonomyMode).toBe("CONTROLLED_AUTONOMY");
    expect(row.createdById).toBe(op.id);
    expect(await db.characterProfile.findMany({ where: { creatorId: a.id } })).toMatchObject([{ version: 1, status: "DRAFT" }]);
    expect(await db.characterProfile.count({ where: { creatorId: b.id } })).toBe(0);
    const audit = await db.auditLog.findFirst({ where: { action: "creator.created", entityId: a.id } });
    expect(audit?.metadata).toMatchObject({ proposalSource: "mock-text:mock" });
  });

  it("rejects viewers and invalid input", async () => {
    const viewer = acting(await makeUser("VIEWER"));
    await expect(createCreator(viewer, profile())).rejects.toBeInstanceOf(DomainError);
    const op = acting(await makeUser("OPERATOR"));
    await expect(createCreator(op, { ...profile(), targetRegions: ["XX"] })).rejects.toThrow();
  });

  it("wizard proposals are schema-valid, labelled as mock and audited", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const p = await proposeCreator(op, { brief: "A Dutch creator about quick plant-based recipes for students." });
    expect(p.source).toEqual({ generator: "mock-text", isMock: true });
    expect(await db.auditLog.findFirst({ where: { action: "creator.proposal_generated", actorId: op.id } })).not.toBeNull();
    await expect(proposeCreator(acting(await makeUser("VIEWER")), { brief: "x".repeat(30) })).rejects.toBeInstanceOf(DomainError);
  });
});

describe("updating", () => {
  it("audits changed fields only and skips no-op saves", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const c = await createCreator(op, profile());
    const original = await db.creator.findUniqueOrThrow({ where: { id: c.id } });
    await updateCreator(op, c.id, { ...profile(original.name), niche: "Capsule wardrobes" });
    const log = await db.auditLog.findFirst({ where: { action: "creator.updated", entityId: c.id } });
    expect(log?.metadata).toEqual({ fields: ["niche"] });
    await updateCreator(op, c.id, { ...profile(original.name), niche: "Capsule wardrobes" });
    expect(await db.auditLog.count({ where: { action: "creator.updated", entityId: c.id } })).toBe(1);
  });
});

describe("lifecycle", () => {
  it("cannot activate without an approved character profile", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const c = await createCreator(op, profile());
    await expect(changeCreatorStatus(op, c.id, "activate")).rejects.toThrow(/Approve a character profile/);
    await expect(assertNotPaused({ chain: "generation", creatorId: c.id })).rejects.toThrow(/draft/);
  });

  it("pause blocks jobs; operators pause, only admins resume", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const admin = acting(await makeUser("ADMIN"));
    const c = await approvedCreator(op);
    await changeCreatorStatus(op, c.id, "activate");
    await expect(assertNotPaused({ chain: "generation", creatorId: c.id })).resolves.toBeUndefined();

    await changeCreatorStatus(op, c.id, "pause", "identity drift");
    await expect(assertNotPaused({ chain: "publishing", creatorId: c.id })).rejects.toBeInstanceOf(PausedError);
    await expect(changeCreatorStatus(op, c.id, "resume")).rejects.toBeInstanceOf(DomainError);
    await changeCreatorStatus(admin, c.id, "resume");
    await expect(assertNotPaused({ chain: "generation", creatorId: c.id })).resolves.toBeUndefined();

    const actions = (await db.auditLog.findMany({ where: { entityId: c.id, action: { startsWith: "creator." } }, orderBy: { occurredAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["creator.created", "creator.activated", "creator.paused", "creator.resumed"]);
  });

  it("refuses illegal transitions", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const c = await createCreator(op, profile());
    await expect(changeCreatorStatus(op, c.id, "pause")).rejects.toThrow();
    await expect(changeCreatorStatus(acting(await makeUser("ADMIN")), c.id, "resume")).rejects.toThrow(/Cannot resume/);
  });

  it("refuses to archive while publications are scheduled, then archives read-only", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const c = await approvedCreator(op);
    const account = await makeSocialAccount(c.id);
    const item = await makeContent(c.id);
    const job = await db.publishingJob.create({
      data: { contentItemId: item.id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: new Date(Date.now() + 86_400_000), idempotencyKey: `p:${uid()}` },
    });
    await expect(changeCreatorStatus(op, c.id, "archive")).rejects.toThrow(/scheduled publication/);
    await db.publishingJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
    await changeCreatorStatus(op, c.id, "archive", "campaign ended");
    const row = await db.creator.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe("ARCHIVED");
    expect(row.archivedAt).not.toBeNull();
    await expect(updateCreator(op, c.id, profile())).rejects.toThrow(/Archived/);
    await expect(changeCreatorStatus(op, c.id, "activate")).rejects.toThrow();
  });
});

describe("duplicate", () => {
  it("copies settings and budgets into a new draft without the identity", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const c = await approvedCreator(admin);
    await setCreatorBudget(admin, c.id, "MONTH", toMicros("120"));
    const copy = await duplicateCreator(admin, c.id);
    const row = await db.creator.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row.status).toBe("DRAFT");
    expect(row.name).toMatch(/\(copy\)$/);
    expect(row.niche).toBe("Minimal fashion");
    expect(await db.characterProfile.count({ where: { creatorId: copy.id } })).toBe(0);
    expect((await db.budgetPolicy.findFirstOrThrow({ where: { scope: "CREATOR", targetId: copy.id } })).limitMicros).toBe(toMicros("120"));
  });
});

describe("autonomy and budgets", () => {
  it("operators may lower autonomy but only admins may raise it", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const admin = acting(await makeUser("ADMIN"));
    const c = await createCreator(op, profile());
    await setAutonomyMode(op, c.id, "MANUAL");
    await expect(setAutonomyMode(op, c.id, "ASSISTED")).rejects.toBeInstanceOf(DomainError);
    await setAutonomyMode(admin, c.id, "CONTROLLED_AUTONOMY");
    expect((await db.creator.findUniqueOrThrow({ where: { id: c.id } })).autonomyMode).toBe("CONTROLLED_AUTONOMY");
  });

  it("admins add and lower limits; only owners raise or remove them", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const admin = acting(await makeUser("ADMIN"));
    const owner = acting(await makeUser("OWNER"));
    const c = await createCreator(op, profile());

    await expect(setCreatorBudget(op, c.id, "MONTH", toMicros("100"))).rejects.toBeInstanceOf(DomainError);
    await setCreatorBudget(admin, c.id, "MONTH", toMicros("100"));
    await setCreatorBudget(admin, c.id, "MONTH", toMicros("80"));
    await expect(setCreatorBudget(admin, c.id, "MONTH", toMicros("90"))).rejects.toBeInstanceOf(DomainError);
    await expect(setCreatorBudget(admin, c.id, "MONTH", null)).rejects.toBeInstanceOf(DomainError);
    await setCreatorBudget(owner, c.id, "MONTH", toMicros("200"));
    expect((await db.budgetPolicy.findFirstOrThrow({ where: { scope: "CREATOR", targetId: c.id, period: "MONTH" } })).limitMicros).toBe(toMicros("200"));
    await setCreatorBudget(owner, c.id, "MONTH", null);
    expect(await db.budgetPolicy.count({ where: { scope: "CREATOR", targetId: c.id } })).toBe(0);

    const actions = (await db.auditLog.findMany({ where: { entityId: c.id, action: { startsWith: "budget." } }, orderBy: { occurredAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["budget.lowered", "budget.lowered", "budget.raised", "budget.raised"]);
    await expect(setCreatorBudget(owner, c.id, "DAY", -1n)).rejects.toThrow(/negative/);
  });
});
