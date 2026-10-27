import { describe, expect, it } from "vitest";
import { QUEUE_NAMES, QUEUES, resolveWorkerQueues } from "@/server/queue/definitions";
import { JobTimeoutError, runWithTimeout } from "@/server/queue/worker";

describe("queue topology", () => {
  it("resolves roles to queues", () => {
    expect(resolveWorkerQueues("generation").sort()).toEqual(["generation-image", "generation-text", "generation-video"]);
    expect(resolveWorkerQueues("publishing,maintenance").sort()).toEqual(["analytics", "maintenance", "publishing"]);
    expect(resolveWorkerQueues(undefined)).toEqual([...QUEUE_NAMES]);
    expect(() => resolveWorkerQueues("nonsense")).toThrow();
  });

  it("has sane limits for every queue", () => {
    for (const name of QUEUE_NAMES) {
      const q = QUEUES[name];
      expect(q.attempts).toBeGreaterThanOrEqual(1);
      expect(q.attempts).toBeLessThanOrEqual(10);
      expect(q.stuckAfterMs).toBeGreaterThan(q.timeoutMs);
      expect(q.backoff.maxMs).toBeGreaterThanOrEqual(q.backoff.baseMs);
    }
  });

  it("aborts work that exceeds the timeout", async () => {
    let aborted = false;
    await expect(
      runWithTimeout(30, (signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(resolve, 500); })),
    ).rejects.toBeInstanceOf(JobTimeoutError);
    expect(aborted).toBe(true);
    await expect(runWithTimeout(500, async () => 42)).resolves.toBe(42);
  });
});
