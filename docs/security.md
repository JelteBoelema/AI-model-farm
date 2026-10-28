# Security en privacy

## Dreigingsmodel (samenvatting)

| Dreiging | Maatregel |
|---|---|
| Overname van een operatoraccount | bcrypt (cost 12), min. 12 tekens, brute-force-limiet per IP+e-mail in Redis, generieke foutmelding, audit van elke poging, sessies max. 8 uur. MFA/SSO via OIDC-provider gepland (fase 10). |
| Rechten-escalatie | RBAC met expliciete permissies; rollen alleen toekennen door owner; laatste owner kan niet gedegradeerd/uitgeschakeld worden; eigen rol/account niet wijzigbaar. Rol en `disabled_at` per request uit DB. |
| Lekken van API-keys/tokens | Nooit in DB, frontend, logs of foutmeldingen. Alleen `credential_ref`; secrets via AWS Secrets Manager (prod). Logger redigeert credential-velden; audit-metadata wordt geschrapt. |
| Ongecontroleerde kosten | Server-side budgetreservering, harde limieten, kill switches, mockmodus als standaard. |
| Dubbele/ongewenste publicaties | Idempotency keys, partiële unieke index, statusverificatie bij timeouts, globale publicatie-pauze. |
| Misbruik van identiteit/likeness | Alleen synthetische identiteiten met likeness-attestatie; geen echte personen, stemmen of beelden zonder schriftelijke toestemming en rechtenregistratie (`rights_note`). |
| Manipulatie van financiële/audit-historie | `cost_ledger` en `audit_logs` append-only via databasetriggers (ook TRUNCATE geblokkeerd). |
| Injectie | Prisma met parameters (ook `$queryRaw` tagged templates); Zod-validatie op alle invoer; storage-keys alleen door de server gegenereerd en gevalideerd tegen path traversal. |
| Clickjacking / MIME-sniffing | `X-Frame-Options: DENY`, `nosniff`, HSTS, strikte referrer-policy, permissions-policy. |
| Templates als aanvalsvector | Afgeschermde Handlebars-configuratie: alleen variabelen en `if`/`unless`, geen helpers, partials, paden, `@data` of prototype-toegang; uitvoer niet HTML-ge-escaped maar ook nooit als HTML gerenderd; limieten op template- en uitvoergrootte. |
| Prompt-injectie via content | LLM-output wordt behandeld als data: nooit als instructie voor beleidswijzigingen; agents hebben geen schrijfpad naar limieten of rechten. |

## Authenticatie

- Auth.js v5, credentials-provider, JWT-sessies (8 uur) in een `HttpOnly`, `Secure` (productie), `SameSite=Lax` cookie.
- `src/server/auth/credentials.ts`: Zod-validatie → rate limit (`LOGIN_MAX_ATTEMPTS` per `LOGIN_WINDOW_SECONDS`) → constant-time vergelijking (ook bij onbekende e-mail via dummy-hash) → audit.
- Middleware beschermt alle pagina's; API-routes doen hun eigen check en geven `401`.
- Uitloggen wordt geaudit.
- **Gepland (fase 10):** TOTP-MFA voor owner/admin of OIDC-SSO (bijv. Google Workspace/Entra) met verplichte MFA.

## Autorisatie

`src/lib/rbac.ts`:

| Permissie | Minimale rol |
|---|---|
| dashboard bekijken, auditlog lezen | VIEWER |
| creators/prompts/content bewerken, goedkeuren, genereren, inplannen, **pauzeren** | OPERATOR |
| **hervatten**, providers beheren, socialmedia koppelen, budgetten verlagen | ADMIN |
| **budgetten verhogen**, autonomiebeleid, gebruikers beheren | OWNER |

Elke server action loopt via `defineAction(permission, schema, handler)`: authenticatie → permissie → Zod-validatie → handler → veilige foutvertaling. Onverwachte fouten krijgen een referentie-ID; details staan alleen in de serverlogs.

Wijzigingen die expliciete toestemming vereisen lopen via een `approvals`-record dat door een owner wordt besloten (Settings → Approvals):
- een nieuwe externe accountkoppeling;
- een verhoging of verwijdering van een harde budgetlimiet;
- een versoepeling van het autonomiebeleid;
- een securitywijziging.

Een admin die zo'n wijziging maakt, dient automatisch een verzoek in; aanscherpen mag een admin direct.

### Autopilot en andere automatische actoren

- De autopilot handelt als eigen service-identiteit:
  - actor `AGENT`;
  - `users.is_system`, altijd uitgeschakeld (CHECK-constraint), zonder bruikbaar wachtwoord;
  - niet te bewerken via gebruikersbeheer.
- Rol zegt niets over menselijkheid. Elke functie die limieten, budgetten, autonomiemodi, providerinstellingen, accountkoppelingen of gebruikers wijzigt, roept `assertHuman()` aan en weigert een `AGENT`- of `SYSTEM`-actor, ook met owner-rol.
- Automatische actoren mogen een kill switch alleen **aanzetten** (automatische pauze), nooit hervatten.
- De autopilotmodule importeert geen van die functies (statisch getest).
- Wat de autopilot wel doet, staat met reden in de auditlog (`autopilot.run`).

## Secrets management

| Omgeving | Driver | Referentie |
|---|---|---|
| Ontwikkeling/test | `env` | `env:ANTHROPIC_API_KEY` |
| Productie | `aws` (verplicht, afgedwongen in env-validatie) | `aws-sm:creatorfarm/prod/anthropic` |

- Platformsecrets (`DATABASE_URL`, `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, …) worden door ECS uit Secrets Manager in de container gezet; nooit in images of task-definities als platte tekst.
- OAuth-tokens van socialmedia-accounts (fase 7) worden als afzonderlijk secret per account opgeslagen (`aws-sm:creatorfarm/prod/social/<accountId>`), met IAM-beleid dat alleen de publishing-worker leestoegang geeft.
- `APP_ENCRYPTION_KEY` (AES-256-GCM, `src/server/crypto.ts`) is beschikbaar voor waarden die wij zelf moeten versleutelen; associated data koppelt een ciphertext aan zijn context.
- De Anthropic-client gebruikt een vaste basis-URL (`https://api.anthropic.com`): een `ANTHROPIC_BASE_URL` in de omgeving kan verkeer met de API-sleutel niet omleiden.
- Een `auth`- of `quota`-fout van een provider pauzeert die provider automatisch en stuurt een kritieke melding; hervatten is een bewuste actie van een admin.
- Prijslijsten en providerinstellingen wijzigen kan alleen een admin (`providers:manage`) en wordt geaudit.
- FFmpeg draait zonder shell: argumenten als array, elk proces in een eigen tijdelijke map die altijd wordt opgeruimd, met een AbortSignal voor de tijdslimiet. Video-downloads van Veo worden alleen van Google-hosts geaccepteerd en met de sleutel in een header opgehaald, nooit in de URL.
- **Socialmediakoppelingen**:
  - OAuth-`state` is eenmalig (atomisch gelezen en verwijderd), verloopt na 10 minuten en hoort bij de gebruiker die de koppeling startte; PKCE (S256).
  - De callback accepteert alleen de vaste route; het mock-toestemmingsscherm stuurt alleen terug naar die route.
  - Tokens staan alleen in de secret store: lokaal AES-256-GCM met de secretnaam als associated data, in productie AWS Secrets Manager onder `creatorfarm/prod/social/<id>` (IAM in `infra/aws/iam-social-secrets.json`).
  - Een nieuwe koppeling door een admin vereist goedkeuring door de owner; bij afwijzen of ontkoppelen worden de tokens verwijderd.
- Mock-media kunnen nooit naar een echt account; dat wordt bij inplannen én bij publiceren gecontroleerd.
- Rotatie: `AUTH_SECRET` roteren logt iedereen uit; provider-keys roteren in Secrets Manager, cache verloopt binnen 5 minuten.

## Uploads (referentiebeelden)

- Bestandstype bepaald op inhoud (magic bytes), niet op extensie of door de browser opgegeven MIME-type; alleen PNG, JPEG en WebP (geen SVG: geen script-risico).
- Maximaal 15 MB, 512–8192 px; server-action-limiet 16 MB.
- Opslagsleutels worden door de server gegenereerd (`creators/<id>/references/<jaar>/<maand>/<uuid>.<ext>`), objecten worden nooit overschreven.
- Elke upload vereist een bron-/rechtenregistratie (`rights_note`); echte personen alleen met schriftelijke toestemming.
- Media worden alleen geauthenticeerd geleverd (lokaal via `/api/media`, in productie via kortlevende signed URLs).

## Logging en foutmeldingen

- Gestructureerde JSON-logs (pino) met redactie van `password`, `token`, `apiKey`, `authorization`, `cookie`, `secret` op meerdere niveaus.
- Foutpagina's tonen alleen een digest/referentie. `/api/health` toont alleen ok/latency, geen foutteksten of connectiestrings (getest).
- Auditlog: wie, wat, wanneer, op welke entiteit, IP en user agent; metadata zonder secrets.

## Invoervalidatie en rate limiting

- Zod op env, URL-filters (ongeldige waarden worden genegeerd, niet doorgegeven), server actions en (fase 3) promptvariabelen.
- Login rate limiting in Redis. Fase 10: algemene rate limiting per gebruiker op muterende acties en op de upload-endpoint; AWS WAF met rate-based rules voor de load balancer.

## Privacy (AVG/GDPR)

- **Dataminimalisatie** — persoonsgegevens beperken zich tot operators (naam, e-mail, IP in auditlog). Creators zijn fictief.
- **Dataresidentie** — alle opslag in AWS `eu-central-1`. Voor elke AI-provider wordt vóór activatie vastgelegd: verwerkingslocatie, bewaartermijn van prompts/output, trainingsgebruik en verwerkersovereenkomst (DPA). Dit staat in `ai_providers.config.privacy`.
- **Rechten van betrokkenen** — operatoraccounts kunnen worden uitgeschakeld; persoonsgegevens in auditlogs worden na de bewaartermijn geanonimiseerd (fase 10 taak).
- **Referentiemateriaal** — uploads van echte personen (bijv. een model voor een product-shoot) alleen met registratie van toestemming en licentie in `rights_note`; zonder registratie geen gebruik als referentie.
- **Analytics** — alleen geaggregeerde platformstatistieken via officiële API's; geen gegevens van individuele volgers.

## Back-ups en herstel

Zie `deployment.md` § Back-ups. Samengevat: RDS automated backups + PITR (35 dagen), dagelijkse snapshot-kopie naar een tweede regio, S3-versiebeheer met lifecycle, Redis AOF (jobs zijn herbouwbaar uit de database). Herstelprocedure wordt elk kwartaal getest.

## Securitytests

Geautomatiseerd (zie `tests/`):

- append-only triggers, unieke publicatie-index, CHECK-constraints;
- brute-force-limiet, uitgeschakelde accounts, gelijke uitkomst voor onbekend e-mail/fout wachtwoord;
- RBAC-matrix, escalatiepreventie, bescherming laatste owner;
- redactie in logs en auditmetadata, AES-GCM-tampering;
- env-validatie weigert dev-secrets/lokale opslag in productie;
- e2e: anonieme redirect, viewer is read-only, security headers, health zonder lekken, media vereist authenticatie.

Gepland: dependency-audit en container-scan in CI (fase 10), periodieke externe pentest vóór productie-livegang.
