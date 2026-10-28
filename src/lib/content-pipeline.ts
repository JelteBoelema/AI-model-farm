// Content Factory pipeline definition: which steps a format runs, what each step asks a model for,
// and the technical quality checks. Pure module (no database), shared by services, worker and UI.

import type { ContentFormat, ContentStatus, PromptKind } from "@prisma/client";
import { z } from "zod";

export const PIPELINE_STEPS = ["brief", "script", "caption", "image", "qc"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_LABELS: Record<PipelineStep, string> = {
  brief: "Brief",
  script: "Shot list",
  caption: "Caption",
  image: "Images",
  qc: "Quality control",
};

/** Formats the factory can produce now. Video formats follow with the video engine (phase 6). */
export interface FormatSpec {
  label: string;
  /** Provider output size; the publishing step crops to the platform aspect ratio. */
  size: "1024x1024" | "1024x1536" | "1536x1024";
  aspectRatio: "1:1" | "4:5" | "9:16";
  minShots: number;
  maxShots: number;
  defaultShots: number;
}

export const PHOTO_FORMATS: Partial<Record<ContentFormat, FormatSpec>> = {
  IMAGE_POST: { label: "Image post", size: "1024x1536", aspectRatio: "4:5", minShots: 1, maxShots: 1, defaultShots: 1 },
  CAROUSEL: { label: "Carousel", size: "1024x1024", aspectRatio: "1:1", minShots: 2, maxShots: 6, defaultShots: 3 },
  STORY: { label: "Story", size: "1024x1536", aspectRatio: "9:16", minShots: 1, maxShots: 1, defaultShots: 1 },
};

export const isProducible = (format: ContentFormat) => PHOTO_FORMATS[format] !== undefined;

/** Which step continues an item in this status (null: nothing to run automatically). */
export function stepForStatus(status: ContentStatus): PipelineStep | null {
  switch (status) {
    case "IDEA":
      return "brief";
    case "BRIEFED":
      return "script";
    case "SCRIPTED":
      return "caption";
    case "PROMPTED":
      return "image";
    default:
      return null;
  }
}

/** Templates per step: resolved by kind, preferring templates whose key starts with the prefix. */
export const STEP_TEMPLATES: Record<PipelineStep, { kind: PromptKind; keyPrefix: string }> = {
  brief: { kind: "IDEATION", keyPrefix: "brief." },
  script: { kind: "SCRIPT", keyPrefix: "script.photo" },
  caption: { kind: "CAPTION", keyPrefix: "caption." },
  image: { kind: "IMAGE", keyPrefix: "image." },
  qc: { kind: "QUALITY_RULES", keyPrefix: "qc." },
};

/** Text steps: output budget, effort and whether the cheaper bulk model is good enough. */
export const TEXT_STEP_SETTINGS: Record<Exclude<PipelineStep, "image">, { maxOutputTokens: number; effort: "low" | "medium"; bulk: boolean }> = {
  brief: { maxOutputTokens: 8_000, effort: "medium", bulk: false },
  script: { maxOutputTokens: 8_000, effort: "medium", bulk: false },
  caption: { maxOutputTokens: 4_000, effort: "low", bulk: true },
  qc: { maxOutputTokens: 8_000, effort: "medium", bulk: false },
};

// ── Step outputs: JSON Schema sent to the model, Zod to validate what comes back ──

export const briefOutput = z.object({
  angle: z.string().min(1).max(500),
  hook: z.string().min(1).max(300),
  key_message: z.string().min(1).max(500),
  visual_direction: z.string().min(1).max(800),
  pillar: z.string().max(120),
});
export type BriefOutput = z.infer<typeof briefOutput>;

export const scriptOutput = z.object({
  shots: z
    .array(z.object({ scene: z.string().min(1).max(600), purpose: z.string().max(300) }))
    .min(1)
    .max(10),
});
export type ScriptOutput = z.infer<typeof scriptOutput>;

export const captionOutput = z.object({
  caption: z.string().min(1).max(2200),
  hashtags: z.array(z.string().min(1).max(60)).max(30),
});
export type CaptionOutput = z.infer<typeof captionOutput>;

export const qcOutput = z.object({
  score: z.number().int().min(0).max(100),
  pass: z.boolean(),
  identity_consistent: z.boolean(),
  issues: z
    .array(z.object({ severity: z.enum(["warning", "error"]), shot: z.number().int().min(0), message: z.string().min(1).max(500) }))
    .max(30),
  summary: z.string().max(1000),
});
export type QcOutput = z.infer<typeof qcOutput>;

const str = (maxLength: number) => ({ type: "string", maxLength });
export const STEP_JSON_SCHEMAS: Record<Exclude<PipelineStep, "image">, Record<string, unknown>> = {
  brief: {
    type: "object",
    additionalProperties: false,
    required: ["angle", "hook", "key_message", "visual_direction", "pillar"],
    properties: { angle: str(500), hook: str(300), key_message: str(500), visual_direction: str(800), pillar: str(120) },
  },
  script: {
    type: "object",
    additionalProperties: false,
    required: ["shots"],
    properties: {
      shots: {
        type: "array",
        minItems: 1,
        items: { type: "object", additionalProperties: false, required: ["scene", "purpose"], properties: { scene: str(600), purpose: str(300) } },
      },
    },
  },
  caption: {
    type: "object",
    additionalProperties: false,
    required: ["caption", "hashtags"],
    properties: { caption: str(2200), hashtags: { type: "array", items: str(60) } },
  },
  qc: {
    type: "object",
    additionalProperties: false,
    required: ["score", "pass", "identity_consistent", "issues", "summary"],
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      pass: { type: "boolean" },
      identity_consistent: { type: "boolean" },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "shot", "message"],
          properties: { severity: { type: "string", enum: ["warning", "error"] }, shot: { type: "integer", minimum: 0 }, message: str(500) },
        },
      },
      summary: str(1000),
    },
  },
};

export const STEP_OUTPUTS = { brief: briefOutput, script: scriptOutput, caption: captionOutput, qc: qcOutput } as const;

/** Minimum rubric score for automatic promotion to READY; anything below waits for a human. */
export const QC_PASS_SCORE = 70;

// ── Technical checks on generated images ──

export interface TechnicalCheck {
  check: string;
  severity: "error" | "warning";
  ok: boolean;
  detail: string;
}

export interface ImageFacts {
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  isMock: boolean;
  duplicateOf?: string | null;
}

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 30 * 1024 * 1024;

export function technicalChecks(facts: ImageFacts, spec: Pick<FormatSpec, "size">): TechnicalCheck[] {
  const [tw, th] = spec.size.split("x").map(Number) as [number, number];
  const w = facts.width ?? 0;
  const h = facts.height ?? 0;
  const short = Math.min(w, h);
  const ratio = h > 0 ? w / h : 0;
  const target = tw / th;
  return [
    { check: "File type", severity: "error", ok: ALLOWED_TYPES.includes(facts.mimeType), detail: facts.mimeType },
    { check: "File size", severity: "error", ok: facts.sizeBytes > 0 && facts.sizeBytes <= MAX_BYTES, detail: `${(facts.sizeBytes / 1024 / 1024).toFixed(1)} MB (max 30 MB)` },
    { check: "Resolution", severity: "error", ok: short >= 512, detail: `${w}×${h}; shortest side must be ≥ 512 px` },
    { check: "Publishing resolution", severity: "warning", ok: short >= 1024, detail: short >= 1024 ? `${w}×${h}` : `${w}×${h}; below 1024 px, needs upscaling for 1080 px feeds` },
    { check: "Aspect ratio", severity: "error", ok: ratio > 0 && Math.abs(ratio - target) / target <= 0.02, detail: `${ratio.toFixed(3)} vs requested ${target.toFixed(3)} (${spec.size})` },
    { check: "Unique image", severity: "warning", ok: !facts.duplicateOf, detail: facts.duplicateOf ? `Identical to asset ${facts.duplicateOf}` : "No identical asset" },
    { check: "Real provider output", severity: "warning", ok: !facts.isMock, detail: facts.isMock ? "Mock image: can never be published to a real account" : "Generated by a real provider" },
  ];
}

export const technicalPass = (checks: TechnicalCheck[]) => checks.every((c) => c.ok || c.severity === "warning");

/** Adds the AI disclosure when the model left it out (disclosure is on by default per item). */
export function ensureDisclosure(caption: string, disclosure: string): string {
  return caption.toLowerCase().includes(disclosure.toLowerCase()) ? caption : `${caption.trimEnd()}\n\n${disclosure}`;
}

export const AI_DISCLOSURE_TEXT = "Made with AI";
