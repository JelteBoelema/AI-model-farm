// Provider catalog: which AI services the farm knows about, how their credentials are referenced and
// their default configuration. Readiness (and therefore ACTIVE status) is decided in registry.ts.

import type { ProviderCapability } from "@prisma/client";
import { ANTHROPIC_BULK_MODEL, ANTHROPIC_DEFAULT_MODEL } from "./adapters/anthropic";
import { ELEVENLABS_DEFAULT_MODEL } from "./adapters/elevenlabs";
import { VEO_DEFAULT_MODEL } from "./adapters/google-veo";
import { OPENAI_IMAGE_DEFAULT_MODEL } from "./adapters/openai-images";

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
  /** Initial ai_providers.config; admins change it afterwards. */
  defaultConfig?: Record<string, unknown>;
}

const MOCK_CONFIG = { model: "mock", maxRequestsPerMinute: 600, timeoutMs: 30_000 };

export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    key: "anthropic",
    displayName: "Anthropic Claude",
    capabilities: ["TEXT", "MODERATION"],
    credentialRef: "env:ANTHROPIC_API_KEY",
    isMock: false,
    adapterPhase: null,
    priority: 10,
    rationale: "Creator wizard, scripts, storyboard reasoning and QC review; Claude Haiku for bulk captions.",
    defaultConfig: { model: ANTHROPIC_DEFAULT_MODEL, bulkModel: ANTHROPIC_BULK_MODEL, effort: "medium", maxRequestsPerMinute: 50, timeoutMs: 120_000 },
  },
  {
    key: "openai-images",
    displayName: "OpenAI Images",
    capabilities: ["IMAGE"],
    credentialRef: "env:OPENAI_API_KEY",
    isMock: false,
    adapterPhase: null,
    priority: 20,
    rationale: "Image generation; edits with the canonical reference images for character consistency.",
    defaultConfig: { model: OPENAI_IMAGE_DEFAULT_MODEL, imageSize: "1024x1536", imageQuality: "medium", maxRequestsPerMinute: 10, timeoutMs: 180_000 },
  },
  {
    key: "bfl-flux",
    displayName: "Black Forest Labs FLUX",
    capabilities: ["IMAGE"],
    credentialRef: "env:BFL_API_KEY",
    isMock: false,
    adapterPhase: 10,
    priority: 30,
    rationale: "Fallback candidate with reference-conditioned editing; adapter only if it passes the identity benchmark.",
  },
  {
    key: "google-veo",
    displayName: "Google Veo (Gemini API)",
    capabilities: ["VIDEO"],
    credentialRef: "env:GOOGLE_GENAI_API_KEY",
    isMock: false,
    adapterPhase: null,
    priority: 20,
    rationale: "Scene clips (text-to-video with character reference images), vertical 9:16, long-running jobs.",
    defaultConfig: { model: VEO_DEFAULT_MODEL, maxRequestsPerMinute: 10, timeoutMs: 120_000 },
  },
  {
    key: "runway",
    displayName: "Runway",
    capabilities: ["VIDEO"],
    credentialRef: "env:RUNWAY_API_KEY",
    isMock: false,
    adapterPhase: 10,
    priority: 30,
    rationale: "Fallback video provider candidate; adapter only after the consistency benchmark.",
  },
  {
    key: "elevenlabs",
    displayName: "ElevenLabs",
    capabilities: ["SPEECH"],
    credentialRef: "env:ELEVENLABS_API_KEY",
    isMock: false,
    adapterPhase: null,
    priority: 20,
    rationale: "Synthetic voices for voice-over (designed voices only; no cloning without consent).",
    defaultConfig: { model: ELEVENLABS_DEFAULT_MODEL, maxRequestsPerMinute: 30, timeoutMs: 60_000 },
  },
  {
    key: "mock-text",
    displayName: "Mock text provider",
    capabilities: ["TEXT", "MODERATION"],
    credentialRef: null,
    isMock: true,
    adapterPhase: null,
    priority: 900,
    rationale: "Deterministic output for tests and mock mode. Never presented as real content.",
    defaultConfig: MOCK_CONFIG,
  },
  {
    key: "mock-image",
    displayName: "Mock image provider",
    capabilities: ["IMAGE"],
    credentialRef: null,
    isMock: true,
    adapterPhase: null,
    priority: 900,
    rationale: "Watermarked placeholder images (\"MOCK\") for the full pipeline in mock mode.",
    defaultConfig: MOCK_CONFIG,
  },
  {
    key: "mock-video",
    displayName: "Mock video provider",
    capabilities: ["VIDEO", "SPEECH"],
    credentialRef: null,
    isMock: true,
    adapterPhase: null,
    priority: 900,
    rationale: "FFmpeg-rendered, watermarked test clips and beeping placeholder voices for the video pipeline in mock mode.",
    defaultConfig: { ...MOCK_CONFIG, timeoutMs: 60_000 },
  },
];

