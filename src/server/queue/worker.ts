import os from "node:os";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { computeBackoffMs } from "@/lib/backoff";
import { logger } from "../logger";
import { bullConnectionOptions, createRedis, redis } from "../redis";
import { DEAD_LETTER_QUEUE, QUEUES, type QueueName } from "./definitions";
import { getQueue, QUEUE_PREFIX } from "./queues";

export type Processor<T = unknown> = (job: Job<T>, signal: AbortSignal) => Promise<unknown>;
export type ProcessorMap = Record<string, Processor<never>>;

export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`Job exceeded timeout of ${ms}ms`);
    this.name = "JobTimeoutError";
  }
}

export const WORKER_ID = `${os.hostname()}:${process.pid}`;
const HEARTBEAT_KEY = `${QUEUE_PREFIX}:workers`;
export const HEARTBEAT_TTL_MS = 60_000;

export async function runWithTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createWorker(name: QueueName, processors: ProcessorMap): Worker {
  const def = QUEUES[name];
  const worker = new Worker(
    name,
    async (job) => {
      const handler = processors[job.name] as Processor | undefined;
      if (!handler) throw new UnrecoverableError(`No processor for job "${job.name}" on queue "${name}"`);
      return runWithTimeout(def.timeoutMs, (signal) => handler(job, signal));
    },
    {
      connection: createRedis(bullConnectionOptions),
      prefix: QUEUE_PREFIX,
      concurrency: def.concurrency,
      settings: { backoffStrategy: (attemptsMade: number) => computeBackoffMs(attemptsMade, def.backoff) },
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const exhausted = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn({ queue: name, jobId: job.id, jobName: job.name, attempt: job.attemptsMade, exhausted, err: err.message }, "job failed");
    if (!exhausted) return;
    try {
      await getQueue(DEAD_LETTER_QUEUE).add(
        `${name}:${job.name}`,
        {
          queue: name,
          jobId: job.id,
          jobName: job.name,
          data: job.data,
          failedReason: err.message,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        },
        { jobId: `${name}_${job.id}` },
      );
    } catch (dlqErr) {
      logger.error({ queue: name, jobId: job.id, err: (dlqErr as Error).message }, "failed to dead-letter job");
    }
  });
  worker.on("stalled", (jobId) => logger.warn({ queue: name, jobId }, "job stalled; will be retried by BullMQ"));
  worker.on("error", (err) => logger.error({ queue: name, err: err.message }, "worker error"));
  return worker;
}

export async function writeHeartbeat(queues: string[]): Promise<void> {
  await redis().hset(HEARTBEAT_KEY, WORKER_ID, JSON.stringify({ queues, at: Date.now(), pid: process.pid }));
}

export async function removeHeartbeat(): Promise<void> {
  await redis().hdel(HEARTBEAT_KEY, WORKER_ID);
}

export interface WorkerHeartbeat {
  id: string;
  queues: string[];
  at: number;
  alive: boolean;
}

export async function listHeartbeats(now = Date.now()): Promise<WorkerHeartbeat[]> {
  const raw = await redis().hgetall(HEARTBEAT_KEY);
  return Object.entries(raw)
    .map(([id, json]) => {
      try {
        const v = JSON.parse(json) as { queues: string[]; at: number };
        return { id, queues: v.queues, at: v.at, alive: now - v.at < HEARTBEAT_TTL_MS };
      } catch {
        return null;
      }
    })
    .filter((v): v is WorkerHeartbeat => v !== null)
    .sort((a, b) => b.at - a.at);
}
