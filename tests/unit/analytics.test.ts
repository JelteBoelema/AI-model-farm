import { describe as group, expect, it } from "vitest";
import { dayPart, describe, dueCheckpoint, engagementRate, postsPerVariant, welchPValue } from "@/lib/analytics";

const H = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2026, 9, 1) + hours * H);

group("snapshot checkpoints", () => {
  it("collects at 1 h, 3 h, 6 h … 30 days after publication", () => {
    const published = at(0);
    expect(dueCheckpoint(published, at(0.5))).toBeNull();
    expect(dueCheckpoint(published, at(1.2))).toBe(1);
    expect(dueCheckpoint(published, at(4))).toBe(3);
    expect(dueCheckpoint(published, at(30))).toBe(24);
    expect(dueCheckpoint(published, at(170))).toBe(168);
    expect(dueCheckpoint(published, at(730))).toBe(720);
  });

  it("skips a checkpoint missed by more than a day instead of recording it late, and stops after 30 days", () => {
    expect(dueCheckpoint(at(0), at(1 + 26))).toBe(24); // 27 h: the 24 h checkpoint is due
    expect(dueCheckpoint(at(0), at(720 + 400))).toBeNull();
  });
});

group("engagement", () => {
  it("is interactions per person reached, falling back to views", () => {
    expect(engagementRate({ reach: 1000n, likes: 40n, comments: 5n, shares: 3n, saves: 2n })).toBeCloseTo(0.05);
    expect(engagementRate({ views: 500, likes: 25 })).toBeCloseTo(0.05);
    expect(engagementRate({ likes: 10 })).toBeNull();
  });

  it("groups hours into parts of the day", () => {
    expect([3, 9, 13, 20].map(dayPart)).toEqual(["night (0–6)", "morning (6–12)", "afternoon (12–18)", "evening (18–24)"]);
  });
});

group("statistics behind insights", () => {
  const a = describe("a", [0.08, 0.09, 0.1, 0.085, 0.095, 0.09, 0.1, 0.088]);
  const b = describe("b", [0.05, 0.055, 0.06, 0.052, 0.058, 0.05, 0.061, 0.054]);
  const noisy = describe("c", [0.02, 0.15, 0.04, 0.12]);

  it("finds a clear difference significant and a noisy one not", () => {
    expect(welchPValue(a, b)!).toBeLessThan(0.001);
    expect(welchPValue(noisy, b)!).toBeGreaterThan(0.05);
  });

  it("needs at least two posts per group", () => {
    expect(welchPValue(describe("x", [0.1]), b)).toBeNull();
  });

  it("sizes an experiment from the spread and never below the minimum sample", () => {
    expect(postsPerVariant(0.05, 0.02, 0.2, 10)).toBe(Math.ceil((2 * (1.96 + 0.8416) ** 2 * 0.02 ** 2) / 0.01 ** 2));
    expect(postsPerVariant(0.05, 0.001, 0.5, 30)).toBe(30);
  });
});
