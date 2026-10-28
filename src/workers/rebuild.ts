// Rebuilds the job queues from the database after Redis was lost (see docs/runbooks/restore.md).
// The database is the source of truth; every job is re-added with its idempotency key.

import { recordAudit, SYSTEM_ACTOR } from "@/server/audit";
import { getQueue } from "@/server/queue/queues";
import { requeueContentJobs } from "@/server/services/content-pipeline";
import { requeuePublishing } from "@/server/services/publishing";
import { MAINTENANCE_SCHEDULES } from "./processors/maintenance";

export async function rebuildQueues(now = new Date()) {
  for (const s of MAINTENANCE_SCHEDULES) await getQueue("maintenance").upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.jobName, data: {} });
  const content = await requeueContentJobs(now);
  const publishing = await requeuePublishing(now);
  const report = { schedules: MAINTENANCE_SCHEDULES.length, content, publishing };
  await recordAudit(SYSTEM_ACTOR, { action: "queues.rebuilt", metadata: report });
  return report;
}
