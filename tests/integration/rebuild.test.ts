import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncProviderRegistry } from "@/server/providers/registry";
import { db } from "@/server/db";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { redis } from "@/server/redis";
import { createContent } from "@/server/services/content";
import { rebuildQueues } from "@/workers/rebuild";
import { acting, makeContent, makeSocialAccount, makeUser, uid } from "./helpers";
import { readyCreator } from "./pipeline-helpers";

beforeAll(() => syncProviderRegistry());

afterAll(async () => {
  for (const q of ["generation-text", "publishing", "maintenance"] as const) await getQueue(q).obliterate({ force: true });
  await closeQueues();
  redis().disconnect();
});

describe("rebuilding the queues after Redis was lost", () => {
  it("re-queues waiting work from the database and never re-runs a paid step blindly", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const creator = await readyCreator();
    const waiting = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "Waiting", produce: true });
    const interrupted = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "Interrupted", produce: true });
    const runningJob = await db.generationJob.findFirstOrThrow({ where: { contentItemId: interrupted.id } });
    await db.generationJob.update({ where: { id: runningJob.id }, data: { status: "RUNNING", attempt: 1, startedAt: new Date() } });
    const account = await makeSocialAccount(creator.id);
    const queuedPost = await db.publishingJob.create({ data: { contentItemId: (await makeContent(creator.id)).id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: new Date(), status: "QUEUED", idempotencyKey: `t:${uid()}` } });
    const inFlight = await db.publishingJob.create({ data: { contentItemId: (await makeContent(creator.id)).id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: new Date(), status: "PUBLISHING", idempotencyKey: `t:${uid()}` } });

    await redis().flushdb(); // Redis lost
    expect(await getQueue("generation-text").count()).toBe(0);

    const report = await rebuildQueues();
    expect(report.content).toMatchObject({ queued: expect.any(Number), interrupted: 1 });
    expect(report.content.queued).toBeGreaterThanOrEqual(1);
    expect(report.publishing).toMatchObject({ wasPublishing: 1 });

    const waitingJob = await db.generationJob.findFirstOrThrow({ where: { contentItemId: waiting.id } });
    const queued = await getQueue("generation-text").getJobs(["waiting", "prioritized", "delayed"]);
    expect(queued.some((j) => (j.data as { jobId: string }).jobId === waitingJob.id)).toBe(true);
    expect(queued.some((j) => (j.data as { jobId: string }).jobId === runningJob.id)).toBe(false);

    expect(await db.generationJob.findUniqueOrThrow({ where: { id: runningJob.id } })).toMatchObject({ status: "FAILED" });
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: interrupted.id } })).toMatchObject({ failedStep: "brief" });

    const posts = (await getQueue("publishing").getJobs(["waiting", "prioritized", "delayed"])).map((j) => (j.data as { jobId: string }).jobId);
    expect(posts).toEqual(expect.arrayContaining([queuedPost.id, inFlight.id]));
    expect((await db.publishingJob.findUniqueOrThrow({ where: { id: inFlight.id } })).status).toBe("AWAITING_CONFIRMATION");
    expect((await getQueue("maintenance").getJobSchedulers()).length).toBeGreaterThan(5);
    expect(await db.auditLog.findFirst({ where: { action: "queues.rebuilt" } })).not.toBeNull();
  });
});
