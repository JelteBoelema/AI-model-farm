// Queue topology. Each queue is consumed by one worker role so that generation, media processing
// and publishing can be scaled independently. Numbers here are defaults; per-provider and
// per-social-account limits are enforced on top of these inside the processors.

import type { BackoffOptions } from "@/lib/backoff";

export const QUEUE_NAMES = [
  "planning",
  "generation-text",
  "generation-image",
  "generation-video",
  "media-processing",
  "publishing",
  "analytics",
  "maintenance",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
export const DEAD_LETTER_QUEUE = "dead-letter";

export interface QueueDefinition {
  description: string;
  workerRole: "generation" | "media" | "publishing" | "scheduler";
  concurrency: number;
  attempts: number;
  backoff: BackoffOptions;
  /** Hard timeout for one attempt; the processor receives an AbortSignal. */
  timeoutMs: number;
  /** A job not finished after this long is flagged as stuck by maintenance. */
  stuckAfterMs: number;
  defaultPriority: number;
}

const minute = 60_000;

export const QUEUES: Record<QueueName, QueueDefinition> = {
  planning: {
    description: "Content planning, ideation and calendar fill",
    workerRole: "scheduler",
    concurrency: 2,
    attempts: 3,
    backoff: { baseMs: 10_000, maxMs: 5 * minute },
    timeoutMs: 5 * minute,
    stuckAfterMs: 15 * minute,
    defaultPriority: 5,
  },
  "generation-text": {
    description: "LLM calls: scripts, captions, prompts, QC reasoning",
    workerRole: "generation",
    concurrency: 10,
    attempts: 3,
    backoff: { baseMs: 5_000, maxMs: 2 * minute },
    timeoutMs: 3 * minute,
    stuckAfterMs: 10 * minute,
    defaultPriority: 5,
  },
  "generation-image": {
    description: "Image generation and variations",
    workerRole: "generation",
    concurrency: 5,
    attempts: 3,
    backoff: { baseMs: 15_000, maxMs: 5 * minute },
    timeoutMs: 10 * minute,
    stuckAfterMs: 20 * minute,
    defaultPriority: 5,
  },
  "generation-video": {
    description: "Video, speech and lip-sync generation (long-running, provider-polled)",
    workerRole: "generation",
    concurrency: 2,
    attempts: 2,
    backoff: { baseMs: 60_000, maxMs: 15 * minute },
    timeoutMs: 45 * minute,
    stuckAfterMs: 90 * minute,
    defaultPriority: 5,
  },
  "media-processing": {
    description: "FFmpeg conversion, assembly, subtitles, technical QC",
    workerRole: "media",
    concurrency: 2,
    attempts: 3,
    backoff: { baseMs: 10_000, maxMs: 5 * minute },
    timeoutMs: 20 * minute,
    stuckAfterMs: 40 * minute,
    defaultPriority: 5,
  },
  publishing: {
    description: "Social publishing; retries verify remote status before re-submitting",
    workerRole: "publishing",
    concurrency: 3,
    attempts: 4,
    backoff: { baseMs: 30_000, maxMs: 30 * minute },
    timeoutMs: 10 * minute,
    stuckAfterMs: 20 * minute,
    defaultPriority: 2,
  },
  analytics: {
    description: "Fetching platform statistics snapshots",
    workerRole: "publishing",
    concurrency: 2,
    attempts: 3,
    backoff: { baseMs: 60_000, maxMs: 30 * minute },
    timeoutMs: 5 * minute,
    stuckAfterMs: 15 * minute,
    defaultPriority: 8,
  },
  maintenance: {
    description: "Reservation expiry, stuck-job detection, housekeeping",
    workerRole: "scheduler",
    concurrency: 1,
    attempts: 3,
    backoff: { baseMs: 5_000, maxMs: minute },
    timeoutMs: 2 * minute,
    stuckAfterMs: 10 * minute,
    defaultPriority: 1,
  },
};

export const WORKER_ROLES = ["generation", "media", "publishing", "scheduler"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export function queuesForRole(role: WorkerRole): QueueName[] {
  return QUEUE_NAMES.filter((q) => QUEUES[q].workerRole === role);
}

/** Parse WORKER_QUEUES ("generation,media" roles or explicit queue names); empty means all. */
export function resolveWorkerQueues(spec: string | undefined): QueueName[] {
  if (!spec || spec.trim() === "" || spec.trim() === "all") return [...QUEUE_NAMES];
  const out = new Set<QueueName>();
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if ((WORKER_ROLES as readonly string[]).includes(raw)) queuesForRole(raw as WorkerRole).forEach((q) => out.add(q));
    else if ((QUEUE_NAMES as readonly string[]).includes(raw)) out.add(raw as QueueName);
    else throw new Error(`Unknown worker queue or role: ${raw}`);
  }
  return [...out];
}
