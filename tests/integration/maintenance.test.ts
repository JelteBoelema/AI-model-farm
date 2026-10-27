import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { detectStuckJobs, expireReservations } from "@/workers/processors/maintenance";
import { makeContent, makeCreator, makeProvider, makeSocialAccount, uid } from "./helpers";

describe("reservation expiry", () => {
  it("releases only expired held reservations", async () => {
    const now = new Date();
    const expired = await db.budgetReservation.create({ data: { amountMicros: 100n, basis: "ESTIMATED", expiresAt: new Date(now.getTime() - 1000) } });
    const live = await db.budgetReservation.create({ data: { amountMicros: 100n, basis: "ESTIMATED", expiresAt: new Date(now.getTime() + 60_000) } });
    const consumed = await db.budgetReservation.create({ data: { amountMicros: 100n, basis: "ESTIMATED", status: "CONSUMED", expiresAt: new Date(now.getTime() - 1000) } });
    expect(await expireReservations(now)).toBeGreaterThanOrEqual(1);
    expect((await db.budgetReservation.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe("RELEASED");
    expect((await db.budgetReservation.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("HELD");
    expect((await db.budgetReservation.findUniqueOrThrow({ where: { id: consumed.id } })).status).toBe("CONSUMED");
  });
});

describe("stuck job detection (safe resume after crash)", () => {
  it("fails stale generation jobs and moves stale publications to remote confirmation", async () => {
    const creator = await makeCreator();
    const provider = await makeProvider();
    const account = await makeSocialAccount(creator.id);
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60_000);

    const stale = await db.generationJob.create({ data: { creatorId: creator.id, providerId: provider.id, kind: "IMAGE", status: "RUNNING", idempotencyKey: `g:${uid()}`, startedAt: hourAgo } });
    const fresh = await db.generationJob.create({ data: { creatorId: creator.id, providerId: provider.id, kind: "IMAGE", status: "RUNNING", idempotencyKey: `g:${uid()}`, startedAt: now } });
    const longVideo = await db.generationJob.create({ data: { creatorId: creator.id, providerId: provider.id, kind: "VIDEO", status: "RUNNING", idempotencyKey: `g:${uid()}`, startedAt: hourAgo } });

    const item = await makeContent(creator.id);
    const pub = await db.publishingJob.create({
      data: { contentItemId: item.id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: hourAgo, status: "PUBLISHING", idempotencyKey: `p:${uid()}` },
    });
    await db.$executeRaw`UPDATE publishing_jobs SET updated_at = ${hourAgo} WHERE id = ${pub.id}::uuid`;

    const report = await detectStuckJobs(now);
    expect(report.generationFailed).toBeGreaterThanOrEqual(1);
    expect(report.publishingAwaitingConfirmation).toBeGreaterThanOrEqual(1);

    const staleRow = await db.generationJob.findUniqueOrThrow({ where: { id: stale.id } });
    expect(staleRow.status).toBe("FAILED");
    expect(staleRow.error).toMatchObject({ code: "STUCK" });
    expect((await db.generationJob.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("RUNNING");
    expect((await db.generationJob.findUniqueOrThrow({ where: { id: longVideo.id } })).status).toBe("RUNNING"); // video limit is 90 min
    const pubRow = await db.publishingJob.findUniqueOrThrow({ where: { id: pub.id } });
    expect(pubRow.status).toBe("AWAITING_CONFIRMATION"); // never re-submitted blindly
    expect(await db.notification.findFirst({ where: { type: "workflow.stuck_jobs" } })).not.toBeNull();

    // idempotent: a second run changes nothing for these jobs
    await detectStuckJobs(now);
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: pub.id } })).status).toBe("AWAITING_CONFIRMATION");
  });
});
