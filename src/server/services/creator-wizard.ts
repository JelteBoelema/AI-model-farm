// Briefing wizard: turns a creative brief into a proposed creator profile and character draft that
// the operator reviews and edits before anything is saved. Until the text-provider adapters ship
// (phase 4) the only generator is a deterministic mock, and every proposal says so.

import { createHash } from "node:crypto";
import {
  creatorBriefSchema,
  creatorProfileSchema,
  characterDraftSchema,
  type CharacterDraftInput,
  type CreatorProfileInput,
} from "@/lib/schemas/creator";
import { can } from "@/lib/rbac";
import { recordAudit } from "../audit";
import { DomainError } from "../errors";
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

export function getProposalGenerator(): CreatorProposalGenerator {
  return mockProposalGenerator; // phase 4: select the configured text provider from the registry
}

export async function proposeCreator(by: ActingUser, raw: unknown, generator = getProposalGenerator()): Promise<CreatorProposal> {
  if (!can(by.role, "creators:edit")) throw new DomainError("You do not have permission for this action.");
  const input = creatorBriefSchema.parse(raw);
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
