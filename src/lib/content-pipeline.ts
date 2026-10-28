// Content Factory pipeline definition: which steps a format runs, what each step asks a model for,
// and the technical quality checks. Pure module (no database), shared by services, worker and UI.

import type { ContentFormat, ContentStatus, PromptKind } from "@prisma/client";
import { z } from "zod";

export const PIPELINE_STEPS = ["brief", "script", "caption", "image", "voice", "scene", "assemble", "qc"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_LABELS: Record<PipelineStep, string> = {
  brief: "Brief",
  script: "Shot list",
  caption: "Caption",
  image: "Images",
  voice: "Voice-over",
  scene: "Scenes",
  assemble: "Assembly",
  qc: "Quality control",
};

/** Steps shown for a format, in order. */
export function stepsFor(kind: FormatKind): PipelineStep[] {
  return kind === "video" ? ["brief", "script", "caption", "voice", "scene", "assemble", "qc"] : ["brief", "script", "caption", "image", "qc"];
}

export const stepLabel = (step: PipelineStep, kind: FormatKind) => (step === "script" && kind === "video" ? "Storyboard" : STEP_LABELS[step]);

export type FormatKind = "photo" | "video";

interface BaseSpec {
  label: string;
  aspectRatio: "1:1" | "4:5" | "9:16";
  /** Photos or scenes per item. */
  minShots: number;
  maxShots: number;
  defaultShots: number;
}

export interface PhotoSpec extends BaseSpec {
  kind: "photo";
  /** Provider output size; the publishing step crops to the platform aspect ratio. */
  size: "1024x1024" | "1024x1536" | "1536x1024";
}

export interface VideoSpec extends BaseSpec {
  kind: "video";
  /** Clip lengths a scene may have (what the video providers accept). */
  sceneSeconds: readonly number[];
  maxTotalSeconds: number;
}

export type FormatSpec = PhotoSpec | VideoSpec;

/**
 * Formats the factory can produce. Talking-head videos need a lip-sync provider, which has not
 * passed evaluation yet, so they can be planned but not produced.
 */
export const FORMAT_SPECS: Partial<Record<ContentFormat, FormatSpec>> = {
  IMAGE_POST: { kind: "photo", label: "Image post", size: "1024x1536", aspectRatio: "4:5", minShots: 1, maxShots: 1, defaultShots: 1 },
  CAROUSEL: { kind: "photo", label: "Carousel", size: "1024x1024", aspectRatio: "1:1", minShots: 2, maxShots: 6, defaultShots: 3 },
  STORY: { kind: "photo", label: "Story", size: "1024x1536", aspectRatio: "9:16", minShots: 1, maxShots: 1, defaultShots: 1 },
  SHORT_VIDEO: { kind: "video", label: "Short video", aspectRatio: "9:16", minShots: 2, maxShots: 5, defaultShots: 3, sceneSeconds: [4, 6, 8], maxTotalSeconds: 60 },
};

export const isProducible = (format: ContentFormat) => FORMAT_SPECS[format] !== undefined;

/** Which step continues an item in this status (null: nothing to run automatically). */
export function stepForStatus(status: ContentStatus, kind: FormatKind = "photo"): PipelineStep | null {
  switch (status) {
    case "IDEA":
      return "brief";
    case "BRIEFED":
      return "script";
    case "SCRIPTED":
      return "caption";
    case "PROMPTED":
      return kind === "video" ? "scene" : "image";
    default:
      return null;
  }
}

/** Templates per step: resolved by kind, preferring templates whose key starts with the prefix. */
export type TemplatedStep = "brief" | "script" | "caption" | "image" | "scene" | "qc";
export const STEP_TEMPLATES: Record<TemplatedStep, { kind: PromptKind; keyPrefix: string }> = {
  brief: { kind: "IDEATION", keyPrefix: "brief." },
  script: { kind: "SCRIPT", keyPrefix: "script.photo" },
  caption: { kind: "CAPTION", keyPrefix: "caption." },
  image: { kind: "IMAGE", keyPrefix: "image." },
  scene: { kind: "VIDEO", keyPrefix: "video." },
  qc: { kind: "QUALITY_RULES", keyPrefix: "qc." },
};

/** Template for a step and format (video storyboards use the short-video script templates). */
export function stepTemplate(step: TemplatedStep, kind: FormatKind) {
  return step === "script" && kind === "video" ? { kind: "SCRIPT" as const, keyPrefix: "script.short_video" } : STEP_TEMPLATES[step];
}

export type TextStep = "brief" | "script" | "caption" | "qc";

/** Text steps: output budget, effort and whether the cheaper bulk model is good enough. */
export const TEXT_STEP_SETTINGS: Record<TextStep, { maxOutputTokens: number; effort: "low" | "medium"; bulk: boolean }> = {
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

export const storyboardOutput = z.object({
  scenes: z
    .array(
      z.object({
        visual: z.string().min(1).max(600),
        action: z.string().max(300),
        duration_seconds: z.number().int().min(1).max(20),
        voiceover: z.string().max(240),
        on_screen_text: z.string().max(80),
      }),
    )
    .min(1)
    .max(10),
});
export type StoryboardOutput = z.infer<typeof storyboardOutput>;

/** JSON Schema for the storyboard, with the exact number of scenes and the allowed clip lengths. */
export function storyboardSchema(scenes: number, seconds: readonly number[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["scenes"],
    properties: {
      scenes: {
        type: "array",
        minItems: scenes,
        maxItems: scenes,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["visual", "action", "duration_seconds", "voiceover", "on_screen_text"],
          properties: {
            visual: { type: "string", maxLength: 600 },
            action: { type: "string", maxLength: 300 },
            duration_seconds: { type: "integer", enum: [...seconds] },
            voiceover: { type: "string", maxLength: 240 },
            on_screen_text: { type: "string", maxLength: 80 },
          },
        },
      },
    },
  };
}

const str = (maxLength: number) => ({ type: "string", maxLength });
export const STEP_JSON_SCHEMAS: Record<TextStep, Record<string, unknown>> = {
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

export const STEP_OUTPUTS = { brief: briefOutput, script: scriptOutput, caption: captionOutput, qc: qcOutput, storyboard: storyboardOutput } as const;

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

export function technicalChecks(facts: ImageFacts, spec: Pick<PhotoSpec, "size">): TechnicalCheck[] {
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

// ── Subtitles ──

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_LINE = 42;

function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > MAX_LINE) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Subtitle cues from the voice-over per scene: at most two lines of 42 characters per cue, spread
 * over the scene in proportion to their length, never crossing into the next scene.
 */
export function buildCues(scenes: { startMs: number; durationMs: number; text: string }[]): Cue[] {
  const cues: Cue[] = [];
  for (const scene of scenes) {
    const lines = wrap(scene.text.trim());
    if (lines.length === 0) continue;
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i += 2) blocks.push(lines.slice(i, i + 2).join("\n"));
    const total = blocks.reduce((n, b) => n + b.length, 0);
    let t = scene.startMs;
    for (const b of blocks) {
      const len = Math.round((b.length / total) * scene.durationMs);
      cues.push({ startMs: t, endMs: Math.min(scene.startMs + scene.durationMs, t + len), text: b });
      t += len;
    }
  }
  return cues;
}

const ts = (ms: number, sep: "." | ",") => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};

export const toVtt = (cues: Cue[]) => `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${ts(c.startMs, ".")} --> ${ts(c.endMs, ".")}\n${c.text}`).join("\n\n")}\n`;
export const toSrt = (cues: Cue[]) => `${cues.map((c, i) => `${i + 1}\n${ts(c.startMs, ",")} --> ${ts(c.endMs, ",")}\n${c.text}`).join("\n\n")}\n`;

/** Problems with a cue list: overlaps, empty or out-of-range cues, lines that are too long. */
export function cueProblems(cues: Cue[], totalMs: number): string[] {
  const problems: string[] = [];
  cues.forEach((c, i) => {
    if (c.endMs <= c.startMs) problems.push(`Cue ${i + 1} has no duration`);
    if (c.endMs > totalMs + 1) problems.push(`Cue ${i + 1} ends after the video`);
    if (i > 0 && c.startMs < cues[i - 1]!.endMs) problems.push(`Cue ${i + 1} overlaps the previous one`);
    if (c.text.split("\n").some((l) => l.length > MAX_LINE)) problems.push(`Cue ${i + 1} has a line over ${MAX_LINE} characters`);
    if (c.text.split("\n").length > 2) problems.push(`Cue ${i + 1} has more than two lines`);
  });
  return problems;
}

// ── Technical checks on the assembled video ──

export const VIDEO_TARGET = { width: 1080, height: 1920, fps: 30, maxSeconds: 90, lufs: -14, lufsTolerance: 2, maxTruePeakDb: -1 } as const;

export interface VideoFacts {
  formatName: string;
  durationMs: number;
  sizeBytes: number;
  video: { codec: string; width: number; height: number; fps: number; pixFmt: string } | null;
  audio: { codec: string; sampleRate: number; channels: number } | null;
  loudness: { integratedLufs: number; truePeakDb: number } | null;
  plannedMs: number;
  hasVoice: boolean;
  cueProblems: string[] | null;
  isMock: boolean;
}

export function videoTechnicalChecks(f: VideoFacts): TechnicalCheck[] {
  const v = f.video;
  const checks: TechnicalCheck[] = [
    { check: "Container", severity: "error", ok: f.formatName.includes("mp4"), detail: f.formatName || "unknown" },
    { check: "Video codec", severity: "error", ok: v?.codec === "h264" && v.pixFmt === "yuv420p", detail: v ? `${v.codec} ${v.pixFmt}` : "no video stream" },
    { check: "Resolution", severity: "error", ok: v?.width === VIDEO_TARGET.width && v.height === VIDEO_TARGET.height, detail: v ? `${v.width}×${v.height} (needs ${VIDEO_TARGET.width}×${VIDEO_TARGET.height}, 9:16)` : "—" },
    { check: "Frame rate", severity: "error", ok: !!v && Math.abs(v.fps - VIDEO_TARGET.fps) <= 0.5, detail: v ? `${v.fps.toFixed(2)} fps` : "—" },
    { check: "Duration", severity: "error", ok: Math.abs(f.durationMs - f.plannedMs) <= 500 && f.durationMs <= VIDEO_TARGET.maxSeconds * 1000, detail: `${(f.durationMs / 1000).toFixed(1)} s (planned ${(f.plannedMs / 1000).toFixed(1)} s, max ${VIDEO_TARGET.maxSeconds} s)` },
    { check: "Audio track", severity: "error", ok: f.audio?.codec === "aac", detail: f.audio ? `${f.audio.codec} ${f.audio.sampleRate} Hz ${f.audio.channels} ch` : "no audio stream" },
  ];
  if (f.hasVoice) {
    const l = f.loudness;
    checks.push({
      check: "Loudness",
      severity: "error",
      ok: !!l && Math.abs(l.integratedLufs - VIDEO_TARGET.lufs) <= VIDEO_TARGET.lufsTolerance && l.truePeakDb <= VIDEO_TARGET.maxTruePeakDb,
      detail: l ? `${l.integratedLufs.toFixed(1)} LUFS, true peak ${l.truePeakDb.toFixed(1)} dBTP (target ${VIDEO_TARGET.lufs} ± ${VIDEO_TARGET.lufsTolerance}, peak ≤ ${VIDEO_TARGET.maxTruePeakDb})` : "not measurable",
    });
    checks.push({ check: "Subtitles", severity: "error", ok: f.cueProblems !== null && f.cueProblems.length === 0, detail: f.cueProblems === null ? "missing" : f.cueProblems.length ? f.cueProblems.join("; ") : "Cues valid" });
  }
  checks.push({ check: "Real provider output", severity: "warning", ok: !f.isMock, detail: f.isMock ? "Mock video: can never be published to a real account" : "Generated by real providers" });
  return checks;
}
