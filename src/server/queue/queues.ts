import { Queue, type JobsOptions } from "bullmq";
import { createRedis, bullConnectionOptions } from "../redis";
import { DEAD_LETTER_QUEUE, QUEUE_NAMES, QUEUES, type QueueName } from "./definitions";

export const QUEUE_PREFIX = process.env.QUEUE_PREFIX ?? "cf";

const globalForQueues = globalThis as unknown as { queues?: Map<string, Queue> };
const queues = (globalForQueues.queues ??= new Map());

let sharedConnection: ReturnType<typeof createRedis> | undefined;
function connection() {
  sharedConnection ??= createRedis(bullConnectionOptions);
  return sharedConnection;
}

export function defaultJobOptions(name: QueueName): JobsOptions {
  const def = QUEUES[name];
  return {
    attempts: def.attempts,
    // "jitter" is resolved by the worker's backoffStrategy (full-jitter exponential).
    backoff: { type: "jitter" },
    priority: def.defaultPriority,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  };
}

export function getQueue(name: QueueName | typeof DEAD_LETTER_QUEUE): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: connection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: name === DEAD_LETTER_QUEUE ? { removeOnComplete: false, removeOnFail: false } : defaultJobOptions(name),
    });
    queues.set(name, q);
  }
  return q;
}

/**
 * Enqueue with a deterministic job id derived from a business idempotency key, so that the same
 * logical step can never be queued twice while a previous copy still exists.
 */
export async function enqueue<T extends object>(
  name: QueueName,
  jobName: string,
  data: T,
  opts: { idempotencyKey: string } & Omit<JobsOptions, "jobId">,
) {
  const { idempotencyKey, ...rest } = opts;
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(idempotencyKey)) throw new Error("Invalid idempotency key");
  // BullMQ forbids ":" in custom ids. "~" is outside the allowed key charset, so the mapping is collision-free.
  const jobId = idempotencyKey.replaceAll(":", "~");
  return getQueue(name).add(jobName, data, { ...rest, jobId });
}

export interface QueueStats {
  name: string;
  counts: Record<"waiting" | "active" | "delayed" | "failed" | "completed" | "paused" | "prioritized", number>;
  isPaused: boolean;
}

export async function getQueueStats(): Promise<QueueStats[]> {
  const names = [...QUEUE_NAMES, DEAD_LETTER_QUEUE] as const;
  return Promise.all(
    names.map(async (name) => {
      const q = getQueue(name);
      const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused", "prioritized");
      return { name, counts: counts as QueueStats["counts"], isPaused: await q.isPaused() };
    }),
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => undefined);
    sharedConnection = undefined;
  }
}
