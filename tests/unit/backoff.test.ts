import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "@/lib/backoff";

const opts = { baseMs: 1000, maxMs: 30_000 };

describe("backoff with full jitter", () => {
  it("grows exponentially up to the cap", () => {
    expect(computeBackoffMs(1, opts, () => 1)).toBe(1000);
    expect(computeBackoffMs(3, opts, () => 1)).toBe(4000);
    expect(computeBackoffMs(20, opts, () => 1)).toBe(30_000);
  });

  it("never drops below the minimum", () => {
    expect(computeBackoffMs(5, opts, () => 0)).toBe(500);
    expect(computeBackoffMs(5, { ...opts, minMs: 2000 }, () => 0)).toBe(2000);
  });

  it("spreads retries across the window", () => {
    const values = new Set(Array.from({ length: 50 }, () => computeBackoffMs(4, opts)));
    expect(values.size).toBeGreaterThan(10);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(8000);
    }
  });
});
