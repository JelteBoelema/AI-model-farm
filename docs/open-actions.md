# Openstaande acties

Acties voor de eigenaar die bewust zijn uitgesteld tot de laatste fase, als het platform af is. Claude werkt deze lijst bij bij elke fase.

## 1. Pull requests reviewen en mergen

Fase 3–10 bevatten databasemigraties (`prompt_studio`, `provider_execution`, `content_factory`, `video_engine`, `publishing`, `autonomy`, `workflow_clock`, `analytics`, `mfa`); die worden bij deployment automatisch toegepast door de `migrate`-taak.

De fasen worden gestapeld opgeleverd: elke fase-branch bouwt voort op de vorige. Merge ze **in volgorde** en klik na elke merge op *Delete branch*: GitHub zet de basis van de volgende PR dan automatisch op `main` (anders handmatig: *Edit → base: main*).

| Fase | Pull request | Basis | Status |
|---|---|---|---|
| 2 — Creator Engine | [#1](https://github.com/JelteBoelema/AI-model-farm/pull/1) | `main` | wacht op review |
| 3 — Prompt Studio | [#2](https://github.com/JelteBoelema/AI-model-farm/pull/2) | `phase-2-creator-engine` | wacht op review (na #1) |
| 4 — AI Providers | [#3](https://github.com/JelteBoelema/AI-model-farm/pull/3) | `phase-3-prompt-studio` | wacht op review (na #2) |
| 5 — Content Factory | [#4](https://github.com/JelteBoelema/AI-model-farm/pull/4) | `phase-4-ai-providers` | wacht op review (na #3) |
| 6 — Video Engine | [#5](https://github.com/JelteBoelema/AI-model-farm/pull/5) | `phase-5-content-factory` | wacht op review (na #4) |
| 7 — Publishing | [#6](https://github.com/JelteBoelema/AI-model-farm/pull/6) | `phase-6-video-engine` | wacht op review (na #5) |
| 8 — Autonomy | [#7](https://github.com/JelteBoelema/AI-model-farm/pull/7) | `phase-7-publishing` | wacht op review (na #6) |
| 9 — Analytics | [#8](https://github.com/JelteBoelema/AI-model-farm/pull/8) | `phase-8-autonomy` | wacht op review (na #7) |
| 10 — Production Readiness | #9 | `phase-9-analytics` | wacht op review (na #8) |

Per PR: beschrijving lezen, de CI-checks moeten groen zijn, eventueel lokaal draaien (`README.md` → *Snel starten*), dan *Merge*.

## 2. Meta-app voor Instagram (nodig voor fase 7)

App review bij Meta kan weken duren. De stappen (namen van permissies en schermen op het moment van indienen opnieuw controleren in de Meta-documentatie):

1. **Meta Business-account** (business.facebook.com) aanmaken of gebruiken, en de bedrijfsverificatie afronden.
2. **Meta for Developers**-account en een nieuwe app van het type *Business*; product **Instagram** (API met Instagram Login) toevoegen.
3. Per creator een **Instagram professioneel account** (Creator of Business) aanmaken. Vermeld in de bio dat het om een AI-gegenereerd personage gaat.
4. In de app de redirect-URL van het platform registreren: `https://<jouw-domein>/api/social/instagram/callback` (deze route bestaat sinds fase 7).
5. **App review** aanvragen voor de publicatie- en inzichtpermissies (o.a. basisprofiel, content publiceren, inzichten). Meta vraagt een schermopname van de flow. Eerst in **ontwikkelmodus** één eigen test-account als tester toevoegen; daarmee activeer en verifieer ik de echte Instagram-adapter, en met die werkende koppeling maken we de opname.
6. Privacybeleid- en gebruiksvoorwaarden-URL's publiceren (vereist voor review).
7. App-ID en app-secret **niet** delen in chat of code: opslaan in AWS Secrets Manager (`creatorfarm/prod/meta-app`); het platform leest ze via die referentie.
8. In de omgevingsinstellingen van Claude Code `developers.facebook.com` (en eventueel `graph.instagram.com`) toestaan, zodat ik endpoints, permissienamen en limieten kan verifiëren voordat de echte adapter aangaat.
9. Productie op **S3-opslag** (staat al in het deploymentplan): Instagram haalt media zelf op via tijdelijk ondertekende URL's; met lokale opslag kan dat niet.
10. Per creator **publicatieslots** invullen (weekdag + tijd), zodat bulkplanning en de kalender werken.

## 3. AI-providers live zetten (na fase 4)

Zonder deze stappen draait alles op de gelabelde mockproviders; betaalde generatie blijft geblokkeerd.

1. **API-sleutels** aanmaken bij Anthropic (console), OpenAI, Google AI Studio (Gemini API, voor Veo) en ElevenLabs. Niet in chat of code plakken: lokaal in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENAI_API_KEY`, `ELEVENLABS_API_KEY`), in productie in AWS Secrets Manager (`creatorfarm/prod/anthropic`, `…/openai`, `…/google-genai`, `…/elevenlabs`) en op **AI Providers** als `aws-sm:…`-referentie.
2. **Farm-breed maandbudget** instellen (seed met `SEED_MONTHLY_BUDGET_EUR`, of onder Kosten → Budgetten). Zonder dit budget wordt geen enkele betaalde call uitgevoerd.
3. **Prijslijsten** invullen op **AI Providers**: voor Claude staat een voorinstelling klaar — prijzen controleren op de bronpagina en de **wisselkoers USD→EUR** invullen. Voor OpenAI Images de actuele prijzen van het gekozen model overnemen uit de officiële prijslijst.
4. **Model voor OpenAI Images bevestigen**: standaard staat `gpt-image-2` (gpt-image-1 is volgens openbare bronnen op 23-10-2026 uitgefaseerd). Dit is nog niet live geverifieerd; de verbindingstest toont welke beeldmodellen je sleutel ziet.
5. Per provider op **Test connection** klikken en daarna inschakelen. Voor ElevenLabs eerst een **ontworpen (synthetische) stem** kiezen en het stem-ID invullen onder *Configure* (per creator te overschrijven); nooit een gekloonde stem zonder schriftelijke toestemming.
   - Prijzen voor Veo per videoseconde en voor ElevenLabs per 1.000 tekens overnemen uit de officiële prijslijsten.
   - Veo-modelnaam en parameters bevestigen: endpoint en antwoordvorm zijn bevestigd, de parameternamen (beeldverhouding, duur, referentiebeelden) nog niet.
6. Eenmalig `pnpm test:live --yes` draaien (kost enkele centen; met `SMOKE_VOICE_ID` ook spraak) en daarna `pnpm test:live --yes --video` (één clip van 4 seconden), en de uitkomst aan Claude doorgeven, zodat de adapters definitief geverifieerd zijn.
7. Na de deployment eenmalig de seed draaien (`pnpm db:seed`): die voegt alleen ontbrekende starttemplates toe (brief, fotoshotlist, QC-rubric, videoscène) en laat bestaande templates ongemoeid. Wie `script.short_video.default` al had: in de Prompt Studio een nieuwe versie maken die `{{scenes}}` en `{{brief}}` gebruikt (de oude werkt, maar noemt het aantal scènes niet).
8. Per creator een **goedgekeurd karakterprofiel met canonieke referentiefoto's**: zonder profiel start de productie niet, zonder referenties controleert QC de karakterconsistentie niet.
9. Optioneel: in de omgevingsinstellingen van Claude Code `developers.openai.com`, `ai.google.dev` en `elevenlabs.io` toevoegen aan de toegestane domeinen, zodat de providerdocumentatie tijdens het bouwen gecontroleerd kan worden.
10. **Lip-syncprovider** kiezen voor talking-headvideo's (later; tot dan zijn alleen korte video's met voice-over te produceren).

## 4. Autonomie instellen (na fase 8)

1. Onder **Settings → Autonomy** de farm-brede limieten controleren. De seed zet veilige standaarden, maar laat de autopilot-velden leeg:
   - nieuwe items per creator per dag: leeg betekent dat de autopilot niets start;
   - zelfgoedkeuring: leeg betekent nooit.
   Stel bewust in hoeveel de autopilot per dag mag starten, en of hij zelf mag goedkeuren (en vanaf welke QC-score).
2. Per creator de **autonomiemodus** kiezen. Nieuwe creators staan standaard op *Controlled autonomy*. Wie eerst wil meekijken: *Assisted* (alleen productie tot review) of *Manual*.
3. **Budgetten** met automatische pauze per creator of campagne waar dat nodig is, naast het farm-brede maandbudget.
4. Verzoeken van admins verschijnen onder **Settings → Approvals**; alleen de owner beslist.

## 5. Analytics (na fase 9)

1. Bij de Meta-app-review (sectie 2) ook de permissie voor **inzichten/statistieken** aanvragen. Zonder die permissie verzamelt het platform geen statistieken voor dat account en krijg je één melding per dag.
2. Onder **Settings → Autonomy** de **minimale steekproef** controleren:
   - de seed zet 30 posts per vergeleken groep; bestaande installaties hebben geen waarde (leeg), en dan stuurt analytics de planning nooit;
   - lager zetten is een versoepeling en vraagt de owner.
3. De echte statistiekenadapter voor Instagram wordt samen met de publicatie-adapter geactiveerd en geverifieerd. Tot die tijd zijn alle statistieken mock- of demodata en staan ze zo gelabeld.

## 6. Productie-installatie (na fase 10)

Volg `docs/deployment.md` → *Eerste installatie*. Wat jij moet doen of aanleveren:
1. **AWS-account** in Frankfurt met:
   - een S3-bucket en een DynamoDB-tabel voor de Terraform-state;
   - een ACM-certificaat voor het domein;
   - de GitHub OIDC-provider.
2. **Domeinnaam** en een **alarm-e-mailadres**: invullen in `infra/terraform/production.tfvars` (voorbeeld staat ernaast). Daarna `terraform apply`, en de SNS-e-mail bevestigen.
3. **Secrets vullen** met de AWS CLI: app-sleutels, database-URL, Redis-URL en de API-sleutels uit sectie 3.
4. **GitHub**:
   - de variabelen voor de deploy (outputs van Terraform);
   - de environment `production` met jou als verplichte reviewer;
   - bij private images een token voor GHCR.
5. **Eerste aanmelding**: tweestapsverificatie instellen en de herstelcodes veilig bewaren. Zet bij voorkeur een tweede owner-account op (een owner kan zijn eigen 2FA niet resetten).
6. **Na de eerste deploy**:
   - de alarmtest in AWS (`docs/runbooks/alarms.md`) en de RDS-herstelproef op staging (`docs/runbooks/restore.md`), en de uitkomst vastleggen in `docs/runbooks/drills.md`;
   - de load test herhalen op staging met 2 webtaken.
7. **Externe pentest** laten uitvoeren vóór de livegang (scope en bevindingen tot nu toe: `docs/security-review.md`).
8. Optioneel: **single sign-on** (Terraform-variabele `oidc` en het secret `oidc-client-secret`; zie `docs/runbooks/access.md`).
9. Later: **het anonimiseren van persoonsgegevens in auditlogs** na de bewaartermijn automatiseren (nu op verzoek handmatig).

## Overige configuratie (staat al in de documentatie)

- AI-provider-sleutels (Anthropic, beeld- en videoprovider): zie `README.md` → *Ontbrekende configuratie*.
- AWS-omgeving in Frankfurt en GitHub-deploymentvariabelen: zie `docs/deployment.md`.
