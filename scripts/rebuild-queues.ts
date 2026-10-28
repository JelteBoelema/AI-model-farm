// Usage: pnpm queues:rebuild   (with DATABASE_URL and REDIS_URL of the environment)
import { closeQueues } from "../src/server/queue/queues";
import { db } from "../src/server/db";
import { redis } from "../src/server/redis";
import { rebuildQueues } from "../src/workers/rebuild";

rebuildQueues()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    redis().disconnect();
    await db.$disconnect();
  });
