# Providerstrategie

Alle AI-diensten zitten achter één contract: `ProviderAdapter` in `src/server/providers/types.ts`. De Content Factory kent geen vendor-SDK's. Providers staan in het register (`ai_providers`, beheer via **AI Providers**) en zijn pas bruikbaar als **(1)** de adapter bestaat, **(2)** de credential via de secrets store resolveert en **(3)** er een prijstabel is. Daarnaast moet de provider zijn ingeschakeld, een model hebben en moet een **live verbindingstest** voor dat model geslaagd zijn. Ontbreekt iets, dan is de status `NOT_CONFIGURED` en wordt er niets betaald uitgevoerd.

> **Let op:** providerlandschap, modellen, prijzen en API-voorwaarden veranderen snel. De kandidaten hieronder zijn gebaseerd op de kennis bij het schrijven en worden in fase 4/6/7 **opnieuw geverifieerd** tegen de actuele documentatie, prijslijsten en licentievoorwaarden voordat er een adapter wordt gebouwd. Prijzen worden nooit uit dit document overgenomen, alleen uit de officiële prijslijst op het moment van integratie.

## Adaptercontract

```ts
interface ProviderAdapter {
  key: string; isMock: boolean;
  discoverCapabilities(signal): Promise<ModelCapability[]>; // gebruikt door de verbindingstest
  validate(request): void;                                  // gooit invalid_input vóór er geld wordt uitgegeven
  estimate(request): CostEstimate;                          // bovengrens van het verbruik per prijseenheid
  generate(request, signal): Promise<GenerationResult>;     // outputs + verbruik per poging + servedBy
}
```

Video-adapters (fase 6) krijgen een asynchrone variant (indienen + status opvragen).

Foutclassificatie (`ProviderError.kind`) bepaalt het gedrag van de worker:

| Soort | Gedrag |
|---|---|
| `invalid_input`, `content_policy` | niet opnieuw proberen; item naar review |
| `rate_limited` | vertragen met `retryAfterMs`, telt niet als mislukte poging |
| `transient` | retry met jitter-backoff |
| `timeout` | conservatieve raming boeken (`ESTIMATED`); bij async providers eerst status opvragen |
| `auth`, `quota_exceeded` | provider automatisch pauzeren (`control_switch`) + melding |

Elke adapterimplementatie krijgt contracttests die met opgenomen (geanonimiseerde) responses draaien, plus een handmatige live smoketest (`pnpm test:live --yes`) die nooit in CI draait.

## Selectiecriteria

Een provider wordt pas gekozen na een gedocumenteerde evaluatie op:

1. **Werkelijke API-beschikbaarheid** (publiek, SLA, regio's, rate limits).
2. **Kwaliteit** op onze eigen testset (fotorealisme, handen/tekst, beweging).
3. **Karakterconsistentie** — identiteitsbehoud over 20 generaties met referentiebeelden (gemeten met face-embedding-afstand, zie fase 2).
4. **Commerciële licentie** — output mag commercieel gebruikt worden; geen claim op output; trainingsgebruik van onze input bij voorkeur uitgesloten.
5. **Privacy** — dataverwerking/-opslag, EU-verwerking of passende waarborgen, verwerkersovereenkomst.
6. **Snelheid** en **prijs per bruikbare asset** (niet per generatie).

## Kandidaten

| Capability | Primair (kandidaat) | Fallback (kandidaat) | Opmerking |
|---|---|---|---|
| Complexe tekst (creator-wizard, scripts, storyboards, QC-redenering) | Anthropic Claude (groot model) | — | Claude waar redeneren en creatieve kwaliteit tellen. |
| Bulktekst (captions, hashtags, varianten) | Anthropic Claude (klein/snel model) | — | Zelfde adapter, ander model; kostenregel per model. |
| Beeld (fotorealistisch, referentie-geconditioneerd) | OpenAI Images (edit met referentiebeelden) | Black Forest Labs FLUX (Kontext/referentie) | Definitieve keuze na consistentiebenchmark in fase 4. |
| Video (text/image-to-video, 9:16) | Google Veo via Gemini API | Runway (image-to-video met referenties) | Async + polling; scènegewijs. |
| Spraak / voice-over | ElevenLabs (ontworpen synthetische stemmen) | — | **Geen stemklonen** zonder schriftelijke toestemming van de stemhouder. |
| Lip-sync | Te evalueren in fase 6 | — | Alleen als een provider aan kwaliteits- en licentie-eisen voldoet. |
| Moderatie / QC | Claude (vision) met vaste rubric + technische checks (FFmpeg) | — | Zelfde provider als tekst houdt het aantal verwerkers klein. |

## Status fase 4

- **Anthropic Claude** — officiële SDK. Standaard `claude-opus-5-5`, bulk `claude-haiku-5-5`. Thinking staat altijd aan (geen thinking-config meesturen); `effort` per provider instelbaar. Voor niet-Haiku-modellen staat de server-side fallback bij weigeringen aan (`fallbacks: "default"`): als het model weigert, kan een ander Claude-model het verzoek afmaken. Elke poging wordt apart afgerekend (`usage.iterations`) en de UI toont welk model antwoordde. Retries doet BullMQ, niet de SDK.
- **OpenAI Images** — REST (`/v1/images/generations`, met referenties `/v1/images/edits`). Standaardmodel `gpt-image-2` (instelbaar). Volgens openbare bronnen is `gpt-image-1` op 23-10-2026 uitgefaseerd; de officiële documentatie (developers.openai.com) was vanuit de bouwomgeving niet bereikbaar, dus modelnaam, parameters en responsvorm zijn **nog niet live geverifieerd**. De verbindingstest en `pnpm test:live` doen dat zodra er een sleutel is.
- **Black Forest Labs FLUX** — fallbackkandidaat voor beeld; adapter pas na de consistentiebenchmark (fase 10).

## Fallbackbeleid

- Fallback alleen naar een provider met **dezelfde capability** én die de **identiteitsdrempel** van het karakterprofiel haalt (consistentiescore ≥ ingestelde drempel op de canonieke referenties).
- Fallback wordt per creator ingesteld; default is *geen* automatische fallback voor beeld/video (identiteitsrisico), wel voor tekst.
- Een fallback telt mee voor het generatiebudget van het item en wordt in de job vastgelegd (`provider_id`).

## Kosten per provider

- `ai_providers.pricing` bevat per model en eenheid de prijs (micro-EUR) met bron-URL en datum.
- `estimateCost()` gebruikt de **bovengrens** (max tokens, max duur). Rapporteert de provider na afloop het verbruik, dan wordt `MEASURED` geboekt; anders `ESTIMATED` met onzekerheidsnotitie.
- Valutaconversie (USD-prijzen) via een vaste, maandelijks bijgewerkte koers met marge; vermeld in de notitie.

## Mockproviders

`mock-text`, `mock-image` en `mock-video` implementeren hetzelfde contract. Ze:

- staan als `is_mock = true` in het register en zetten `is_mock` op jobs, media, kosten en publicaties;
- produceren deterministische, **zichtbaar gelabelde** output (watermerk "MOCK" in beeld en video);
- kosten aantoonbaar €0 en worden nooit als uitgave geboekt (prijslijst `free`, alleen voor mocks toegestaan);
- worden in de UI altijd met een *Mock*-badge getoond en kunnen niet naar een echt socialmedia-account worden gepubliceerd.

`MOCK_MODE=true` (standaard buiten productie) dwingt alle generatie en publicatie naar mockadapters.

## Socialmediaplatforms (fase 7)

Alleen officiële API's; geen browserautomatisering of scraping. **Instagram is de eerste integratie** (besluit 28-10-2026). Daarvoor is nodig: een Meta-developer-app, Instagram professionele accounts (business/creator) per creator, en goedgekeurde app review voor de publicatiepermissies. Die aanvraag kost doorlooptijd en kan al vóór fase 7 gestart worden.

| Platform | API | Belangrijke beperkingen (te verifiëren in fase 7) |
|---|---|---|
| Instagram | Instagram Graph API — Content Publishing | Alleen professionele (business/creator) accounts; app review voor publicatie-permissies; dagelijkse publicatielimiet per account; container-flow (aanmaken → status → publiceren). |
| TikTok | Content Posting API | App-audit vereist voor openbare *Direct Post*; zonder audit alleen beperkte zichtbaarheid; creator-info opvragen vóór posten. |
| YouTube | YouTube Data API v3 | Upload kost een groot deel van het dagelijkse quotum; uploads van niet-geverifieerde apps kunnen privé blijven tot audit; Shorts = verticale video ≤ 3 min. |

Vóór elke publicatie controleert de adapter de **gekoppelde scopes en capabilities** van het account voor het betreffende contenttype. Ontbreekt iets, dan wordt de job `NEEDS_MANUAL_ACTION` met een ondersteund alternatief: een exportpakket (media + caption + checklist) voor handmatige publicatie via de officiële app.

**AI-labeling** — waar een platform een API-veld voor AI-/synthetische content biedt, wordt het gezet; daarnaast staat een disclosure in de caption (`content_items.ai_disclosure`, standaard aan). Dit sluit ook aan op de transparantieverplichtingen voor synthetische content onder de EU AI-verordening.
