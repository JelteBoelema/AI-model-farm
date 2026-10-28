// Worker entrypoint. One image, several deployments: WORKER_QUEUES selects the role
// ("generation", "media", "publishing", "scheduler") or explicit queue names.

import http from "node:http";
import type { Worker } from "bullmq";
import { env } from "@/server/env";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { redis } from "@/server/redis";
import { QUEUES, resolveWorkerQueues, type QueueName } from "@/server/queue/definitions";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { createWorker, removeHeartbeat, writeHeartbeat, type ProcessorMap } from "@/server/queue/worker";
import { MAINTENANCE_SCHEDULES, maintenanceProcessors } from "./processors/maintenance";
import { promptTestProcessors } from "./processors/prompt-tests";

// Processors are registered per phase. Queues without processors are left untouched so jobs wait
// safely instead of failing; the Workflow Monitor shows them as "no consumer".
const PROCESSORS: Partial<Record<QueueName, ProcessorMap>> = {
  maintenance: maintenanceProcessors,
  "generation-text": promptTestProcessors,
  "generation-image": promptTestProcessors,
};

async function main() {
  const config = env();
  const queues = resolveWorkerQueues(config.WORKER_QUEUES);
  const workers: Worker[] = [];
  const consuming: QueueName[] = [];

  for (const name of queues) {
    const processors = PROCESSORS[name];
    if (!processors) {
      logger.info({ queue: name }, "no processors registered yet; not consuming");
      continue;
    }
    workers.push(createWorker(name, processors));
    consuming.push(name);
  }

  if (consuming.includes("maintenance")) {
    for (const s of MAINTENANCE_SCHEDULES) {
      await getQueue("maintenance").upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.jobName, data: {} });
    }
  }

  await writeHeartbeat(consuming);
  const heartbeat = setInterval(() => void writeHeartbeat(consuming).catch(() => undefined), 15_000);

  const health = http.createServer(async (req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    try {
      await Promise.all([db.$queryRaw`SELECT 1`, redis().ping()]);
      const running = workers.every((w) => w.isRunning());
      res.writeHead(running ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: running ? "ok" : "degraded", queues: consuming }));
    } catch {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ status: "unavailable" }));
    }
  });
  health.listen(config.WORKER_HEALTH_PORT);

  logger.info({ queues: consuming, concurrency: consuming.map((q) => QUEUES[q].concurrency) }, "workers started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down workers (finishing active jobs)");
    clearInterval(heartbeat);
    health.close();
    await Promise.all(workers.map((w) => w.close()));
    await removeHeartbeat().catch(() => undefined);
    await closeQueues();
    await db.$disconnect();
    redis().disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "worker failed to start");
  process.exit(1);
});
