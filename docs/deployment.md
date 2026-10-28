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

IAM: aparte task roles. De execution role leest alleen de platformsecrets.
- `web`:
  - S3 lezen/schrijven op de mediabucket;
  - Secrets Manager lezen op `creatorfarm/prod/*`;
  - op `creatorfarm/prod/social/*` ook aanmaken, wijzigen en verwijderen: de OAuth-callback en het ontkoppelen beheren de tokens van gekoppelde accounts.
- `worker`: dezelfde rechten als `web`, maar op `social/*` alleen lezen en wijzigen (tokenvernieuwing), niet verwijderen.
- Zie `infra/aws/iam-social-secrets.json`.

Templates: `infra/aws/task-web.json`, `task-worker.json` (één template, vier services via `WORKER_ROLE`), `task-migrate.json`, autoscaling in `infra/aws/worker-autoscaling.md`.

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collector-sidecar, bijv. `http://localhost:4318` |

## Eerste installatie

1. **Infrastructuur** aanmaken (VPC, RDS, ElastiCache, S3-bucket, Secrets Manager-secrets, ECS-cluster, ALB, log groups). Infrastructure-as-code (Terraform/CDK) volgt in fase 10; tot die tijd handmatig of via de console volgens deze tabel.
2. **Secrets** vullen:
   ```bash
   aws secretsmanager create-secret --name creatorfarm/prod/auth-secret --secret-string "$(openssl rand -base64 48)"
   aws secretsmanager create-secret --name creatorfarm/prod/encryption-key --secret-string "$(openssl rand -base64 32)"
   aws secretsmanager create-secret --name creatorfarm/prod/database-url --secret-string "postgresql://…?sslmode=require"
   aws secretsmanager create-secret --name creatorfarm/prod/redis-url --secret-string "rediss://…"
   ```
3. **Images** bouwen: push naar `main` → workflow *Release* publiceert `web`, `worker`, `migrate` naar GHCR.
4. **Migraties**: draai de `creator-farm-migrate` taak (doet `prisma migrate deploy`; nooit `migrate reset` of `db push` in productie).
5. **Seed** (eenmalig, vanaf een beheerhost met toegang tot de database):
   ```bash
   DATABASE_URL=… SEED_OWNER_EMAIL=jij@bedrijf.nl SEED_OWNER_PASSWORD='…' SEED_MONTHLY_BUDGET_EUR=500 pnpm db:seed
   ```
   Dit maakt de owner, het providerregister, veilige standaardlimieten en de starterprompts aan. Gebruik **niet** `--demo` in productie.
6. **Services** starten: `web`, `worker-scheduler`, `worker-generation`, `worker-media`, `worker-publishing`.
7. **Controle**: `GET /api/health` = 200; Workflow Monitor toont vier levende worker-rollen.

## Releases

`CI` (lint, typecheck, unit + integratie, e2e, image-builds) → bij succes op `main` publiceert `Release` de images → de `deploy`-job (GitHub environment *production* met verplichte reviewers, OIDC-rol `AWS_DEPLOY_ROLE_ARN`) draait eerst migraties en rolt daarna de services uit. Migraties zijn *expand/contract*: een release voegt eerst toe (kolommen, tabellen), een latere release verwijdert pas wat niet meer gebruikt wordt — zo blijven oude en nieuwe taken tijdens de rollout compatibel.

## Health checks

| Endpoint | Gebruik | Controleert |
|---|---|---|
| `GET /api/health/live` | container-/ALB-liveness | proces draait |
| `GET /api/health` | readiness, uptime-monitor | database, Redis, opslag (200 of 503) |
| worker `:9464/healthz` | container-health | database, Redis, workers draaien |

## Monitoring en alerts

CloudWatch-alarmen (minimaal):

| Alarm | Drempel |
|---|---|
| ALB 5xx-ratio | > 2 % over 5 min |
| `/api/health` faalt | 2 opeenvolgende checks |
| Worker-taken onder minimum | < gewenste aantal gedurende 5 min |
| Dead-letter-queue | > 0 nieuwe jobs (fase 10: metric vanuit scheduler) |
| Wachtrij-achterstand `publishing` | > 50 jobs of oudste > 30 min |
| RDS CPU / vrije opslag / verbindingen | 80 % / < 10 GB / 80 % |
| Redis geheugen | > 75 % (`noeviction` ⇒ schrijffouten bij vol) |
| Budget | 80 % en 100 % van maandlimiet (applicatiemelding + e-mail) |

Logs: JSON naar CloudWatch Logs (30 dagen), auditdata blijft in de database. Traces: OTLP → collector → AWS X-Ray of een andere backend.

## Back-ups

| Bron | Maatregel |
|---|---|
| PostgreSQL | RDS automated backups met point-in-time recovery (35 dagen); dagelijkse snapshot-kopie naar `eu-west-1`; maandelijkse snapshot 12 maanden bewaard. |
| S3 media | Versiebeheer aan; noncurrent versies 30 dagen; replicatie naar tweede regio voor goedgekeurde/gepubliceerde assets. |
| Redis | AOF aan. Redis bevat geen bron-van-waarheid: na verlies worden jobs herbouwd uit de database (zie herstel). |
| Secrets | Secrets Manager met replicatie naar tweede regio. |

## Herstelprocedures

**Database terugzetten (PITR)**
1. Zet **All generation** en **All publishing** op pauze (Settings → Controls) of schaal workers naar 0.
2. RDS → *Restore to point in time* naar een nieuwe instance.
3. Verifieer: aantal rijen in `cost_ledger`, laatste `audit_logs`, laatste `publishing_jobs`.
4. Wijzig `creatorfarm/prod/database-url` naar de nieuwe instance; herstart services (`force-new-deployment`).
5. Vergelijk `publishing_jobs` met status `PUBLISHING/AWAITING_CONFIRMATION` met de platforms (remote status) vóór je publicatie hervat.
6. Hervat de ketens; noteer de incident-ID in het auditlog via de pauzereden.

**Redis verloren**
1. Nieuwe ElastiCache-node, update `redis-url`, herstart workers.
2. De scheduler-worker plant zijn onderhoudsjobs automatisch opnieuw in.
3. Draai het herbouwscript (fase 5): alle DB-jobs in `QUEUED`/`RUNNING` worden opnieuw in de queue gezet met hun idempotency key; `RUNNING` generaties worden eerst via `getStatus()` bij de provider gecontroleerd.

**Media-object kwijt** — herstel uit een vorige S3-versie; de checksum in `media_assets` verifieert de integriteit.

**Credential gelekt** — roteer in Secrets Manager (provider-key: intrekken bij provider + nieuw secret); `AUTH_SECRET` roteren logt alle sessies uit; zet de betreffende provider op pauze tot rotatie bevestigd is.

Herstelprocedures worden elk kwartaal geoefend op een staging-omgeving.

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
