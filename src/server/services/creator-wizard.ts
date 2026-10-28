// Briefing wizard: turns a creative brief into a proposed creator profile and character draft that
// the operator reviews and edits before anything is saved. Until the text-provider adapters ship
// (phase 4) the only generator is a deterministic mock, and every proposal says so.

import { createHash, randomUUID } from "node:crypto";
import type { AiProvider } from "@prisma/client";
import {
  CONTENT_FORMATS,
  creatorBriefSchema,
  creatorProfileSchema,
  characterDraftSchema,
  type CharacterDraftInput,
  type CreatorProfileInput,
} from "@/lib/schemas/creator";
import { can } from "@/lib/rbac";
import { recordAudit } from "../audit";
import { env } from "../env";
import { DomainError } from "../errors";
import { selectProvider, type ProviderConfig } from "../providers/registry";
import { executeGeneration } from "./generation";
import type { ActingUser } from "./users";

export interface CreatorProposal {
  profile: CreatorProfileInput;
  character: CharacterDraftInput;
  source: { generator: string; isMock: boolean };
}

export interface CreatorProposalGenerator {
  readonly key: string;
  readonly isMock: boolean;
  propose(input: { brief: string; language: string; regions: string[] }): Promise<Omit<CreatorProposal, "source">>;
}

const MOCK_NAMES = ["Noor Vale", "Sem Rivers", "Lio Marén", "Ivy Calder", "Juno Brandt", "Kai Lumen", "Mara Elst", "Teo Nyland"];

function firstSentence(text: string, max: number) {
  const s = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? text;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Deterministic placeholder generator. Its output is visibly a template, never presented as AI work. */
export const mockProposalGenerator: CreatorProposalGenerator = {
  key: "mock-text",
  isMock: true,
  async propose({ brief, language, regions }) {
    const hash = createHash("sha256").update(brief).digest();
    const name = MOCK_NAMES[hash[0]! % MOCK_NAMES.length]!;
    const summary = firstSentence(brief, 150);
    return {
      profile: {
        name,
        niche: summary.length >= 3 ? summary : "Lifestyle",
        targetAudience: `[Mock] Audience derived from the brief: ${firstSentence(brief, 200)}`,
        language,
        targetRegions: regions.length ? regions : ["NL"],
        personality: "[Mock] Curious, warm and practical. Replace with the real personality.",
        toneOfVoice: "[Mock] Friendly, concise, first person.",
        backstory: `[Mock] ${name} is a fictional character created for this brief: ${firstSentence(brief, 300)}`,
        contentPillars: [
          { name: "How-to", description: "Practical tips related to the niche" },
          { name: "Behind the scenes", description: "The character's (fictional) daily routine" },
          { name: "Weekly picks", description: "Curated recommendations" },
        ],
        contentFormats: ["IMAGE_POST", "CAROUSEL", "SHORT_VIDEO"],
        timezone: "Europe/Amsterdam",
        publishingSchedule: {
          slots: [
            { platform: "INSTAGRAM", weekday: 2, time: "18:00" },
            { platform: "INSTAGRAM", weekday: 4, time: "18:00" },
            { platform: "INSTAGRAM", weekday: 6, time: "11:00" },
          ],
        },
      },
      character: {
        appearance: {
          ageRange: "25-30",
          build: "[Mock] average",
          skinTone: "",
          hair: "",
          eyes: "",
          face: "",
          distinguishingFeatures: "",
          wardrobe: "",
        },
        identityPrompt: `[Mock] Synthetic adult character "${name}", consistent facial features across images, natural styling.`,
        negativePrompt: "resemblance to real or famous people, minors, text artifacts",
        consistencyStrategy: { referenceWeight: 0.8, seed: null, notes: "" },
      },
    };
  },
};

const SYSTEM_PROMPT = `You design fictional virtual creators for a social media studio.
Rules: the creator is an adult, entirely fictional, and must not resemble, imitate or be named after a real or famous person.
Write every text field in the language given by the language tag. Be specific and practical; avoid clichés.
The identityPrompt describes the creator's stable visual identity for image generation (face, hair, build, style) in English.
The negativePrompt lists what images must avoid.`;

const textField = { type: "string" } as const;
const PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "niche", "targetAudience", "personality", "toneOfVoice", "backstory", "contentPillars", "contentFormats", "appearance", "identityPrompt", "negativePrompt"],
  properties: {
    name: textField,
    niche: textField,
    targetAudience: textField,
    personality: textField,
    toneOfVoice: textField,
    backstory: textField,
    contentPillars: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "description"], properties: { name: textField, description: textField } },
    },
    contentFormats: { type: "array", items: { type: "string", enum: [...CONTENT_FORMATS] } },
    appearance: {
      type: "object",
      additionalProperties: false,
      required: ["ageRange", "build", "skinTone", "hair", "eyes", "face", "distinguishingFeatures", "wardrobe"],
      properties: { ageRange: textField, build: textField, skinTone: textField, hair: textField, eyes: textField, face: textField, distinguishingFeatures: textField, wardrobe: textField },
    },
    identityPrompt: textField,
    negativePrompt: textField,
  },
} as const;

interface LlmProposal {
  name: string;
  niche: string;
  targetAudience: string;
  personality: string;
  toneOfVoice: string;
  backstory: string;
  contentPillars: { name: string; description: string }[];
  contentFormats: (typeof CONTENT_FORMATS)[number][];
  appearance: CharacterDraftInput["appearance"];
  identityPrompt: string;
  negativePrompt: string;
}

/** Uses the configured text provider (Claude) with structured JSON output. */
function providerGenerator(provider: AiProvider, config: ProviderConfig): CreatorProposalGenerator {
  return {
    key: provider.key,
    isMock: provider.isMock,
    async propose({ brief, language, regions }) {
      const exec = await executeGeneration({
        provider,
        config,
        request: {
          capability: "TEXT",
          model: config.model ?? "",
          system: SYSTEM_PROMPT,
          prompt: `Language tag: ${language}\nTarget regions: ${regions.join(", ")}\n\nCreative brief:\n${brief}`,
          maxOutputTokens: 8_000,
          jsonSchema: PROPOSAL_JSON_SCHEMA as unknown as Record<string, unknown>,
          params: { effort: "low" },
        },
        attribution: {},
        ledgerKey: `creator-wizard:${randomUUID()}`,
        purpose: "creator_wizard",
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 110_000)),
      });
      let data: LlmProposal;
      try {
        data = JSON.parse(exec.result.outputs[0]?.text ?? "") as LlmProposal;
      } catch {
        throw new DomainError("The provider returned an unreadable proposal; try again");
      }
      const clip = (v: string, max: number) => (v ?? "").trim().slice(0, max);
      return {
        profile: {
          name: clip(data.name, 60),
          niche: clip(data.niche, 160),
          targetAudience: clip(data.targetAudience, 280),
          language,
          targetRegions: regions.length ? regions : ["NL"],
          personality: clip(data.personality, 500),
          toneOfVoice: clip(data.toneOfVoice, 280),
          backstory: clip(data.backstory, 2000),
          contentPillars: data.contentPillars.slice(0, 8).map((p) => ({ name: clip(p.name, 60), description: clip(p.description, 280) })),
          contentFormats: [...new Set(data.contentFormats)],
          timezone: "Europe/Amsterdam",
          publishingSchedule: {
            slots: [
              { platform: "INSTAGRAM", weekday: 2, time: "18:00" },
              { platform: "INSTAGRAM", weekday: 4, time: "18:00" },
              { platform: "INSTAGRAM", weekday: 6, time: "11:00" },
            ],
          },
        },
        character: {
          appearance: data.appearance,
          identityPrompt: clip(data.identityPrompt, 2000),
          negativePrompt: clip(data.negativePrompt, 1000),
          consistencyStrategy: { referenceWeight: 0.8, seed: null, notes: "" },
        },
      };
    },
  };
}

/** Mock mode uses the deterministic mock; otherwise the selected text provider (never a silent mock). */
export async function getProposalGenerator(): Promise<CreatorProposalGenerator> {
  if (env().MOCK_MODE) return mockProposalGenerator;
  const { row, config } = await selectProvider("TEXT");
  return providerGenerator(row, config);
}

export async function proposeCreator(by: ActingUser, raw: unknown, generatorOverride?: CreatorProposalGenerator): Promise<CreatorProposal> {
  if (!can(by.role, "creators:edit")) throw new DomainError("You do not have permission for this action.");
  const input = creatorBriefSchema.parse(raw);
  const generator = generatorOverride ?? (await getProposalGenerator());
  const out = await generator.propose(input);
  // Never trust generator output: it must satisfy the same schemas as manual input.
  const proposal: CreatorProposal = {
    profile: creatorProfileSchema.parse(out.profile),
    character: characterDraftSchema.parse(out.character),
    source: { generator: generator.key, isMock: generator.isMock },
  };
  await recordAudit(by.actor, { action: "creator.proposal_generated", metadata: { generator: generator.key, isMock: generator.isMock, briefLength: input.brief.length } });
  return proposal;
}
