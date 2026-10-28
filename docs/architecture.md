# Architectuur

AI Creator Farm is een **modulaire monolith**: één Next.js-applicatie (dashboard + API) en één worker-codebase die als vier afzonderlijk schaalbare rollen wordt gedeployed. PostgreSQL is de bron van waarheid voor alle bedrijfsstatussen; Redis/BullMQ is uitsluitend transport en planning.

## Uitgangspunten

| Principe | Uitwerking |
|---|---|
| Eenvoudigste betrouwbare oplossing | Geen microservices, geen event-bus, geen aparte API-server. Modules zijn mappen met duidelijke grenzen. |
| Database is de waarheid | Elke job heeft een rij met expliciete status. Queue-jobs dragen alleen ID's; na een herstart wordt de status uit de database gelezen. |
| Expliciete statusmachines | `src/lib/state-machines.ts` bepaalt welke overgangen legaal zijn; services roepen `assertTransition()` aan vóór elke update. Updates gebruiken compare-and-set (`WHERE status = <verwacht>`). |
| Niets gebeurt stilzwijgend | Kosten, publicaties, pauzes en rechtenwijzigingen worden geaudit in een append-only log. |
| Eerlijke data | Elk getal is *measured*, *estimated*, *demo* of *mock*, en wordt zo getoond. Een ontbrekende prijs is nooit € 0. |
| Server-side handhaving | Budgetten, limieten, rechten en pauzes worden in services/workers afgedwongen, nooit alleen in de UI. |

## Stackevaluatie

De voorgeschreven stack is behouden. Afwegingen:

| Keuze | Besluit | Reden |
|---|---|---|
| Next.js 15.5 (App Router) + TypeScript | Behouden | Server components + server actions houden de API-laag dun. 15.5 i.p.v. 16: volwassen, gepatcht (incl. de RSC-beveiligingsfixes) en compatibel met Auth.js v5. Upgrade naar 16 is een geïsoleerde taak. |
| PostgreSQL 16 + Prisma 6 | Behouden | Prisma 6 (niet 7) omdat 7 een andere client-/adapterarchitectuur vereist zonder voordeel voor deze schaal. Constraints die Prisma niet kan uitdrukken staan als SQL in de migratie. |
| Redis + BullMQ 5 | Behouden | Retries, delays, prioriteiten, job schedulers en stalled-job detectie out-of-the-box. Per-provider limieten worden in de processors afgedwongen (BullMQ-groepen zijn Pro-only). |
| S3-compatibele opslag | Behouden | Driver-abstractie: `s3` in productie, `local` voor ontwikkeling/tests. |
| Auth.js v5 (credentials, JWT) | Behouden | Kleine, bekende gebruikersgroep. Rol en `disabledAt` worden **per request** uit de database gelezen, dus intrekken werkt direct ondanks JWT. OIDC/SSO kan later als extra provider. |
| Tailwind v4 + shadcn/ui-patroon | Behouden | Componenten zijn in-repo (Radix + cva), dus volledig aanpasbaar zonder registry-afhankelijkheid. |
| Zod 4 | Behouden | Validatie van env, filters, server-actions en (fase 3) promptvariabelen. |
| FFmpeg | Behouden | Zit in het worker-image; mediawerk draait alleen in de `media`-rol. |
| OpenTelemetry | `@vercel/otel` voor web (alleen actief met `OTEL_EXPORTER_OTLP_ENDPOINT`); workers volgen in fase 10. |
| Cloud | AWS `eu-central-1` (Frankfurt) | EU-dataresidentie (AVG), beheerde RDS/ElastiCache/S3/Secrets Manager, ECS Fargate voor web + workers. Zie `deployment.md`. |

## Projectstructuur

```
creator-farm/
├── prisma/
│   ├── schema.prisma            # volledig datamodel (alle fasen)
│   ├── migrations/              # incl. handgeschreven SQL: triggers, partiële unieke indexen, checks
│   └── seed.ts                  # owner, providerregister, limieten, starterprompts, --demo
├── src/
│   ├── app/                     # Next.js routes
│   │   ├── (auth)/login/        # inloggen
│   │   ├── (dashboard)/         # 14 secties, elk een map; server actions per sectie (actions.ts)
│   │   └── api/                 # auth, health (live/ready), geauthenticeerde media
│   ├── components/
│   │   ├── ui/                  # design-system primitives (shadcn-patroon)
│   │   ├── layout/              # sidebar, filterbalk, gebruikersmenu, thema
│   │   └── dashboard/           # status-/herkomstbadges, statkaarten, lege staten
│   ├── config/navigation.ts     # secties, groepen, iconen, fase
│   ├── lib/                     # framework-vrij: statusmachines, RBAC, geld, backoff, filters
│   ├── server/                  # alleen server-side
│   │   ├── auth/                # Auth.js-config, credential-check, sessiehulpen
│   │   ├── queue/               # queue-topologie, enqueue, worker-factory, heartbeats
│   │   ├── providers/           # catalogus + adaptercontract (types.ts); adapters in fase 4/6
│   │   ├── services/            # domeinservices (users, dashboard; later creators, content, costs…)
│   │   ├── actions.ts           # wrapper: auth → permissie → validatie → veilige fouten
│   │   ├── audit.ts controls.ts env.ts secrets.ts storage.ts crypto.ts logger.ts health.ts
│   ├── workers/
│   │   ├── main.ts              # worker-entrypoint, rol via WORKER_QUEUES
│   │   └── processors/          # per queue; fase 1: maintenance
│   ├── instrumentation.ts       # OpenTelemetry (optioneel)
│   └── middleware.ts            # route-bescherming
├── tests/unit, tests/integration, e2e/
├── infra/aws/                   # ECS task-definities, autoscaling
├── Dockerfile                   # targets: web, worker, migrate
├── docker-compose.yml           # volledige lokale stack incl. MinIO
└── .github/workflows/           # ci.yml, release.yml
```

Toekomstige modules volgen hetzelfde patroon: `src/server/services/<module>.ts` (domeinlogica, transacties, audit) + `src/app/(dashboard)/<sectie>/` (UI + server actions) + `src/workers/processors/<queue>.ts`.

## Componentoverzicht

```mermaid
flowchart LR
  U[Operator / browser] -->|HTTPS| W[Web: Next.js<br/>dashboard + server actions]
  W --> PG[(PostgreSQL<br/>bron van waarheid)]
  W --> R[(Redis<br/>BullMQ)]
  W --> S3[(S3<br/>media)]
  W --> SM[Secrets Manager]
  subgraph Workers
    SCH[scheduler<br/>planning, maintenance]
    GEN[generation<br/>text, image, video]
    MED[media<br/>FFmpeg, QC]
    PUB[publishing<br/>publish, analytics]
  end
  R <--> SCH & GEN & MED & PUB
  SCH & GEN & MED & PUB --> PG
  GEN & MED --> S3
  GEN --> AI[AI-providers<br/>Claude, beeld, video, spraak]
  PUB --> SOC[Instagram / TikTok / YouTube<br/>officiële API's]
  GEN & PUB --> SM
```

## Content-pipeline (fase 5–9)

Elke stap is een **afzonderlijke job** (`generation_jobs`) met een deterministische idempotency key: `content:<item>:brief:1`, `…:script:1`, `…:caption:1`, `…:image:<shot>:<take>` en `…:qc:<generaties>`. De jobrij is de bron van waarheid; een geslaagde stap wordt nooit opnieuw uitgevoerd. Een mislukte stap stopt de keten (`content_items.failed_step` + `last_error`); **hervatten** zet alleen de mislukte jobs opnieuw in de wachtrij, zodat werk dat al betaald is niet opnieuw gebeurt. Een mislukte publicatie leidt nooit tot een nieuwe generatie.

Fase 5 (`src/server/services/content-pipeline.ts`, `src/lib/content-pipeline.ts`) levert de fotoformaten (post, carrousel, story):

| Stap | Status na afloop | Template (kind + sleutelprefix) | Provider |
|---|---|---|---|
| brief | `IDEA → BRIEFED` | `IDEATION`, `brief.` | tekst (groot model) |
| shotlist | `BRIEFED → SCRIPTED` | `SCRIPT`, `script.photo` | tekst (groot model) |
| caption | `SCRIPTED → PROMPTED` | `CAPTION`, `caption.` | tekst (bulkmodel) |
| beelden (één job per shot) | `PROMPTED → GENERATING → QC_REVIEW` | `IMAGE`, `image.` | beeld, met canonieke referenties |
| kwaliteitscontrole | `QC_REVIEW → READY` (of blijft ter review) | `QUALITY_RULES`, `qc.` | tekst met beeldinvoer + technische checks |
| menselijke goedkeuring | `READY → APPROVED` | — | — |

Video (korte video, 9:16) volgt dezelfde mechaniek met andere stappen: **storyboard** (`SCRIPT`, `script.short_video`) → `video_scenes`; **caption**; per scène een **voice-over** (`SPEECH`, telt niet als generatie) en een **clip** (`VIDEO`, template `video.`, met maximaal 3 referentiebeelden); als alle laatste takes klaar zijn volgt de **montage** (`MEDIA_PROCESSING`, FFmpeg op de media-worker, zonder provider) en daarna **kwaliteitscontrole** op de eindvideo (technische checks + frames per scène voor het rubriekmodel). Langlopende providers dienen in, slaan de provider-job-ID op en worden via vertraagde queue-jobs gepeild (elke 15 s, maximaal 30 min).

Tekststappen vragen gestructureerde JSON (JSON-schema) en valideren het antwoord met Zod. De AI-disclosure wordt aan de caption toegevoegd als het model hem vergeet. Templates worden opgelost zoals in de Prompt Studio (campagne-pin → campagne → creator → globaal), beperkt tot de sleutelprefix van de stap. QC haalt `READY` alleen als alle technische checks slagen, het rubriekmodel slaagt met score ≥ 70, zonder rubriekfouten en (met referentiefoto's) met een consistent personage. Anders beslist een mens: nieuwe take per shot, takes goedkeuren/afwijzen, of goedkeuren ondanks QC met een verplichte reden.

```mermaid
sequenceDiagram
  participant P as planning
  participant G as generation
  participant C as Cost Manager
  participant M as media
  participant B as publishing
  P->>G: idee → briefing → script (TEXT)
  G->>C: raming + reservering
  C-->>G: OK / BLOCKED_BUDGET
  G->>G: assertNotPaused(creator, campagne, provider)
  G->>G: generatie (IMAGE/VIDEO) via adapter
  G->>C: werkelijke kosten boeken, rest vrijgeven
  G->>M: opslaan, checksum, technische QC (FFmpeg)
  M->>P: kwaliteits- en beleidscheck → READY / goedkeuring
  P->>B: inplannen (respecteert account-limieten)
  B->>B: capability-check → publiceren → status verifiëren
  B->>B: timeout? → AWAITING_CONFIRMATION → remote status opvragen
  B->>P: analytics-snapshots ophalen
```

## Queue-architectuur

Gedefinieerd in `src/server/queue/definitions.ts`; zichtbaar in de Workflow Monitor.

| Queue | Rol | Concurrency | Pogingen | Timeout | Doel |
|---|---|---|---|---|---|
| `planning` | scheduler | 2 | 3 | 5 m | ideeën, kalender vullen |
| `generation-text` | generation | 10 | 3 | 3 m | LLM-calls |
| `generation-image` | generation | 5 | 3 | 10 m | beeldgeneratie |
| `generation-video` | generation | 2 | 2 | 45 m | video, spraak, lip-sync (pollend) |
| `media-processing` | media | 2 | 3 | 20 m | FFmpeg, ondertitels, technische QC |
| `publishing` | publishing | 3 | 4 | 10 m | publiceren met statusverificatie |
| `analytics` | publishing | 2 | 3 | 5 m | statistieken ophalen |
| `maintenance` | scheduler | 1 | 3 | 2 m | reserveringen vrijgeven, vastgelopen jobs |
| `dead-letter` | — | — | — | — | uitgeputte jobs, alleen handmatig opnieuw |

Mechanismen:

- **Idempotente enqueue** — `enqueue()` leidt de BullMQ-job-ID af van een zakelijke idempotency key; dezelfde stap kan niet dubbel in de queue staan.
- **Backoff** — exponentieel met *full jitter* (`src/lib/backoff.ts`), per queue een basis en plafond.
- **Timeouts** — elke poging krijgt een `AbortSignal`; overschrijding geeft `JobTimeoutError`.
- **Dead-letter** — na de laatste poging (of bij `UnrecoverableError`) wordt een kopie met reden in `dead-letter` gezet.
- **Vastgelopen jobs** — BullMQ-stalled-detectie (30 s) plus `jobs.detect-stuck` (elke 2 min) die DB-jobs voorbij `stuckAfterMs` corrigeert. Publicaties gaan dan naar `AWAITING_CONFIRMATION`, nooit direct opnieuw.
- **Prioriteiten** — publicaties (2) gaan voor generatie (5) en analytics (8).
- **Limieten per provider/account** (fase 4/7) — Redis-token-bucket in de processor; bij overschrijding wordt de job vertraagd (`DelayedError`), niet gefaald.
- **Heartbeats** — elke worker schrijft elke 15 s; de monitor toont levende consumers per queue.
- **Graceful shutdown** — `SIGTERM` laat actieve jobs afmaken (ECS `stopTimeout: 120`).

## Kostenbeheersing (Cost Manager, fase 5/8)

Geïmplementeerd in `src/server/services/cost-manager.ts` en `generation.ts`.

1. **Raming** — `adapter.estimate()` geeft het maximale verbruik; geprijsd met de prijslijst van de provider. Geen prijs ⇒ job `BLOCKED_BUDGET`, nooit € 0.
2. **Reservering** — in één transactie onder een advisory lock (`pg_advisory_xact_lock`), zodat gelijktijdige jobs niet samen in de laatste euro passen: som(geboekt + gereserveerd + raming) ≤ limiet voor *alle* toepasselijke budgetten (verplicht farm-breed maandbudget, plus dag/maand per creator, campagne, provider) én ≤ `maxCostPerJob`. Anders `BLOCKED_BUDGET` + melding; de provider wordt niet aangeroepen.
3. **Uitvoering** — alleen met een `HELD`-reservering.
4. **Afrekening** — werkelijke kosten (`MEASURED`, of `ESTIMATED` met onzekerheidsnotitie bij timeout of ontbrekende prijs) als `CHARGE` in het append-only `cost_ledger`, in dezelfde transactie als reservering → `CONSUMED`. Ledger-sleutel per poging (`genjob:<id>:<poging>`), dus elke betaalde call wordt precies één keer geboekt. Niet-gefactureerde calls geven de reservering vrij (`RELEASED`). Correcties alleen via `ADJUSTMENT`-boekingen.
5. **Opruimen** — verlopen reserveringen worden door `maintenance` vrijgegeven.
6. **Automatisch pauzeren** — bij het bereiken van een harde limiet met `autoPause` zet het systeem een `control_switch`; hervatten vereist een admin, verhogen vereist een owner-goedkeuring.

Mockcalls kosten aantoonbaar € 0, reserveren niets en worden niet geboekt.

**Kosten per bruikbaar asset** = alle contentkosten (inclusief afgewezen takes, mislukte pogingen en QC) ÷ aantal goedgekeurde gegenereerde assets; zichtbaar op Content Factory, Costs & Budgets en per item. Zonder goedgekeurde assets is de waarde onbepaald ("—"), niet nul.

## Autonomie (fase 8)

Standaardmodus `CONTROLLED_AUTONOMY`. Het systeem mag binnen `autonomy_policies` en `budget_policies` zelfstandig plannen, genereren, selecteren, inplannen en publiceren. Er bestaat **geen schrijfpad** van agents naar beleidsregels: die zijn alleen via server actions met `policies:manage`/`budgets:raise` (owner) te wijzigen, en een verhoging loopt via een `approvals`-record. Kill switches bestaan per creator, campagne, provider en voor de hele generatie- of publicatieketen.

## Schaalbaarheid

Ontworpen voor 10–50 creators (orde 50–300 contentitems/dag). Knelpunten en de route daarna:

- **Generatie** — schaalt horizontaal per worker-rol op queue-diepte.
- **Database** — alle hot-path queries zijn geïndexeerd op `(status, updated_at)`, `(creator_id, …)`; ledger-aggregaties per periode. Voorbij ~200 creators: leesreplica voor dashboards, maandpartitionering van `cost_ledger` en `analytics_snapshots`.
- **Redis** — `noeviction` + AOF; BullMQ-data wordt na 7/30 dagen opgeruimd.
- **Modules** — de worker-rollen kunnen zonder codewijziging naar aparte services; de webmonoliet kan modules afsplitsen langs `src/server/services/*`.
