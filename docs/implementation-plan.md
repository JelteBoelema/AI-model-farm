# Implementatieplan

**Besluiten**
- 28-10-2026 — Cloud: AWS `eu-central-1` (Frankfurt) bevestigd.
- 28-10-2026 — Eerste publicatie-integratie in fase 7: Instagram.

Elke fase eindigt met werkende functionaliteit, groene tests (unit, integratie, e2e) en bijgewerkte documentatie. Externe integraties worden pas als "werkend" gemarkeerd na een geslaagde test met echte credentials; tot die tijd draaien ze tegen expliciete mockadapters.

## Fase 1 — Foundation ✅ (opgeleverd)

**Inhoud**
- Projectstructuur (modulaire monolith), Next.js 15 + TypeScript strict, Tailwind v4 design system met in-repo componenten, licht/donker thema, responsive.
- Volledig datamodel (alle fasen) met migratie, triggers (append-only `cost_ledger`/`audit_logs`), partiële unieke indexen (dubbele publicaties, één goedgekeurd karakterprofiel), CHECK-constraints.
- Authenticatie (Auth.js, credentials, brute-force-limiet), RBAC met 4 rollen, gebruikersbeheer met bescherming van de laatste owner.
- Dashboardshell met alle 14 secties, globale filters (creator, campagne, platform, periode, status) in de URL.
- Overview met echte cijfers en herkomstlabels (measured/estimated/demo/mock).
- Settings & Audit: kill switches (globaal + per creator/campagne/provider), gebruikers, doorzoekbaar auditlog.
- Workflow Monitor: live queue-tellingen, worker-heartbeats, dead-letter, jobs die aandacht vragen.
- AI Providers: register met eerlijke status (adapter/credential/prijs).
- Queue-infrastructuur: 8 queues + dead-letter, jitter-backoff, timeouts, idempotente enqueue, heartbeats, graceful shutdown; maintenance-processors (reserveringen vrijgeven, vastgelopen jobs veilig corrigeren).
- Storage-drivers (lokaal/S3), secrets-referenties (env/AWS Secrets Manager), AES-GCM, gestructureerde logging met redactie, health endpoints, OpenTelemetry (optioneel).
- Dockerfile (web/worker/migrate), docker-compose met MinIO, ECS-task-definities, CI- en release-workflows.

**Acceptatiecriteria** — allemaal aangetoond:
- [x] Inloggen/uitloggen werkt en wordt geaudit; anonieme gebruikers worden doorgestuurd. *(e2e)*
- [x] Alle 14 secties renderen zonder fouten, desktop en mobiel zonder horizontale scroll. *(e2e)*
- [x] Filters werken via de URL en blijven behouden bij navigatie; ongeldige waarden worden genegeerd. *(e2e + unit)*
- [x] Viewer is read-only; owner kan gebruikers aanmaken die daarna kunnen inloggen. *(e2e)*
- [x] Pauzeren/hervatten werkt, toont een banner en wordt geaudit; operators kunnen niet hervatten. *(e2e + integratie)*
- [x] Kostenjournaal en auditlog zijn niet te wijzigen of te verwijderen. *(integratie)*
- [x] Dubbele publicatiejobs zijn op databaseniveau onmogelijk. *(integratie)*
- [x] Vastgelopen publicaties gaan naar `AWAITING_CONFIRMATION`, nooit opnieuw publiceren. *(integratie)*
- [x] Jobs die al hun pogingen verbruiken komen in de dead-letter-queue. *(integratie)*
- [x] Health endpoints rapporteren DB/Redis/opslag zonder details te lekken. *(e2e + integratie)*
- [x] Productieconfiguratie weigert dev-secrets, lokale opslag en env-secrets. *(unit)*

## Fase 2 — Creator Engine ✅ (opgeleverd)

**Inhoud**
- Creatorbeheer: aanmaken, bewerken, dupliceren, activeren, pauzeren, hervatten en archiveren — volgens de statusmachine, met compare-and-set-updates en audit.
- Briefingwizard: van creatieve briefing naar een volledig, bewerkbaar voorstel (profiel + karakterconcept). Tot fase 4 komt het voorstel van een deterministische mockgenerator; elk veld is gemarkeerd met `[Mock]` en de UI toont een *Mock*-badge. Generatoroutput wordt altijd tegen hetzelfde schema gevalideerd als handmatige invoer.
- Profiel: niche, doelgroep, taal (BCP-47), regio's (ISO-3166, gevalideerd), persoonlijkheid, tone of voice, fictief achtergrondverhaal, contentpijlers, formats, tijdzone en publicatieschema (platform/dag/tijd).
- Per-creator budget (dag/maand) en autonomiemodus, met asymmetrische rechten: beperken mag een admin, verruimen alleen een owner (budget) of admin (autonomie).
- Character Studio: geversioneerde identiteit (gestructureerd uiterlijk, identiteitsprompt, negatieve prompt, consistentiestrategie), referentiebeelden uploaden met rechtenregistratie, canoniek markeren, goedkeuren met likeness-attestatie. Een nieuwe conceptversie neemt de referenties van de goedgekeurde versie over; goedkeuren zet de vorige versie in dezelfde transactie op `SUPERSEDED`.
- Uploadbeveiliging: type op basis van magic bytes (PNG/JPEG/WebP, nooit op extensie of browser-MIME), 512–8192 px, max. 15 MB, SHA-256-checksum, deduplicatie per creator, opslagobject opgeruimd als de databasetransactie mislukt.
- Pauzecontrole: een creator die niet `ACTIVE` is (concept, gepauzeerd, gearchiveerd) blokkeert generatie en publicatie via `assertNotPaused`.

**Regels die de service afdwingt**
- Activeren kan alleen met een goedgekeurd karakterprofiel.
- Archiveren wordt geweigerd zolang er publicaties gepland of onderweg zijn; gearchiveerde creators zijn alleen-lezen.
- Pauzeren: operator; hervatten: admin (zelfde regel als de kill switches).
- Goedkeuren vereist een volledig concept, ≥ 1 canonieke referentie en een attestatie van minimaal 20 tekens.
- Dupliceren kopieert instellingen en budgetlimieten, **niet** de visuele identiteit, accounts of content: een duplicaat is een sjabloon voor een nieuw, afwijkend personage.

**Acceptatie** — aangetoond:
- [x] Creator-levenscyclus volgt de statusmachine en wordt geaudit. *(integratie + e2e)*
- [x] Nieuwe goedgekeurde karakterversie zet de vorige op `SUPERSEDED` in één transactie; goedgekeurde versies zijn onveranderlijk. *(integratie + e2e)*
- [x] Uploads krijgen checksum en inhoudsvalidatie en zijn alleen geauthenticeerd bereikbaar. *(unit + integratie + e2e)*
- [x] Een gepauzeerde of niet-actieve creator blokkeert zijn jobs. *(integratie)*
- [x] Viewers zien alles alleen-lezen. *(e2e)*

## Fase 3 — Prompt Studio ✅ (opgeleverd)

**Inhoud**
- Templates per soort (idee, wizard, script, beeld, video, voice-over, caption, kwaliteits- en veiligheidsregels) en scope (globaal, creator, campagne), aanmaken, archiveren en herstellen.
- Versies: concept → gepubliceerd → verouderd. Gepubliceerde versies zijn onveranderlijk, afgedwongen in de service én met een databasetrigger; verouderde versies kunnen niet terugkomen. Maximaal één concept per template (partiële unieke index).
- Variabelen met een gevalideerde structuur: tekst, lange tekst, getal (min/max), keuzelijst, ja/nee; standaardwaarden; verplicht of optioneel. Contextvariabelen (`creator_*`, `campaign_*`) worden gevuld uit de gekozen creator (inclusief de identiteitsprompt van de goedgekeurde karakterversie) en campagne.
- Strikte templating-engine (Handlebars in een afgeschermde configuratie): alleen `{{variabele}}` en `{{#if}}`/`{{#unless}}`/`{{else}}`. Helpers, partials, paden en datavariabelen worden geweigerd met regelnummer. Niet-gedeclareerde variabelen zijn een fout; ongebruikte een waarschuwing. Ontbrekende context is een fout, nooit een lege string.
- Gepubliceerde globale veiligheidsregels worden automatisch aan generatieve prompts toegevoegd.
- Testgeneraties: voorbeeldweergave zonder opslag, en vastgelegde testruns met de exacte gerenderde prompt, variabelen, output, provider, mock-vlag, duur en kosten. Tekstsoorten draaien tegen de gelabelde mock-tekstprovider tot fase 4; beeld-, video- en regelsoorten worden alleen gerenderd.
- Vergelijken: twee testruns naast elkaar, en een regeldiff tussen een versie en de vorige.
- Campagne-pins: een campagne pint een gepubliceerde versie. Bepalen welke versie geldt gaat in deze volgorde: pin → campagnetemplate → creatortemplate → globaal. Verouderen en archiveren worden geweigerd zolang een open campagne de versie pint.

**Regels**
- Bewerken, testen en publiceren van creator- en campagnetemplates: operator. Publiceren of verouderen van globale templates en regeltemplates: admin (raakt alle creators).
- Een templatewijziging verandert nooit eerder gegenereerde content (die wijst naar een versie-ID en bewaart de gerenderde prompt) en nooit een gepinde campagne.

**Acceptatie** — aangetoond:
- [x] Gepubliceerde versies zijn onveranderlijk, ook bij directe databasewrites. *(integratie)*
- [x] Een nieuwe templateversie verandert een gepinde campagne niet; resolutie respecteert scopevolgorde. *(integratie + e2e)*
- [x] Elke testrun bewaart versie, gerenderde prompt, variabelen, output en kosten. *(integratie + e2e)*
- [x] Onveilige templateconstructies worden geweigerd. *(unit)*
- [x] Viewers zien de Prompt Studio alleen-lezen. *(e2e)*

## Fase 4 — AI Providers ✅ (opgeleverd)

**Inhoud**
- Eén uitvoerpad voor elke providercall (`src/server/services/generation.ts`): pauzecheck → validatie → raming → budgetbewaking → rate limit → call → kostenboeking.
- Adapters: **Anthropic Claude** (tekst; standaardmodel `claude-opus-5-5`, bulkmodel `claude-haiku-5-5`, officiële SDK), **OpenAI Images** (beeld, met referentiebeelden via de edit-endpoint; REST) en **mock-tekst/mock-beeld** (deterministisch, beeld met zichtbaar "MOCK"-watermerk).
- Gereedheid per provider, zichtbaar op **AI Providers**: adapter bestaat, ingeschakeld, model gekozen, credential resolveert, prijslijst compleet én een geslaagde live verbindingstest voor precies dat model. Een modelwijziging maakt de verbindingstest ongeldig.
- Prijslijsten per model en eenheid (tokens, beeldtokens, per beeld, lange context), in USD met verplichte wisselkoers of in EUR, met bron-URL. Voorinstelling met de Anthropic-lijstprijzen (te controleren op de bronpagina).
- Foutclassificatie (`invalid_input`, `content_policy`, `auth`, `rate_limited`, `transient`, `timeout`, `quota_exceeded`); `auth` en `quota_exceeded` pauzeren de provider automatisch met een kritieke melding.
- Rate limiting per provider (Redis, per minuut). Budgetbewaking: zonder farm-breed maandbudget wordt niets betaald uitgevoerd; daarnaast maximum per job en creator-/campagnebudgetten (besteed + gereserveerd + raming).
- Kosten: gemeten verbruik → `MEASURED`; timeout of ontbrekende prijs → conservatieve raming als `ESTIMATED` met notitie; nooit €0 voor een ontbrekende prijs. Elke poging van een server-side fallback van Claude wordt apart afgerekend. Mockcalls worden nooit als uitgave geboekt.
- Prompt-testruns draaien nu asynchroon in de worker (wachtrijen `generation-text` / `generation-image`) tegen de geselecteerde provider; beeldtests gebruiken de canonieke referenties van het goedgekeurde karakterprofiel. Gegenereerde beelden worden media-assets in status *ter review*.
- De creator-wizard gebruikt buiten mock-modus Claude met een JSON-schema.
- `pnpm test:live --yes`: handmatige smoketest met echte sleutels (een paar cent), draait nooit in CI.

**Acceptatie** — aangetoond:
- [x] Contracttests per adapter tegen opgenomen responsevormen, inclusief foutmapping, weigeringen en fallback-afrekening. *(unit)*
- [x] Een provider zonder prijs, credential of geslaagde verbindingstest blijft geblokkeerd; mock-modus valt nooit terug op een echte provider en andersom. *(integratie)*
- [x] Budgetbewaking, idempotente kostenboeking, automatische pauze en rate limiting. *(integratie)*
- [x] Mockoutput is gewatermerkt en gelabeld; testrun via de worker zichtbaar in de UI. *(unit + e2e)*
- [ ] Live smoketest met echte credentials — wacht op sleutels (zie `docs/open-actions.md`).

## Fase 5 — Content Factory ✅ (opgeleverd)

**Inhoud**
- Productieketen voor fotoformaten (post, carrousel van 2–6 slides, story): brief → shotlist → caption → één beeldjob per shot → kwaliteitscontrole → menselijke goedkeuring. Elke stap is een eigen job met deterministische idempotency key; de keten loopt automatisch door in de worker.
- Hervatten: een mislukte of geblokkeerde stap stopt de keten met een duidelijke reden; *Resume* zet alleen de mislukte jobs opnieuw in de wachtrij. Geslaagde stappen worden nooit opnieuw uitgevoerd of betaald. Vastgelopen jobs worden door maintenance gestopt en zijn ook hervatbaar.
- Cost Manager: raming → reservering (onder lock, over alle budgetten) → afrekening (ledger + reservering in één transactie) → vrijgave. Verlopen reserveringen worden opgeruimd.
- Kwaliteitscontrole: technische checks (type, grootte, resolutie, beeldverhouding, duplicaten, mock-waarschuwing) plus een rubric-review door Claude met de beelden én de canonieke referentiefoto's (karakterconsistentie). Alleen bij slagen automatisch naar *Ready*.
- Review: per shot takes goedkeuren of afwijzen (maximaal één goedgekeurde take per shot, afgedwongen in de database), nieuwe take genereren (telt mee voor de generatielimiet), item goedkeuren of afwijzen. Goedkeuren ondanks QC vraagt een reden. Alle besluiten als `approvals` + audit.
- Batches: tot 20 ideeën in één keer, optioneel direct produceren; batch later produceren.
- Mediabibliotheek met previews, filters op status en bron, goedkeuren/afwijzen en een vergelijkingsweergave met herkomst, prompt en QC-rapport.
- Kosten per bruikbaar asset op Content Factory, Costs & Budgets en per item.
- Nieuwe starttemplates: `brief.default`, `script.photo.default`, `qc.rubric.default` (bestaande installaties: seed opnieuw draaien, voegt alleen ontbrekende templates toe).
- Claude-adapter accepteert beelden (voor visuele QC); mock-tekst levert gelabelde JSON volgens het gevraagde schema.

**Nog niet** — video- en talking-head-formaten (fase 6); publiceren (fase 7); automatische pauze bij budgetlimieten (fase 8).

**Acceptatie** — aangetoond:
- [x] Volledige keten idee → goedgekeurd asset in mockmodus. *(e2e + integratie)*
- [x] Budgetoverschrijding blokkeert de job vóór de providercall; na verhogen hervat de keten. *(integratie)*
- [x] Een gefaalde job wordt veilig hervat zonder dubbele kosten: alleen de mislukte slide draait opnieuw, elke jobkost is gelijk aan wat het ledger boekte, geen openstaande reserveringen. *(integratie)*
- [x] Gelijktijdige reserveringen passen nooit samen boven het budget. *(integratie)*
- [x] Kosten per bruikbaar asset zichtbaar en correct berekend. *(integratie + UI)*
- [x] Viewers zien de factory alleen-lezen. *(e2e)*

## Fase 6 — Video Engine ✅ (opgeleverd)

**Inhoud**
- Formaat **korte video** (9:16, 2–5 scènes van 4, 6 of 8 s): brief → storyboard → caption → per scène een voice-over en een clip → montage → kwaliteitscontrole → menselijke goedkeuring. Het storyboard wordt opgeslagen als `video_scenes` (beeld, actie, duur, voice-overtekst, schermtekst).
- **Scènegewijs**: elke scène heeft eigen takes. *Nieuwe clip* maakt alleen voor die scène een nieuwe take; andere scènes, hun clips en voice-overs blijven onaangeroerd. Daarna volgen opnieuw montage en QC. Een voice-over wordt hergebruikt zolang de tekst gelijk blijft.
- **Montage met FFmpeg** (media-worker): elke clip wordt geschaald en bijgesneden naar 1080×1920 bij 30 fps, aangevuld of ingekort tot de geplande duur, aan elkaar gezet, met de voice-over per scène op de tijdlijn. Loudness wordt genormaliseerd naar −14 LUFS (true peak −1,5 dBTP); output is H.264/AAC MP4 met faststart. Ondertitels worden gemaakt uit de voice-overtekst (WebVTT, maximaal 2 regels van 42 tekens, nooit over een scènegrens heen).
- **Technische QC** op de eindvideo: container, codec/pixelformaat, resolutie 1080×1920, framerate, duur (± 0,5 s van het plan, maximaal 90 s), audiospoor, loudness en true peak, en de geldigheid van de ondertitels. Daarnaast beoordeelt Claude per scène een frame uit het midden, samen met de referentiefoto's van het karakter.
- **Langlopende providers**: het contract heeft nu indienen + peilen. De provider-job-ID wordt opgeslagen vóór verdere verwerking. Het budget blijft gereserveerd tot het resultaat binnen is. Na 30 minuten zonder resultaat wordt de raming geboekt (de provider kan gefactureerd hebben) en de stap gestopt; *Resume* dient dan opnieuw in.
- **Adapters**:
  - Google Veo (Gemini API, langlopend): tekst-naar-video met maximaal 3 referentiebeelden.
  - ElevenLabs: tekst-naar-spraak, alleen ontworpen stemmen. Er is een standaardstem per provider; een creator kan die overschrijven met `promptSettings.voiceId`.
  - Mock-video: gewatermerkte FFmpeg-clips met "MOCK" en het scènenummer, plus piepende placeholder-stemmen.
  - Nieuwe prijseenheden: per videoseconde en per 1.000 tekens spraak.
- Media worden geleverd met byte-ranges, zodat je in video en audio kunt spoelen. De mediabibliotheek en de vergelijkingsweergave tonen ook video.
- Starttemplates: `video.scene.default` (nieuw) en `script.short_video.default`, dat nu scènes en de brief gebruikt.

**Nog niet**
- Talking-head-video: vereist een lip-syncprovider, en die is nog niet geselecteerd. Je kunt zo'n item wel plannen, maar niet produceren.
- Ondertitels inbranden: nu als los bestand; platformspecifiek inbranden volgt bij publicatie.
- Runway als tweede videoprovider: pas na de consistentiebenchmark.

**Acceptatie** — aangetoond:
- [x] Eén scène opnieuw genereren raakt de andere scènes niet: geen nieuwe jobs, assets of statuswijzigingen voor die scènes; montage gebruikt hun ongewijzigde clip. *(integratie)*
- [x] QC weigert een afwijkend formaat (liggend, verkeerde codec/duur/loudness, ontbrekende ondertitels of audio). *(unit + integratie met echte FFmpeg-output)*
- [x] Mockvideo is gewatermerkt: de donkere "MOCK"-band is gemeten in een frame van de afgeleverde video. *(integratie)*
- [x] Langlopende provider: budget blijft gereserveerd tijdens het wachten, kosten worden één keer geboekt, opgeven boekt de raming, hervatten dient opnieuw in. *(integratie)*
- [x] Volledige videoketen tot goedkeuring via de echte workers; spoelbare levering (HTTP 206). *(e2e)*
- [ ] Live test met echte Veo- en ElevenLabs-sleutels — wacht op sleutels (zie `docs/open-actions.md`).

## Fase 7 — Publishing

**Inhoud** — OAuth-koppeling (met owner-goedkeuring), scope-/capability-verificatie, tokenvernieuwing, als eerste officiële integratie **Instagram** (Instagram Graph API — Content Publishing; besluit 28-10-2026), contentkalender (dag/week/maand, bulkplanning, conflictdetectie, tijdzones), campagnebeheer, exportpakket als ondersteund alternatief.

**Acceptatie** — publicatie met timeout verifieert eerst de remote status; geen dubbele publicatie bij herstart (integratie + e2e met mockplatform); ontbrekende rechten ⇒ `NEEDS_MANUAL_ACTION` met alternatief.

## Fase 8 — Autonomy

**Inhoud** — automatische planning binnen beleid, beleidscontroles vóór elke stap, harde limieten (budget, kosten per job, generaties per item, gelijktijdigheid, frequentie, workflowduur, retries), automatische pauze bij limieten, approvals-flow voor verhogingen.

**Acceptatie** — geen enkele limiet is via een agent-pad te wijzigen (test); overschrijding pauzeert de juiste scope; verhoging vereist owner-goedkeuring.

## Fase 9 — Analytics

**Inhoud** — periodieke snapshots per platform, dashboards per creator/campagne/contenttype, kosten per gepubliceerd item, patroonherkenning en experimentvoorstellen (gelabeld als voorspelling, met minimale steekproefgrootte).

**Acceptatie** — gemeten data en voorspellingen zijn visueel en in de data gescheiden; geen automatische strategie-aanpassing onder de ingestelde minimale steekproef.

## Fase 10 — Production Readiness

**Inhoud** — MFA/SSO, algemene rate limiting, WAF, infrastructure-as-code, OpenTelemetry in workers, queue-metrics naar CloudWatch + autoscaling, dependency- en containerscans, load test (50 creators), herstelproef, runbooks, pentest.

**Acceptatie** — herstelprocedure geoefend en gedocumenteerd; alarmen getest; load test zonder fouten op de doelbelasting.

## Definition of Done (platform)

De volledige workflow creator → gegenereerde content → mediabibliotheek → planning → publicatiestatus werkt aantoonbaar; minimaal één echte taalprovider, één echte beeldprovider en één officiële socialmedia-integratie zijn end-to-end getest met echte credentials; video werkt via een echte provider of duidelijk gemarkeerde mock; alle harde limieten worden server-side afgedwongen; alle belangrijke acties zijn traceerbaar; alle essentiële tests slagen.
