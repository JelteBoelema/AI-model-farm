# Runbook: alarms

Every alarm in `infra/alarms.json` (custom metrics in namespace `CreatorFarm`, published every minute by the scheduler worker) and the AWS infrastructure alarms in `infra/terraform/alarms.tf` notify the SNS topic `creator-farm-alarms`. Critical alarms page whoever is on call; warnings go to email.

First steps for any alarm:
1. Open the dashboard (**Workflow Monitor**) and **Settings → Audit log** around the alarm time.
2. Check CloudWatch Logs `/creator-farm/<service>` for the same minutes. The log lines carry `queue`, `jobId` and `err`.
3. When in doubt, pause: **Settings → Controls → All generation / All publishing**. Pausing is always safe. Resuming needs an admin.

<a id="dead-letter-jobs"></a>
## dead-letter-jobs (critical)
A job failed all its attempts.
- On the **Workflow Monitor → Dead letters** card, the job name and `failedReason` show what failed.
- Content steps: the item shows *Resume* with the failed step. Fix the cause (provider key, price, quota), then press *Resume*. Never re-run blindly: paid calls are idempotent per attempt, and the ledger shows what was charged.
- Publishing: the publication is `FAILED` or `NEEDS_MANUAL_ACTION`. Check the platform first (was it posted?), then *Retry*, or *Mark as published* with the URL.
- Once handled, remove the job from the dead-letter queue (Workflow Monitor), so the alarm returns to OK.

<a id="queue-backlog-high"></a>
## queue-backlog-high (warning)
More than 200 jobs have been waiting for 15 minutes on one queue.
- Is autoscaling at its maximum? ECS → service → *Desired tasks*. Raise `max_capacity` in Terraform if the budget allows.
- Is a provider slow, or limited by its rate limit? AI Providers shows the status. The queue drains by itself when the provider recovers.
- A runaway source (for example a large bulk batch): pause the creator or campaign.

<a id="oldest-job-waiting"></a>
## oldest-job-waiting (warning)
A job has waited more than 30 minutes.
- Usually comes with *workers-missing* or *queue-backlog-high*; handle those first.
- On its own: the queue may be paused (Workflow Monitor shows "paused"), or a worker is stuck. Restart that worker service with `aws ecs update-service --force-new-deployment`. Active jobs are retried through stalled-job detection.

<a id="workers-missing"></a>
## workers-missing (critical)
No live worker for a role for 3 minutes. This alarm also fires when metrics stop arriving altogether (the scheduler publishes them).
- ECS → service of that role: are tasks crashing? Look at *Stopped tasks → Stopped reason* and the logs.
- Typical causes: the database or Redis cannot be reached (check their alarms), a configuration error after a deploy (roll back, see `deploy.md`), or out of memory (raise the task memory).

<a id="stuck-jobs"></a>
## stuck-jobs (warning)
Generation jobs are running far beyond their queue's limit.
- Maintenance marks them `FAILED` within 2 minutes, and the item shows *Resume*. If the alarm persists, maintenance itself is not running; check *workers-missing* (scheduler).
- Long-running provider jobs (video) are polled, not counted here.

<a id="publishing-failures"></a>
## publishing-failures (critical)
More than 3 publications failed in the last hour.
- Same platform? Check its status page and Social Accounts (token, permissions).
- Pause all publishing until the cause is clear. Scheduled posts wait and go out after the resume. Nothing is published twice: `AWAITING_CONFIRMATION` posts are checked with the platform first.

<a id="budget-pause-active"></a>
## budget-pause-active (warning)
A budget reached its limit and paused its scope. This is intended behaviour.
- **Costs & Budgets** shows which budget it was. Raising the limit needs the owner (an admin sends a request under Settings → Approvals). An admin resumes the switch afterwards.
- If the spend is unexpected, read the ledger first (per provider and per item), before raising anything.

<a id="accounts-need-reconnect"></a>
## accounts-need-reconnect (warning)
A social account's token expired or was revoked.
- **Social Accounts → Reconnect.** Publications for that account wait (`NEEDS_MANUAL_ACTION`) and can be retried after reconnecting.

## Infrastructure alarms (Terraform)
| Alarm | Meaning | First action |
|---|---|---|
| `alb-5xx` | More than 1% 5xx from the web app | Logs `/creator-farm/web`; roll back the last deploy if it is new |
| `alb-latency-p95` | p95 above 2 s for 10 minutes | RDS CPU and connections; slow queries in Performance Insights |
| `rds-cpu` / `rds-free-storage` / `rds-connections` | Database under pressure | Scale the instance class or storage (Terraform); check for runaway jobs |
| `redis-memory` | Redis above 80% memory | Completed and failed job retention; scale the node type. Never set `allkeys-*` eviction |
| `waf-blocked-spike` | WAF blocks suddenly rising | Usually an attack or scanner, and blocking is working. Check the sampled requests for false positives |

## Testing alarms
- **In code**: `tests/integration/observability.test.ts` injects every failure and checks that exactly the matching alarm fires, with the right dimension.
- **In AWS, after every infrastructure change and at least quarterly**:
  ```sh
  aws cloudwatch set-alarm-state --alarm-name creator-farm-dead-letter-jobs \
    --state-value ALARM --state-reason "alarm drill $(date -u +%F)"
  ```
  Confirm the notification arrives, then set the state back to `OK`. Record the drill in `docs/runbooks/drills.md`.
