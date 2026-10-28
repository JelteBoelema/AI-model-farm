# Deployment

## Doelarchitectuur (AWS `eu-central-1`, Frankfurt — bevestigd)

| Component | Dienst | Startgrootte (10–50 creators) |
|---|---|---|
| Webapp (dashboard + API) | ECS Fargate achter een Application Load Balancer (HTTPS via ACM, AWS WAF) | 2 taken × 1 vCPU / 2 GB |
| Worker `scheduler` (planning, maintenance) | ECS Fargate service | 1 × 0,5 vCPU / 1 GB — **altijd precies 1–2** |
| Worker `generation` (tekst, beeld, video) | ECS Fargate service, autoscaling op queue-diepte | 1–4 × 1 vCPU / 2 GB |
| Worker `media` (FFmpeg) | ECS Fargate service, autoscaling | 1–3 × 2 vCPU / 4 GB |
| Worker `publishing` (publicatie, analytics) | ECS Fargate service | 1 × 0,5 vCPU / 1 GB |
| Migraties | Eenmalige ECS-taak (`migrate`-image) per release | 0,5 vCPU / 1 GB |
| PostgreSQL | Amazon RDS for PostgreSQL 16, Multi-AZ, encryptie at rest | db.t4g.medium → db.m7g.large |
| Redis | Amazon ElastiCache (Redis OSS 7), `noeviction`, encryptie in transit | cache.t4g.small |
| Object storage | Amazon S3, versiebeheer, SSE, Block Public Access, lifecycle | — |
| Secrets | AWS Secrets Manager | — |
| Logs/metrics/alerts | CloudWatch Logs + Alarms; OTLP-collector sidecar voor traces | — |
| Images | GitHub Container Registry (of ECR) | — |

Netwerk: VPC met private subnets voor taken, RDS en Redis; alleen de ALB is publiek. Uitgaand verkeer naar providers via NAT-gateway. Security groups staan alleen web/workers → RDS (5432) en → Redis (6379) toe.

IAM: aparte task roles.
- `web`:
  - S3 lezen/schrijven op de mediabucket;
  - Secrets Manager lezen op `creatorfarm/<env>/*`;
  - op `…/social/*` ook aanmaken, wijzigen en verwijderen: de OAuth-callback en het ontkoppelen beheren de tokens van gekoppelde accounts.
- `worker`: dezelfde rechten als `web`, maar op `social/*` alleen wijzigen (tokenvernieuwing), niet aanmaken of verwijderen.
- De execution role leest alleen de vier platformsecrets.
- De deployrol is alleen aan te nemen door de GitHub-environment van deze repository (OIDC).

**Infrastructure-as-code**: alles hierboven staat in `infra/terraform/`:
- netwerk;
- RDS, ElastiCache, S3 met replicatie naar `eu-west-1`, KMS, Secrets Manager;
- ECS (services, taken, autoscaling op wachtrij per taak);
- ALB met WAF;
- alarmen en SNS;
- de deployrol.
Applicatie-alarmen komen uit `infra/alarms.json`, dezelfde definities die de alarmtest gebruikt. CI draait `terraform fmt` en `terraform validate` en een Checkov-scan.

## Omgevingsvariabelen

Volledige lijst met uitleg: `.env.example`. Productie-eisen worden bij opstarten gevalideerd (`src/server/env.ts`) — de app start niet als ze ontbreken:

| Variabele | Productie |
|---|---|
| `APP_ENV` | `production` |
| `DATABASE_URL`, `REDIS_URL` | uit Secrets Manager (gebruik `rediss://` voor TLS) |
| `AUTH_SECRET` | ≥ 32 tekens, geen dev-waarde (afgedwongen) |
| `AUTH_URL` | publieke URL, bijv. `https://farm.example.com` |
| `APP_ENCRYPTION_KEY` | 32 bytes base64 |
| `STORAGE_DRIVER` | `s3` (afgedwongen) + `S3_BUCKET`, `S3_REGION` |
| `SECRETS_DRIVER` | `aws` (afgedwongen) |
| `MOCK_MODE` | `false` zodra echte providers geconfigureerd zijn |
| `WORKER_QUEUES` | per worker-service: `scheduler`, `generation`, `media`, `publishing` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optioneel: collector (bijv. ADOT-sidecar `http://localhost:4318`) voor traces naar X-Ray |
| `MFA_REQUIRED_ROLES` | standaard `OWNER,ADMIN` in productie |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | optioneel: single sign-on (Terraform-variabele `oidc`) |
| `RATE_LIMIT_ACTIONS_PER_MINUTE`, `RATE_LIMIT_API_PER_MINUTE` | standaard 120 / 300 |

## Eerste installatie

1. **Terraform-state**: een S3-bucket (versiebeheer aan) en een DynamoDB-tabel voor locks, eenmalig handmatig. Leg die vast in `infra/terraform/backend.hcl`:
   ```hcl
   bucket = "…"
   key = "creator-farm/production.tfstate"
   region = "eu-central-1"
   dynamodb_table = "…"
   encrypt = true
   ```
2. **Certificaat**: ACM-certificaat voor het domein in `eu-central-1`.
3. **GitHub OIDC-provider** in het AWS-account (`token.actions.githubusercontent.com`), eenmalig.
4. **Infrastructuur**:
   ```bash
   cd infra/terraform
   cp production.tfvars.example production.tfvars   # invullen
   terraform init -backend-config=backend.hcl
   terraform plan -var-file=production.tfvars -out plan && terraform apply plan
   ```
   Bevestig daarna de SNS-e-mail voor alarmen.
5. **Secrets vullen.** Terraform maakt ze leeg aan.
   ```bash
   aws secretsmanager put-secret-value --secret-id creatorfarm/prod/auth-secret --secret-string "$(openssl rand -base64 48)"
   aws secretsmanager put-secret-value --secret-id creatorfarm/prod/encryption-key --secret-string "$(openssl rand -base64 32)"
   aws secretsmanager put-secret-value --secret-id creatorfarm/prod/database-url --secret-string "postgresql://creatorfarm:<wachtwoord>@<database_endpoint>:5432/creatorfarm?sslmode=require"
   aws secretsmanager put-secret-value --secret-id creatorfarm/prod/redis-url --secret-string "rediss://<redis_endpoint>:6379"
   ```
   Het databasewachtwoord staat in het door RDS beheerde secret (output `database_master_secret_arn`).
6. **DNS**: het domein naar de output `load_balancer_dns` laten wijzen.
7. **GitHub-variabelen** voor de deploy:
   - `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `ECS_CLUSTER`, `ECS_NETWORK_CONFIG` (outputs);
   - environment `production` met verplichte reviewers;
   - private images in GHCR: een PAT met `read:packages` als secret, met de ARN in `registry_credentials_secret_arn`.
8. **Images en migraties**: push naar `main` → *Release* → *deploy* (migraties via de `creator-farm-migrate`-taak; nooit `migrate reset` of `db push` in productie).
9. **Seed** (eenmalig, vanaf een beheerhost met toegang tot de database):
   ```bash
   DATABASE_URL=… SEED_OWNER_EMAIL=jij@bedrijf.nl SEED_OWNER_PASSWORD='…' SEED_MONTHLY_BUDGET_EUR=500 pnpm db:seed
   ```
   Dit maakt aan:
   - de owner;
   - het providerregister;
   - veilige standaardlimieten (minimale steekproef 30, autopilot uit);
   - de starterprompts.
   Gebruik **niet** `--demo` in productie.
10. **Eerste aanmelding**: de owner stelt tweestapsverificatie in (verplicht) en bewaart de herstelcodes.
11. **Controle**:
    - `GET /api/health` geeft 200;
    - de Workflow Monitor toont vier levende worker-rollen;
    - geen alarmen;
    - de alarmtest uit `docs/runbooks/alarms.md` (`set-alarm-state`) is uitgevoerd.

## Releases

`CI` (lint, typecheck, unit + integratie, e2e, image-builds) → bij succes op `main` publiceert `Release` de images → de `deploy`-job (GitHub environment *production* met verplichte reviewers, OIDC-rol `AWS_DEPLOY_ROLE_ARN`) draait eerst migraties en rolt daarna de services uit. Migraties zijn *expand/contract*: een release voegt eerst toe (kolommen, tabellen), een latere release verwijdert pas wat niet meer gebruikt wordt — zo blijven oude en nieuwe taken tijdens de rollout compatibel.

## Health checks

| Endpoint | Gebruik | Controleert |
|---|---|---|
| `GET /api/health/live` | container-/ALB-liveness | proces draait |
| `GET /api/health` | readiness, uptime-monitor | database, Redis, opslag (200 of 503) |
| worker `:9464/healthz` | container-health | database, Redis, workers draaien |

## Monitoring en alerts

- **Metrics.** De scheduler-worker schrijft elke minuut wachtrij- en farmmetrics in CloudWatch Embedded Metric Format (namespace `CreatorFarm`): wachtrij-achterstand, oudste wachttijd, levende workers per rol, dead letters, vastgelopen jobs, mislukte publicaties, budgetpauzes en accounts die opnieuw gekoppeld moeten worden.
- **Autoscaling.** Workers schalen op wachtrij-achterstand per taak.
- **Alarmen.** `infra/alarms.json` (applicatie) en `infra/terraform/alarms.tf` (ALB 5xx en latentie, gezonde taken, RDS, Redis-geheugen, WAF). Ze gaan naar SNS, en per alarm staat er een runbook in `docs/runbooks/alarms.md`. De alarmdefinities worden in CI getest (`observability.test.ts`).
- **Logs.** JSON naar CloudWatch Logs (30 dagen, KMS). De audittrail staat in de database.
- **Traces.** Elke job is een span en uitgaande provideraanroepen zijn child spans. Dit staat aan zodra `OTEL_EXPORTER_OTLP_ENDPOINT` gezet is (collector → X-Ray).

## Back-ups

| Bron | Maatregel |
|---|---|
| PostgreSQL | RDS automated backups met point-in-time recovery (35 dagen), gerepliceerd naar `eu-west-1` (14 dagen). |
| S3 media | Versiebeheer aan; noncurrent versies 30 dagen; alle objecten gerepliceerd naar `eu-west-1`. |
| Redis | Multi-AZ met snapshots (3 dagen). Redis bevat geen bron-van-waarheid: na verlies worden de wachtrijen herbouwd uit de database (`pnpm queues:rebuild`). |
| Secrets | Secrets Manager met replicatie naar tweede regio. |

## Herstelprocedures

Zie `docs/runbooks/restore.md`: database (PITR), Redis kwijt (`pnpm queues:rebuild`) en media. De herstelproef (`pnpm drill:restore`) en de uitkomsten staan in `docs/runbooks/drills.md`. Overige runbooks: `docs/runbooks/` (incident, alarmen, deploy, sleutels, toegang).

## Lokale ontwikkeling

**Native** (Node 22, PostgreSQL 16, Redis 7):
```bash
cp .env.example .env               # vul AUTH_SECRET en APP_ENCRYPTION_KEY
pnpm install
pnpm db:migrate                     # prisma migrate deploy
SEED_OWNER_PASSWORD='kies-een-wachtwoord' SEED_MONTHLY_BUDGET_EUR=500 pnpm db:seed:demo
pnpm dev                            # http://localhost:3000
pnpm worker                         # in een tweede terminal
```

**Docker Compose** (volledige stack incl. MinIO als S3):
```bash
cp .env.example .env               # vul AUTH_SECRET en APP_ENCRYPTION_KEY
docker compose up --build
docker compose run --rm -e SEED_OWNER_PASSWORD='…' migrate pnpm exec tsx prisma/seed.ts --demo
```
