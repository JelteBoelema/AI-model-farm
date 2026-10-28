import { readFileSync } from "node:fs";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { QUEUE_NAMES, WORKER_ROLES } from "@/server/queue/definitions";
import { breachingAlarms, collectMetrics, loadAlarms, toEmf, type FarmMetrics } from "@/server/queue/metrics";
import { closeQueues, getQueue, QUEUE_PREFIX } from "@/server/queue/queues";
import { HEARTBEAT_TTL_MS } from "@/server/queue/worker";
import { redis } from "@/server/redis";
import { withSpan } from "@/server/telemetry";
import { makeContent, makeCreator, makeProvider, makeSocialAccount, uid } from "./helpers";

const { alarms } = loadAlarms();

function healthy(): FarmMetrics {
  return {
    at: new Date(),
    queues: QUEUE_NAMES.map((queue) => ({ queue, backlog: 3, active: 1, failed: 0, oldestWaitingSeconds: 20 })),
    workersAlive: Object.fromEntries(WORKER_ROLES.map((r) => [r, 1])) as FarmMetrics["workersAlive"],
    deadLetterJobs: 0,
    stuckJobs: 0,
    publishingFailedLastHour: 0,
    budgetPausesActive: 0,
    accountsNeedingReconnect: 0,
  };
}

beforeEach(async () => {
  await redis().flushdb();
});

afterAll(async () => {
  await closeQueues();
  redis().disconnect();
});

describe("alarm definitions", () => {
  it("are complete, point to a runbook section, and stay quiet on a healthy farm", () => {
    const runbook = readFileSync("docs/runbooks/alarms.md", "utf8");
    for (const a of alarms) {
      expect(a.runbook, a.name).toMatch(/^docs\/runbooks\/alarms\.md#/);
      expect(runbook, a.name).toContain(`<a id="${a.name}"></a>`);
      expect(["critical", "warning"]).toContain(a.severity);
    }
    expect(breachingAlarms(healthy(), alarms)).toEqual([]);
  });

  it("list the same queues and worker roles as the code (Terraform creates one alarm per queue and role)", () => {
    const file = loadAlarms() as unknown as { queues: string[]; roles: string[] };
    expect(file.queues).toEqual([...QUEUE_NAMES]);
    expect(file.roles).toEqual([...WORKER_ROLES]);
  });

  it("emits valid CloudWatch embedded-metric lines for every value", () => {
    const lines = toEmf(healthy()).map((l) => JSON.parse(l));
    for (const line of lines) {
      const spec = line._aws.CloudWatchMetrics[0];
      expect(spec.Namespace).toBe("CreatorFarm");
      for (const d of spec.Dimensions[0]) expect(typeof line[d]).toBe("string");
      for (const m of spec.Metrics) expect(typeof line[m.Name]).toBe("number");
    }
    const metrics = new Set(lines.flatMap((l) => l._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name)));
    for (const a of alarms) expect(metrics.has(a.metric), a.metric).toBe(true);
  });
});

describe("alarm drill: each failure fires its alarm", () => {
  it("detects dead letters, backlog, waiting time, missing workers, stuck jobs, failed publications, budget pauses and expired tokens", async () => {
    const now = new Date();
    // Metrics are read 31 minutes from now (see below); heartbeats are as of then.
    const later = now.getTime() + 31 * 60_000;
    // Live workers for every role except media.
    for (const role of ["generation", "publishing", "scheduler"]) {
      const queue = QUEUE_NAMES.find((q) => q.startsWith(role === "generation" ? "generation" : role === "scheduler" ? "maintenance" : "publishing"))!;
      await redis().hset(`${QUEUE_PREFIX}:workers`, `drill-${role}`, JSON.stringify({ queues: [queue], at: later, pid: 1 }));
    }
    await redis().hset(`${QUEUE_PREFIX}:workers`, "drill-old-media", JSON.stringify({ queues: ["media-processing"], at: later - HEARTBEAT_TTL_MS - 1, pid: 2 }));

    await getQueue("dead-letter").add("generation-image:content.step", { drill: true });
    await getQueue("generation-image").addBulk(Array.from({ length: 201 }, (_, i) => ({ name: "drill", data: { i } })));

    const creator = await makeCreator();
    const provider = await makeProvider();
    await db.generationJob.create({ data: { creatorId: creator.id, providerId: provider.id, kind: "IMAGE", idempotencyKey: `drill:${uid()}`, status: "RUNNING", startedAt: new Date(now.getTime() - 3 * 3_600_000), renderedPrompt: "x" } });
    const account = await makeSocialAccount(creator.id);
    for (let i = 0; i < 4; i++)
      await db.publishingJob.create({ data: { contentItemId: (await makeContent(creator.id)).id, socialAccountId: account.id, platform: "INSTAGRAM", scheduledFor: now, status: "FAILED", idempotencyKey: `drill:${uid()}` } });
    await db.controlSwitch.create({ data: { scope: "CREATOR", targetId: creator.id, paused: true, reason: "Budget limit reached: drill" } });
    await db.socialAccount.update({ where: { id: account.id }, data: { status: "TOKEN_EXPIRED" } });

    // 31 minutes later the queued jobs have waited too long.
    const m = await collectMetrics(new Date(later));
    const fired = breachingAlarms(m, alarms);
    const names = new Set(fired.map((f) => f.alarm));
    expect([...names].sort()).toEqual(["accounts-need-reconnect", "budget-pause-active", "dead-letter-jobs", "oldest-job-waiting", "publishing-failures", "queue-backlog-high", "stuck-jobs", "workers-missing"]);
    expect(fired.find((f) => f.alarm === "workers-missing")!.dims).toEqual({ Role: "media" });
    expect(fired.filter((f) => f.alarm === "queue-backlog-high").map((f) => f.dims)).toEqual([{ Queue: "generation-image" }]);

    // Clean up so later files see a quiet farm.
    await db.controlSwitch.deleteMany({ where: { targetId: creator.id } });
    await db.generationJob.updateMany({ where: { creatorId: creator.id }, data: { status: "FAILED", finishedAt: now } });
    for (const q of ["generation-image", "dead-letter"] as const) await getQueue(q).obliterate({ force: true });
  });
});

describe("tracing", () => {
  it("records a span per job with its outcome", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    await withSpan("job generation-text/content.step", { "job.id": "1" }, async () => "ok");
    await expect(withSpan("job publishing/publish.run", { "job.id": "2" }, async () => Promise.reject(new Error("platform down")))).rejects.toThrow("platform down");
    const [ok, failed] = exporter.getFinishedSpans();
    expect(ok!.name).toBe("job generation-text/content.step");
    expect(ok!.status.code).toBe(1);
    expect(failed!.status).toMatchObject({ code: 2, message: "platform down" });
    expect(failed!.events.map((e) => e.name)).toContain("exception");
    trace.disable();
  });

});
