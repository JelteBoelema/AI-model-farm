# AI Creator Farm

Cloud-gehost platform om 10–50 virtuele AI-creators te beheren: identiteit, prompts, beeld- en videogeneratie, planning, publicatie via officiële API's, analytics en harde kostenbeheersing — vanuit één dashboard, met maximale autonomie binnen expliciet ingestelde grenzen.

**Status: fase 1 (Foundation) en fase 2 (Creator Engine) opgeleverd.** Zie [`docs/implementation-plan.md`](docs/implementation-plan.md) voor wat er werkt en wat per fase volgt.

## Wat er nu werkt

- Inloggen met rollen (owner/admin/operator/viewer), gebruikersbeheer, brute-force-bescherming.
- Dashboard met 14 secties, globale filters en eerlijke herkomstlabels (*Measured*, *Estimated*, *Demo*, *Mock*).
- Overview, Workflow Monitor (live queues en workers), AI Providers-register, Costs & Budgets, auditlog.
- Creators aanmaken via een briefingwizard, bewerken, dupliceren, activeren, pauzeren, hervatten en archiveren; budget en autonomie per creator.
- Character Studio: geversioneerde visuele identiteit, referentiebeelden met rechtenregistratie, goedkeuring met likeness-attestatie.
- Kill switches: pauzeer alle generatie, alle publicatie, of één creator/campagne/provider.
- Volledig datamodel met databasegaranties: append-only kostenjournaal en auditlog, geen dubbele publicaties.
- Queue-infrastructuur met retries, jitter-backoff, timeouts, dead-letter, heartbeats en veilig herstel van vastgelopen jobs.
- Mockmodus standaard aan: er wordt niets betaald of gepubliceerd.

Secties waarvan bewerken/automatiseren in een latere fase komt, tonen de echte databasegegevens plus een duidelijke melding met de fase — geen nep-knoppen.

## Snel starten

Vereist: Node 22, pnpm 10, PostgreSQL 16, Redis 7.

```bash
cp .env.example .env
# vul AUTH_SECRET (openssl rand -base64 48) en APP_ENCRYPTION_KEY (openssl rand -base64 32)
pnpm install
pnpm db:migrate
SEED_OWNER_EMAIL=jij@example.com SEED_OWNER_PASSWORD='minimaal-12-tekens' SEED_MONTHLY_BUDGET_EUR=500 pnpm db:seed:demo
pnpm dev        # http://localhost:3000
pnpm worker     # tweede terminal: workers (maintenance in fase 1)
```

`db:seed:demo` voegt drie demo-creators met content en demo-statistieken toe, allemaal gemarkeerd als *Demo*. Gebruik `pnpm db:seed` (zonder demo) voor een schone installatie.

Of de volledige stack met Docker (PostgreSQL, Redis, MinIO, web en vier worker-rollen):

```bash
cp .env.example .env   # AUTH_SECRET en APP_ENCRYPTION_KEY invullen
docker compose up --build
```

## Scripts

| Script | Doel |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | webapp |
| `pnpm worker` | workers (dev, via tsx); `WORKER_QUEUES=generation,media,…` kiest de rol |
| `pnpm worker:build` / `pnpm worker:start` | gebundelde worker voor productie |
| `pnpm db:migrate` | `prisma migrate deploy` |
| `pnpm db:migrate:dev` | nieuwe migratie maken (alleen lokaal) |
| `pnpm db:seed` / `pnpm db:seed:demo` | owner, register, limieten, prompts (+ demo) |
| `pnpm lint` / `pnpm typecheck` | kwaliteit |
| `pnpm test` | unit + integratie (echte PostgreSQL + Redis) |
| `pnpm test:e2e` | Playwright tegen de productiebuild (`pnpm build` eerst) |

## Tests

- **Unit** (`tests/unit`) — statusmachines, RBAC, geld, backoff, filters, env-validatie, encryptie, redactie, opslag, queue-topologie.
- **Integratie** (`tests/integration`) — tegen PostgreSQL en Redis: databasetriggers en constraints, authenticatie en rate limiting, gebruikersbeheer, kill switches, onderhoudsjobs, queue-idempotentie en dead-letter, health, kostenoverzicht, providerregister. Elke run krijgt een eigen tijdelijk schema (`itest_<timestamp>`) dat na afloop wordt verwijderd; bestaande data wordt nooit gereset.
- **End-to-end** (`e2e/`) — inloggen/uitloggen, alle secties, filters, kill switches, rollen, API-headers en health, mobiele weergave.

Databases: standaard `creatorfarm_test` en `creatorfarm_e2e` op localhost (overschrijfbaar met `TEST_DATABASE_URL` / `E2E_DATABASE_URL`). Redis DB 15 (tests) en 14 (e2e) worden geleegd.

## Documentatie

| Document | Inhoud |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | stackevaluatie, projectstructuur, componenten, pipeline, queues, kosten, autonomie, schaal |
| [`docs/data-model.md`](docs/data-model.md) | entiteiten, relaties, constraints, statusmachines, retentie |
| [`docs/provider-strategy.md`](docs/provider-strategy.md) | adaptercontract, selectiecriteria, kandidaten, fallback, mocks, socialmedia-API's |
| [`docs/security.md`](docs/security.md) | dreigingsmodel, auth, RBAC, secrets, logging, AVG, back-ups |
| [`docs/deployment.md`](docs/deployment.md) | AWS-architectuur, env-variabelen, installatie, releases, monitoring, herstel |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | fasen 1–10 met acceptatiecriteria |

## Ontbrekende configuratie

Er zijn nog geen echte credentials gekoppeld. Alle providers staan op `NOT_CONFIGURED` totdat hun adapter (fase 4/6) is gebouwd én de credential is ingesteld:

| Provider | Credential-referentie |
|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` |
| OpenAI Images | `OPENAI_API_KEY` |
| Black Forest Labs | `BFL_API_KEY` |
| Google Veo | `GOOGLE_GENAI_API_KEY` |
| Runway | `RUNWAY_API_KEY` |
| ElevenLabs | `ELEVENLABS_API_KEY` |
| Instagram / TikTok / YouTube | developer-app + app-review (fase 7) |
