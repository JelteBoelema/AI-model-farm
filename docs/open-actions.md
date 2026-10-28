# Openstaande acties

Acties voor de eigenaar die bewust zijn uitgesteld tot de laatste fase, als het platform af is. Claude werkt deze lijst bij bij elke fase.

## 1. Pull requests reviewen en mergen

Fase 3, 4 en 5 bevatten databasemigraties (`prompt_studio`, `provider_execution`, `content_factory`); die worden bij deployment automatisch toegepast door de `migrate`-taak.

De fasen worden gestapeld opgeleverd: elke fase-branch bouwt voort op de vorige. Merge ze **in volgorde** en klik na elke merge op *Delete branch*: GitHub zet de basis van de volgende PR dan automatisch op `main` (anders handmatig: *Edit → base: main*).

| Fase | Pull request | Basis | Status |
|---|---|---|---|
| 2 — Creator Engine | [#1](https://github.com/JelteBoelema/AI-model-farm/pull/1) | `main` | wacht op review |
| 3 — Prompt Studio | [#2](https://github.com/JelteBoelema/AI-model-farm/pull/2) | `phase-2-creator-engine` | wacht op review (na #1) |
| 4 — AI Providers | [#3](https://github.com/JelteBoelema/AI-model-farm/pull/3) | `phase-3-prompt-studio` | wacht op review (na #2) |
| 5 — Content Factory | [#4](https://github.com/JelteBoelema/AI-model-farm/pull/4) | `phase-4-ai-providers` | wacht op review (na #3) |

Per PR: beschrijving lezen, de CI-checks moeten groen zijn, eventueel lokaal draaien (`README.md` → *Snel starten*), dan *Merge*.

## 2. Meta-app voor Instagram (nodig voor fase 7)

App review bij Meta kan weken duren. De stappen (namen van permissies en schermen op het moment van indienen opnieuw controleren in de Meta-documentatie):

1. **Meta Business-account** (business.facebook.com) aanmaken of gebruiken, en de bedrijfsverificatie afronden.
2. **Meta for Developers**-account en een nieuwe app van het type *Business*; product **Instagram** (API met Instagram Login) toevoegen.
3. Per creator een **Instagram professioneel account** (Creator of Business) aanmaken. Vermeld in de bio dat het om een AI-gegenereerd personage gaat.
4. In de app de redirect-URL van het platform registreren: `https://<jouw-domein>/api/social/instagram/callback` (exacte route volgt in fase 7).
5. **App review** aanvragen voor de publicatie- en inzichtpermissies (o.a. basisprofiel, content publiceren, inzichten). Meta vraagt een schermopname van de flow; die maken we in fase 7 met de werkende koppeling.
6. Privacybeleid- en gebruiksvoorwaarden-URL's publiceren (vereist voor review).
7. App-ID en app-secret **niet** delen in chat of code: opslaan in AWS Secrets Manager (`creatorfarm/prod/meta-app`); het platform leest ze via die referentie.

## 3. AI-providers live zetten (na fase 4)

Zonder deze stappen draait alles op de gelabelde mockproviders; betaalde generatie blijft geblokkeerd.

1. **API-sleutels** aanmaken bij Anthropic (console) en OpenAI. Niet in chat of code plakken: lokaal in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), in productie in AWS Secrets Manager (`creatorfarm/prod/anthropic`, `creatorfarm/prod/openai`) en op **AI Providers** als `aws-sm:…`-referentie.
2. **Farm-breed maandbudget** instellen (seed met `SEED_MONTHLY_BUDGET_EUR`, of onder Kosten → Budgetten). Zonder dit budget wordt geen enkele betaalde call uitgevoerd.
3. **Prijslijsten** invullen op **AI Providers**: voor Claude staat een voorinstelling klaar — prijzen controleren op de bronpagina en de **wisselkoers USD→EUR** invullen. Voor OpenAI Images de actuele prijzen van het gekozen model overnemen uit de officiële prijslijst.
4. **Model voor OpenAI Images bevestigen**: standaard staat `gpt-image-2` (gpt-image-1 is volgens openbare bronnen op 23-10-2026 uitgefaseerd). Dit is nog niet live geverifieerd; de verbindingstest toont welke beeldmodellen je sleutel ziet.
5. Per provider op **Test connection** klikken en daarna inschakelen.
6. Eenmalig `pnpm test:live --yes` draaien (kost enkele centen) en de uitkomst aan Claude doorgeven, zodat de adapters definitief geverifieerd zijn.
7. Na de deployment van fase 5 eenmalig de seed draaien (`pnpm db:seed`): die voegt alleen de nieuwe starttemplates toe (brief, fotoshotlist, QC-rubric) en laat bestaande templates ongemoeid.
8. Per creator een **goedgekeurd karakterprofiel met canonieke referentiefoto's**: zonder profiel start de productie niet, zonder referenties controleert QC de karakterconsistentie niet.
9. Optioneel: in de omgevingsinstellingen van Claude Code `developers.openai.com` toevoegen aan de toegestane domeinen, zodat de OpenAI-documentatie tijdens het bouwen gecontroleerd kan worden.

## Overige configuratie (staat al in de documentatie)

- AI-provider-sleutels (Anthropic, beeld- en videoprovider): zie `README.md` → *Ontbrekende configuratie*.
- AWS-omgeving in Frankfurt en GitHub-deploymentvariabelen: zie `docs/deployment.md`.
