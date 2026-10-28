// Fixed-window rate limits in Redis, shared by every web instance. The WAF limits per address at
// the edge; these limits protect the application behind it (per user for actions, per client
// address for API routes).

import { DomainError } from "./errors";
import { redis } from "./redis";

export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds} seconds.`);
    this.name = "RateLimitedError";
  }
}

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function hit(bucket: string, id: string, limit: number, windowSeconds = 60, now = Date.now()): Promise<RateResult> {
  const window = Math.floor(now / 1000 / windowSeconds);
  const key = `cf:rl:${bucket}:${id}:${window}`;
  const [[, count]] = (await redis().multi().incr(key).expire(key, windowSeconds + 5).exec()) as [[unknown, number]];
  const retryAfterSeconds = (window + 1) * windowSeconds - Math.floor(now / 1000);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}

export async function enforce(bucket: string, id: string, limit: number, windowSeconds = 60) {
  const r = await hit(bucket, id, limit, windowSeconds);
  if (!r.allowed) throw new RateLimitedError(r.retryAfterSeconds);
}

/** Client address as the load balancer reports it (first X-Forwarded-For entry). */
export function clientAddress(headers: Headers) {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function tooManyRequests(r: RateResult) {
  return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(r.retryAfterSeconds) } });
}
