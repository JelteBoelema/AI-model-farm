import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";

const globalForRedis = globalThis as unknown as { redis?: Redis };

/** Options BullMQ requires for blocking worker connections. */
export const bullConnectionOptions: RedisOptions = { maxRetriesPerRequest: null, enableReadyCheck: true };

export function createRedis(options: RedisOptions = {}): Redis {
  return new Redis(env().REDIS_URL, { lazyConnect: false, ...options });
}

/** Shared connection for short commands (rate limits, heartbeats, queue stats). */
export function redis(): Redis {
  globalForRedis.redis ??= createRedis({ maxRetriesPerRequest: 2 });
  return globalForRedis.redis;
}
