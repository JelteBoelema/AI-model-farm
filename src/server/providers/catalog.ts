// Provider catalog: which AI services the farm knows about and how their credentials are referenced.
// A provider only becomes ACTIVE when its adapter is implemented AND its credential resolves.
// Nothing here calls a provider; real adapters are added in phase 4 (text/image) and 6 (video).

import type { ProviderCapability, ProviderStatus } from "@prisma/client";
import { db } from "../db";
import { isSecretConfigured } from "../secrets";

export interface CatalogEntry {
  key: string;
  displayName: string;
  capabilities: ProviderCapability[];
  credentialRef: string | null;
  isMock: boolean;
  /** Phase in which the adapter ships; `null` once implemented. */
  adapterPhase: number | null;
  priority: number;
  rationale: string;
}

export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    key: "anthropic",
    displayName: "Anthropic Claude",
    capabilities: ["TEXT", "MODERATION"],
    credentialRef: "env:ANTHROPIC_API_KEY",
    isMock: false,
    adapterPhase: 4,
    priority: 10,
    rationale: "Creator wizard, scripts, storyboard reasoning and QC review; smaller Claude models for bulk captions.",
  },
  {
    key: "openai-images",
    displayName: "OpenAI Images",
    capabilities: ["IMAGE"],
    credentialRef: "env:OPENAI_API_KEY",
    isMock: false,
    adapterPhase: 4,
    priority: 20,
    rationale: "Image generation and reference-image editing for character consistency.",
  },
  {
    key: "bfl-flux",
    displayName: "Black Forest Labs FLUX",
    capabilities: ["IMAGE"],
    credentialRef: "env:BFL_API_KEY",
    isMock: false,
    adapterPhase: 4,
    priority: 30,
    rationale: "Candidate photoreal provider with reference-conditioned editing; evaluated against identity tests.",
  },
  {
    key: "google-veo",
    displayName: "Google Veo (Gemini API)",
    capabilities: ["VIDEO"],
    credentialRef: "env:GOOGLE_GENAI_API_KEY",
    isMock: false,
    adapterPhase: 6,
    priority: 20,
    rationale: "Text/image-to-video with native audio, vertical output.",
  },
  {
    key: "runway",
    displayName: "Runway",
    capabilities: ["VIDEO"],
    credentialRef: "env:RUNWAY_API_KEY",
    isMock: false,
    adapterPhase: 6,
    priority: 30,
    rationale: "Image-to-video with reference images; fallback video provider.",
  },
  {
    key: "elevenlabs",
    displayName: "ElevenLabs",
    capabilities: ["SPEECH"],
    credentialRef: "env:ELEVENLABS_API_KEY",
    isMock: false,
    adapterPhase: 6,
    priority: 20,
    rationale: "Synthetic voices for voice-over (designed voices only; no cloning without consent).",
  },
  {
    key: "mock-text",
    displayName: "Mock text provider",
    capabilities: ["TEXT", "MODERATION"],
    credentialRef: null,
    isMock: true,
    adapterPhase: 4,
    priority: 900,
    rationale: "Deterministic output for tests and mock mode. Never presented as real content.",
  },
  {
    key: "mock-image",
    displayName: "Mock image provider",
    capabilities: ["IMAGE"],
    credentialRef: null,
    isMock: true,
    adapterPhase: 4,
    priority: 900,
    rationale: "Generates labelled placeholder images for the full pipeline in mock mode.",
  },
  {
    key: "mock-video",
    displayName: "Mock video provider",
    capabilities: ["VIDEO", "SPEECH", "LIPSYNC"],
    credentialRef: null,
    isMock: true,
    adapterPhase: 6,
    priority: 900,
    rationale: "FFmpeg-rendered, watermarked test clips for the video pipeline in mock mode.",
  },
];

export interface ProviderStatusDetail {
  status: ProviderStatus;
  credentialPresent: boolean | null;
  adapterReady: boolean;
  reason: string;
}

export async function evaluateProvider(entry: CatalogEntry): Promise<ProviderStatusDetail> {
  const credentialPresent = entry.credentialRef ? await isSecretConfigured(entry.credentialRef) : null;
  const adapterReady = entry.adapterPhase === null;
  if (!adapterReady)
    return { status: "NOT_CONFIGURED", credentialPresent, adapterReady, reason: `Adapter ships in phase ${entry.adapterPhase}` };
  if (credentialPresent === false)
    return { status: "NOT_CONFIGURED", credentialPresent, adapterReady, reason: `Credential ${entry.credentialRef} is not set` };
  return { status: "ACTIVE", credentialPresent, adapterReady, reason: entry.isMock ? "Mock adapter" : "Configured" };
}

/** Upsert catalog rows and recompute status. Admin-set DISABLED is preserved. */
export async function syncProviderRegistry(): Promise<void> {
  for (const entry of PROVIDER_CATALOG) {
    const detail = await evaluateProvider(entry);
    const existing = await db.aiProvider.findUnique({ where: { key: entry.key }, select: { status: true } });
    const status = existing?.status === "DISABLED" ? "DISABLED" : detail.status;
    await db.aiProvider.upsert({
      where: { key: entry.key },
      create: {
        key: entry.key,
        displayName: entry.displayName,
        capabilities: entry.capabilities,
        credentialRef: entry.credentialRef,
        isMock: entry.isMock,
        priority: entry.priority,
        status,
      },
      update: {
        displayName: entry.displayName,
        capabilities: entry.capabilities,
        credentialRef: entry.credentialRef,
        isMock: entry.isMock,
        status,
      },
    });
  }
}
