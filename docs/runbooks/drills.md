# Drill log

Every exercise with date, environment, result and follow-ups. Newest first.

## 28-10-2026: load test at target size (local, phase 10)

`pnpm build && pnpm test:load --web --keep`. Environment: 4 vCPU and 16 GB. Postgres, Redis, the workers, one web process and the load generator all run on the same machine, in mock mode (nothing billed or published).

**Target load**:
- 50 creators produce, approve and publish a full day: 6 posts each, 300 in total;
- statistics are collected for every post;
- meanwhile 10 people use the dashboard at the same time, about one click per second each, on **one** web process (production runs two).

| Part | Result |
|---|---|
| Production (300 items: brief → shot list → caption → image → QC) | **300/300 ready**, 0 failed, in 63 s (≈ 290 items/min) |
| Publishing (300 approved → mock platform) | **300/300 published**, 300 posts on the platform (no duplicates or losses), 12 s |
| Statistics (50 accounts) | 300 post snapshots + 50 account snapshots, 0 problems, 0.6 s |
| Dead letters / failed jobs | 0 / 0 |
| Dashboard, 10 users, 60 s | 482 requests, **0 errors**, p50 171 ms, **p95 745 ms** (target < 1,500 ms), p99 872 ms. Slowest pages p95: calendar 941 ms, content 826 ms |
| Database after the day | 5,491 rows in 30 tables |

**Result: passed** (no errors at the target load).

**Notes**:
- The brief step has p95 ≈ 44 s. That is intended: 1,200 text calls in a minute exceed the provider limit (600/min), so steps wait for the next window.
- *Stress*: with 25 users clicking without a pause, there are still 0 errors in 1,407 requests, but p95 is 2.3 s on one process (CPU-bound at about 14 req/s on this machine). For more than ~10 simultaneous heavy users, run more web tasks (Terraform `web_desired_count`).

**Defect found and fixed**: in an earlier run, 146 of 300 items stopped. When our own per-provider request limit was reached, steps failed instead of waiting. Now they wait for the next minute window without using an attempt (security review F1). After the fix: 300/300.

**Follow-ups**:
- Repeat on staging in AWS, with 2 web tasks and real network latency.
- The calendar is the heaviest page; candidate for optimisation as the number of posts grows.

## 28-10-2026: restore drill (local, phase 10)

`pnpm drill:restore --schema load_…` on the data from the load test above.

| Step | Result |
|---|---|
| Backup (`pg_dump`, custom format) | 0.6 MB in 0.3 s |
| Restore into a new, empty database | 0.5 s |
| Row counts per table (30 tables, 5,491 rows) | identical |
| Constraints (101), triggers (7), indexes (96), applied migrations | identical |
| Cost-ledger total, fingerprints of the audit trail, publications and media | identical (the ledger is empty: mock mode books nothing) |
| Audit log append-only after the restore | yes (UPDATE refused by the trigger) |
| `prisma migrate status` against the restored database | up to date |
| Media checksums (25 sampled) | 25/25 correct |
| Redis lost: rebuild the queues from the restored database | 8 schedules back; no work was in flight. The in-flight cases are covered by `tests/integration/rebuild.test.ts` |
| Total, backup to rebuilt queues | ≈ 9 s, of which the checks take most |

**Result: passed.** Follow-up: run the RDS point-in-time variant on staging (`restore.md`) and record the measured time here. Data volume grows by about 5,500 rows per day at the target load, so restore time stays well within the 1-hour RTO.

## 28-10-2026: alarm drill (code, phase 10)

`tests/integration/observability.test.ts` injects every failure. Exactly the matching alarm fires, with the right dimension: dead letters; backlog on `generation-image`; a job waiting > 30 min; missing `media` worker; stuck job; 4 failed publications; budget pause; account that must be reconnected. On a healthy farm, no alarm fires. **Passed.** Follow-up: the AWS drill with `set-alarm-state` after the first deploy (`alarms.md`).
