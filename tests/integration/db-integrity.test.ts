import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { toMicros } from "@/lib/money";
import { makeContent, makeCreator, makeSocialAccount, uid } from "./helpers";

describe("append-only tables", () => {
  it("rejects updates and deletes on the cost ledger", async () => {
    const entry = await db.costLedger.create({
      data: { entryType: "CHARGE", category: "IMAGE", basis: "PROVIDER_REPORTED", amountMicros: toMicros("0.04"), idempotencyKey: `t:${uid()}` },
    });
    await expect(db.costLedger.update({ where: { id: entry.id }, data: { amountMicros: 0n } })).rejects.toThrow(/append-only/);
    await expect(db.costLedger.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe('TRUNCATE "cost_ledger"')).rejects.toThrow(/append-only/);
  });

  it("rejects updates and deletes on the audit log", async () => {
    const log = await db.auditLog.create({ data: { actorType: "SYSTEM", actorLabel: "test", action: "test.created" } });
    await expect(db.auditLog.update({ where: { id: log.id }, data: { action: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.deleteMany({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });

  it("deduplicates ledger bookings by idempotency key", async () => {
    const key = `t:${uid()}`;
    const data = { entryType: "CHARGE" as const, category: "TOKENS" as const, basis: "MEASURED" as const, amountMicros: 10n, idempotencyKey: key };
    await db.costLedger.create({ data });
    await expect(db.costLedger.create({ data })).rejects.toThrow(/Unique constraint/);
  });

  it("requires an uncertainty note on estimated costs", async () => {
    await expect(
      db.costLedger.create({ data: { entryType: "CHARGE", category: "VIDEO_SECONDS", basis: "ESTIMATED", amountMicros: 10n, idempotencyKey: `t:${uid()}` } }),
    ).rejects.toThrow(/cost_ledger_estimate_explained/);
  });
});

describe("duplicate publication guard", () => {
  it("allows only one live publishing job per item and account", async () => {
    const creator = await makeCreator();
    const account = await makeSocialAccount(creator.id);
    const item = await makeContent(creator.id);
    const job = (key: string) => ({ contentItemId: item.id, socialAccountId: account.id, platform: account.platform, scheduledFor: new Date(), idempotencyKey: key });

    const first = await db.publishingJob.create({ data: job(`p:${uid()}`) });
    await expect(db.publishingJob.create({ data: job(`p:${uid()}`) })).rejects.toThrow(/publishing_jobs_live_unique|Unique constraint/);

    await db.publishingJob.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await expect(db.publishingJob.create({ data: job(`p:${uid()}`) })).resolves.toBeTruthy();
  });

  it("never stores the same external post twice", async () => {
    const creator = await makeCreator();
    const a = await makeSocialAccount(creator.id);
    const b = await makeSocialAccount(creator.id);
    const externalPostId = `ext_${uid()}`;
    const item1 = await makeContent(creator.id);
    const item2 = await makeContent(creator.id);
    await db.publishingJob.create({ data: { contentItemId: item1.id, socialAccountId: a.id, platform: "INSTAGRAM", scheduledFor: new Date(), idempotencyKey: `p:${uid()}`, externalPostId } });
    await expect(
      db.publishingJob.create({ data: { contentItemId: item2.id, socialAccountId: b.id, platform: "INSTAGRAM", scheduledFor: new Date(), idempotencyKey: `p:${uid()}`, externalPostId } }),
    ).rejects.toThrow();
  });
});

describe("policy constraints", () => {
  it("allows one budget per scope, target and period", async () => {
    const creator = await makeCreator();
    await db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitMicros: 100n } });
    await expect(db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitMicros: 200n } })).rejects.toThrow();
    await expect(db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, period: "DAY", limitMicros: 10n } })).resolves.toBeTruthy();
  });

  it("rejects negative budgets and target/scope mismatches", async () => {
    await expect(db.budgetPolicy.create({ data: { scope: "GLOBAL", period: "DAY", limitMicros: -1n } })).rejects.toThrow();
    await expect(db.budgetPolicy.create({ data: { scope: "CREATOR", period: "DAY", limitMicros: 1n } })).rejects.toThrow(/target_matches_scope/);
  });

  it("keeps at most one approved character profile per creator", async () => {
    const creator = await makeCreator();
    await db.characterProfile.create({ data: { creatorId: creator.id, version: 1, status: "APPROVED", identityPrompt: "x" } });
    await expect(db.characterProfile.create({ data: { creatorId: creator.id, version: 2, status: "APPROVED", identityPrompt: "y" } })).rejects.toThrow();
  });

  it("validates media checksums", async () => {
    await expect(
      db.mediaAsset.create({ data: { kind: "IMAGE", source: "UPLOADED", storageKey: `k/${uid()}`, mimeType: "image/png", sizeBytes: 1n, checksumSha256: "nope" } }),
    ).rejects.toThrow(/checksum_format/);
  });
});
