# Runbook: restore

The database is the only source of truth. Redis holds queues that can be rebuilt; media live in versioned S3 with a copy in the second region.

Targets (production): **RPO ≤ 5 minutes** (RDS point-in-time recovery), **RTO ≤ 1 hour** for the database plus queues. The drill (below) measures the data part for the current volume.

## Database: point-in-time restore (RDS)
1. Pause **All generation** and **All publishing** (Settings → Controls), or scale the workers to 0:
   `aws ecs update-service --cluster creator-farm-production --service creator-farm-worker-<role> --desired-count 0`.
2. RDS → *Restore to point in time* → new instance `creator-farm-production-restore-<date>`. Use the same subnet group, security group, parameter group and KMS key (Terraform outputs). If the region is unavailable, restore from the replicated automated backups in `eu-west-1`.
3. **Verify** on the new instance (same checks as `scripts/restore-drill.ts`):
   - row counts of `cost_ledger`, `audit_logs`, `publishing_jobs`, `content_items`;
   - `SELECT max(occurred_at) FROM audit_logs`, which should be just before the restore point;
   - `pnpm exec prisma migrate status` with the new URL reports "up to date";
   - trying an `UPDATE` on `audit_logs` fails (append-only trigger present).
4. Point `creatorfarm/production/database-url` at the new instance. Then `aws ecs update-service --force-new-deployment` for web and every worker.
5. **Before resuming publishing**: on the Workflow Monitor, check publications in `PUBLISHING` or `AWAITING_CONFIRMATION`. The worker verifies them with the platform; do not re-send by hand.
6. Resume generation, then publishing, with the incident number in the reason.
7. Later: rename the old instance or take a final snapshot and delete it; import the new one into Terraform (`terraform import aws_db_instance.main <id>`), or restore under the original name.

## Redis lost
1. New node or replication group (`terraform apply` recreates it); point `redis-url` at it if the endpoint changed.
2. Restart the workers, then rebuild the queues from the database:
   `pnpm queues:rebuild` (from a host with access, with `DATABASE_URL` and `REDIS_URL`), or run it as a one-off task with the worker image:
   `aws ecs run-task … --overrides '{"containerOverrides":[{"name":"worker","command":["node","dist/worker/rebuild.mjs"]}]}'`.
3. What the rebuild does:
   - maintenance schedules come back;
   - waiting content steps are queued again;
   - polls of long-running provider jobs resume;
   - queued publications are queued again;
   - publications that were being sent are verified with the platform first.
   - A content step that was **running** is never re-run blindly: the item stops at that step. Check the cost ledger for that job, then press *Resume*.

## Media object missing or overwritten
S3 versioning keeps every version for 30 days: restore the previous version (`aws s3api list-object-versions`, then copy it back). The checksum in `media_assets.checksum_sha256` confirms the right version. If the source bucket is lost: the replica in `eu-west-1` (`creator-farm-production-media-dr-…`).

## Drill (every quarter, and after schema-heavy releases)
Locally or on staging:
```sh
pnpm build && pnpm test:load --keep             # realistic data: 50 creators, a full day
pnpm drill:restore                              # backup → new database → verify → rebuild queues
```
The drill fails unless all of the following hold:
- every table has the same number of rows;
- constraints, triggers, indexes and migrations are identical;
- the cost-ledger total and the fingerprints of the audit trail, publications and media match;
- the audit log is still append-only;
- `prisma migrate status` reports up to date;
- media checksums match;
- the queues are rebuilt.

Record the result and timings in `drills.md`. On AWS, run the RDS steps above against staging and record the measured time.
