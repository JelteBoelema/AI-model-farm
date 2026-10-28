// Pure analytics helpers: when to take snapshots, engagement, and the statistics behind insights.
// Insights are predictions from small samples; the numbers here describe uncertainty, they never
// remove it.

/** Snapshot moments after publication (hours). Metrics are cumulative, so later ones supersede earlier. */
export const CHECKPOINT_HOURS = [1, 3, 6, 12, 24, 48, 72, 168, 336, 720] as const;

/** Posts are compared at this age (or the latest snapshot before it). */
export const COMPARE_AT_HOURS = 72;

/** Minimum age before a post counts in comparisons. */
export const MIN_COMPARE_AGE_HOURS = 24;

/** The checkpoint due for a post of this age (null: too young, or collection finished). */
export function dueCheckpoint(publishedAt: Date, now: Date): number | null {
  const age = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (age < CHECKPOINT_HOURS[0]) return null;
  // A checkpoint missed by more than a day (worker down) is skipped rather than recorded late.
  const due = [...CHECKPOINT_HOURS].reverse().find((h) => age >= h);
  if (due === undefined || age - due > Math.max(24, due * 0.5)) return null;
  return due;
}

export interface Counters {
  reach?: bigint | number | null;
  views?: bigint | number | null;
  likes?: bigint | number | null;
  comments?: bigint | number | null;
  shares?: bigint | number | null;
  saves?: bigint | number | null;
}

const n = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Interactions per person reached (falls back to views when reach is not reported); null without either. */
export function engagementRate(c: Counters): number | null {
  const base = n(c.reach) || n(c.views);
  if (base <= 0) return null;
  return (n(c.likes) + n(c.comments) + n(c.shares) + n(c.saves)) / base;
}

export interface GroupStats {
  key: string;
  n: number;
  mean: number;
  sd: number;
}

export function describe(key: string, values: number[]): GroupStats {
  const count = values.length;
  const mean = count ? values.reduce((a, b) => a + b, 0) / count : 0;
  const variance = count > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1) : 0;
  return { key, n: count, mean, sd: Math.sqrt(variance) };
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7).
function normalCdf(z: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Two-sided p-value of Welch's t-test between two groups. The t statistic is mapped through a
 * normal approximation with a small-sample correction; with few posts it is conservative enough
 * for a suggestion, not for a conclusion. Null when either group has fewer than two posts or no spread.
 */
export function welchPValue(a: GroupStats, b: GroupStats): number | null {
  if (a.n < 2 || b.n < 2) return null;
  const se = Math.sqrt(a.sd ** 2 / a.n + b.sd ** 2 / b.n);
  if (se === 0) return null;
  const t = (a.mean - b.mean) / se;
  const df = (a.sd ** 2 / a.n + b.sd ** 2 / b.n) ** 2 / ((a.sd ** 2 / a.n) ** 2 / (a.n - 1) + (b.sd ** 2 / b.n) ** 2 / (b.n - 1));
  // Convert t(df) to an approximately equivalent z (Wallace-type correction).
  const z = Math.abs(t) * (1 - 1 / (4 * df)) / Math.sqrt(1 + t * t / (2 * df));
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

/**
 * Posts per variant to detect a relative lift with 80% power at alpha 0.05 (two-sided), given the
 * observed mean and spread. Rounded up; never below the minimum sample.
 */
export function postsPerVariant(mean: number, sd: number, relativeLift: number, minSample: number): number {
  const delta = Math.abs(mean * relativeLift);
  if (delta === 0 || sd === 0) return minSample;
  const needed = (2 * (1.96 + 0.8416) ** 2 * sd ** 2) / delta ** 2;
  return Math.max(minSample, Math.ceil(needed));
}

export const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Part of the day of a local hour, coarse enough to gather samples. */
export function dayPart(hour: number): string {
  if (hour < 6) return "night (0–6)";
  if (hour < 12) return "morning (6–12)";
  if (hour < 18) return "afternoon (12–18)";
  return "evening (18–24)";
}
