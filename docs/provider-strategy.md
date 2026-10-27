# Providerstrategie

Alle AI-diensten zitten achter één contract: `ProviderAdapter` in `src/server/providers/types.ts`. De Content Factory kent geen vendor-SDK's. Providers staan in het register (`ai_providers`, beheer via **AI Providers**) en zijn pas bruikbaar als **(1)** de adapter bestaat, **(2)** de credential via de secrets store resolveert en **(3)** er een prijstabel is. Ontbreekt één van de drie, dan is de status `NOT_CONFIGURED` en wordt er niets betaald uitgevoerd.

> **Let op:** providerlandschap, modellen, prijzen en API-voorwaarden veranderen snel. De kandidaten hieronder zijn gebaseerd op de kennis bij het schrijven en worden in fase 4/6/7 **opnieuw geverifieerd** tegen de actuele documentatie, prijslijsten en licentievoorwaarden voordat er een adapter wordt gebouwd. Prijzen worden nooit uit dit document overgenomen, alleen uit de officiële prijslijst op het moment van integratie.

## Adaptercontract

```ts
interface ProviderAdapter {
  key: string; isMock: boolean;
  discoverCapabilities(signal): Promise<ModelCapability[]>; // modellen, ratio's, max duur, referenties, commercieel gebruik
  validate(request): void;                                  // gooit invalid_input vóór er geld wordt uitgegeven
  estimateCost(request): Promise<CostEstimate>;              // maxMicros: bigint | null  (null = onbekend ⇒ blokkeren)
  submit(request, signal): Promise<GenerationStatus>;        // async: pending + providerJobId
  getStatus(providerJobId, signal): Promise<GenerationStatus>; // polling, ook om timeouts op te lossen
  cancel?(providerJobId): Promise<void>;
}
```

Foutclassificatie (`ProviderError.kind`) bepaalt het gedrag van de worker:

| Soort | Gedrag |
|---|---|
| `invalid_input`, `content_policy` | niet opnieuw proberen; item naar review |
| `rate_limited` | vertragen met `retryAfterMs`, telt niet als mislukte poging |
| `transient` | retry met jitter-backoff |
| `timeout` | **eerst `getStatus()`**, pas daarna eventueel opnieuw indienen |
| `auth`, `quota_exceeded` | provider automatisch pauzeren (`control_switch`) + melding |

Elke adapterimplementatie krijgt contracttests die met opgenomen (geanonimiseerde) responses draaien, plus een opt-in live smoketest (`LIVE_PROVIDER_TESTS=1`) die nooit in CI draait.

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

## Fallbackbeleid

- Fallback alleen naar een provider met **dezelfde capability** én die de **identiteitsdrempel** van het karakterprofiel haalt (consistentiescore ≥ ingestelde drempel op de canonieke referenties).
- Fallback wordt per creator ingesteld; default is *geen* automatische fallback voor beeld/video (identiteitsrisico), wel voor tekst.
- Een fallback telt mee voor het generatiebudget van het item en wordt in de job vastgelegd (`provider_id`).

## Kosten per provider

- `ai_providers.pricing` bevat per model en eenheid de prijs (micro-EUR) met bron-URL en datum.
- `estimateCost()` gebruikt de **bovengrens** (max tokens, max duur). Rapporteert de provider na afloop het verbruik, dan wordt `PROVIDER_REPORTED` geboekt; anders `ESTIMATED` met onzekerheidsnotitie.
- Valutaconversie (USD-prijzen) via een vaste, maandelijks bijgewerkte koers met marge; vermeld in de notitie.

## Mockproviders

`mock-text`, `mock-image` en `mock-video` implementeren hetzelfde contract. Ze:

- staan als `is_mock = true` in het register en zetten `is_mock` op jobs, media, kosten en publicaties;
- produceren deterministische, **zichtbaar gelabelde** output (watermerk "MOCK" in beeld en video);
- boeken mockkosten apart, zodat het budgetmechanisme volledig testbaar is zonder echte uitgaven;
- worden in de UI altijd met een *Mock*-badge getoond en kunnen niet naar een echt socialmedia-account worden gepubliceerd.

`MOCK_MODE=true` (standaard buiten productie) dwingt alle generatie en publicatie naar mockadapters.

## Socialmediaplatforms (fase 7)

Alleen officiële API's; geen browserautomatisering of scraping.

| Platform | API | Belangrijke beperkingen (te verifiëren in fase 7) |
|---|---|---|
| Instagram | Instagram Graph API — Content Publishing | Alleen professionele (business/creator) accounts; app review voor publicatie-permissies; dagelijkse publicatielimiet per account; container-flow (aanmaken → status → publiceren). |
| TikTok | Content Posting API | App-audit vereist voor openbare *Direct Post*; zonder audit alleen beperkte zichtbaarheid; creator-info opvragen vóór posten. |
| YouTube | YouTube Data API v3 | Upload kost een groot deel van het dagelijkse quotum; uploads van niet-geverifieerde apps kunnen privé blijven tot audit; Shorts = verticale video ≤ 3 min. |

Vóór elke publicatie controleert de adapter de **gekoppelde scopes en capabilities** van het account voor het betreffende contenttype. Ontbreekt iets, dan wordt de job `NEEDS_MANUAL_ACTION` met een ondersteund alternatief: een exportpakket (media + caption + checklist) voor handmatige publicatie via de officiële app.

**AI-labeling** — waar een platform een API-veld voor AI-/synthetische content biedt, wordt het gezet; daarnaast staat een disclosure in de caption (`content_items.ai_disclosure`, standaard aan). Dit sluit ook aan op de transparantieverplichtingen voor synthetische content onder de EU AI-verordening.
