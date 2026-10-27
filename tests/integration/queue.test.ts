import { afterAll, describe, expect, it } from "vitest";
import { QueueEvents, type Worker } from "bullmq";
import { createRedis, bullConnectionOptions, redis } from "@/server/redis";
import { DEAD_LETTER_QUEUE } from "@/server/queue/definitions";
import { closeQueues, enqueue, getQueue, getQueueStats, QUEUE_PREFIX } from "@/server/queue/queues";
import { createWorker, listHeartbeats, removeHeartbeat, writeHeartbeat } from "@/server/queue/worker";
import { uid } from "./helpers";

const workers: Worker[] = [];

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  redis().disconnect();
});

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("queues", () => {
  it("uses the test prefix", () => {
    expect(QUEUE_PREFIX).toBe("cf-test");
  });

  it("does not enqueue the same idempotency key twice", async () => {
    const key = `idem:${uid()}:step`;
    const a = await enqueue("planning", "plan.test", { n: 1 }, { idempotencyKey: key, delay: 60_000 });
    const b = await enqueue("planning", "plan.test", { n: 2 }, { idempotencyKey: key, delay: 60_000 });
    expect(a.id).toBe(b.id);
    const jobs = await getQueue("planning").getJobs(["delayed"]);
    expect(jobs.filter((j) => j.id === a.id)).toHaveLength(1);
    expect(jobs.find((j) => j.id === a.id)!.data).toEqual({ n: 1 });
    await expect(enqueue("planning", "x", {}, { idempotencyKey: "bad key with spaces" })).rejects.toThrow();
    // keys that differ only in ":" vs "_" must stay distinct jobs
    const c = await enqueue("planning", "plan.test", {}, { idempotencyKey: `idem_${key.slice(5)}`, delay: 60_000 });
    expect(c.id).not.toBe(a.id);
  });

  it("processes jobs and dead-letters them after the final attempt", async () => {
    const seen: string[] = [];
    const worker = createWorker("maintenance", {
      "test.ok": async (job) => {
        seen.push(job.id!);
        return { done: true };
      },
      "test.fail": async () => {
        throw new Error("provider exploded");
      },
    });
    workers.push(worker);
    const events = new QueueEvents("maintenance", { connection: createRedis(bullConnectionOptions), prefix: QUEUE_PREFIX });
    await events.waitUntilReady();

    const ok = await enqueue("maintenance", "test.ok", {}, { idempotencyKey: `ok:${uid()}` });
    await ok.waitUntilFinished(events, 10_000);
    expect(seen).toContain(ok.id);

    const bad = await enqueue("maintenance", "test.fail", { payload: 1 }, { idempotencyKey: `fail:${uid()}`, attempts: 1 });
    const dead = await waitFor(async () => (await getQueue(DEAD_LETTER_QUEUE).getJobs(["waiting"])).find((j) => j.data.jobId === bad.id));
    expect(dead.data).toMatchObject({ queue: "maintenance", failedReason: "provider exploded", data: { payload: 1 } });

    const unknown = await enqueue("maintenance", "test.unknown", {}, { idempotencyKey: `unk:${uid()}` });
    const deadUnknown = await waitFor(async () => (await getQueue(DEAD_LETTER_QUEUE).getJobs(["waiting"])).find((j) => j.data.jobId === unknown.id));
    expect(deadUnknown.data.failedReason).toMatch(/No processor/);
    await events.close();
  });

  it("reports queue stats and worker heartbeats", async () => {
    await writeHeartbeat(["maintenance"]);
    const beats = await listHeartbeats();
    expect(beats.some((b) => b.alive && b.queues.includes("maintenance"))).toBe(true);
    await removeHeartbeat();
    const stats = await getQueueStats();
    expect(stats.map((s) => s.name)).toContain(DEAD_LETTER_QUEUE);
    expect(stats.find((s) => s.name === DEAD_LETTER_QUEUE)!.counts.waiting).toBeGreaterThanOrEqual(1);
  });
});
