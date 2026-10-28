# Runbook: deploy and roll back

## Normal release
1. A pull request is merged into `main` after green CI:
   - lint and types;
   - unit and integration tests;
   - e2e;
   - image builds with a vulnerability scan;
   - dependency and secret scans;
   - Terraform validation;
   - CodeQL.
2. **Release** builds and pushes the `web`, `worker` and `migrate` images, tagged with the commit SHA.
3. The **deploy** job waits for approval (GitHub environment `production`), then:
   - runs migrations as a one-off task (`creator-farm-migrate`);
   - rolls out every service (`force-new-deployment`).
   ECS replaces tasks one by one. A deployment that fails health checks is rolled back automatically (deployment circuit breaker). The scheduler is replaced stop-then-start, so it never runs twice.
4. Check:
   - `GET /api/health` returns 200;
   - the Workflow Monitor shows four live worker roles;
   - no alarms.

Migrations are *expand/contract*: a release only adds things (columns, tables, values); removal follows in a later release. Old and new tasks can therefore run side by side during a rollout, and a rollback never needs a down-migration.

## Roll back
- **Application**: re-run the deploy with the previous image tag. In the Actions tab, open *Release*, choose *Run workflow*, and pick the previous commit. Or use `aws ecs update-service --task-definition <previous revision>` per service.
- **Migration**: never `migrate reset`. If a migration is wrong, fix it forward with a new migration. If data was damaged, see `restore.md`.

## Infrastructure changes
```sh
cd infra/terraform
terraform init -backend-config=backend.hcl     # S3 state bucket + DynamoDB lock, per environment
terraform plan -var-file=production.tfvars -out plan
terraform apply plan
```
- First apply on staging, with the same plan.
- Changes to WAF rules: run them in `count` mode first and read the sampled requests, then switch to `block`.
- After changes to alarms: run the alarm drill (`alarms.md`, testing alarms).

## First installation
See `docs/deployment.md` (Terraform, secrets, DNS, seed).
