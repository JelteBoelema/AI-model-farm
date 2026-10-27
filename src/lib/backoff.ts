// Exponential backoff with "full jitter": delay = random(0, min(cap, base * 2^(attempt-1))).
// Full jitter spreads retries of many failed jobs so they do not hit a provider in lockstep.

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Lower bound so a retry never fires immediately. */
  minMs?: number;
}

export function computeBackoffMs(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** (n - 1));
  const min = Math.min(opts.minMs ?? Math.floor(opts.baseMs / 2), ceiling);
  return Math.round(min + random() * (ceiling - min));
}
