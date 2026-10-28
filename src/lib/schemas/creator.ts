// Validation for creator and character input. Shared by server actions and client forms.

import { z } from "zod";

export const CONTENT_FORMATS = ["IMAGE_POST", "CAROUSEL", "SHORT_VIDEO", "TALKING_HEAD", "STORY"] as const;
export const AUTONOMY_MODES = ["MANUAL", "ASSISTED", "CONTROLLED_AUTONOMY"] as const;
export const SCHEDULE_PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function isKnownRegion(code: string): boolean {
  // "ZZ" is ICU's "Unknown Region"; unassigned codes are echoed back unchanged.
  if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") return false;
  return regionNames.of(code) !== code;
}

export function isKnownTimezone(tz: string): boolean {
  if (tz === "UTC") return true;
  try {
    return Intl.supportedValuesOf("timeZone").includes(tz);
  } catch {
    return false;
  }
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const contentPillarSchema = z.object({
  name: text(2, 60),
  description: text(0, 280).default(""),
});

export const scheduleSlotSchema = z.object({
  platform: z.enum(SCHEDULE_PLATFORMS),
  weekday: z.number().int().min(1).max(7), // ISO weekday, 1 = Monday
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM"),
});

export const publishingScheduleSchema = z
  .object({ slots: z.array(scheduleSlotSchema).max(70).default([]) })
  .refine(
    (s) => new Set(s.slots.map((x) => `${x.platform}|${x.weekday}|${x.time}`)).size === s.slots.length,
    "The schedule contains duplicate slots",
  );

export type PublishingSchedule = z.infer<typeof publishingScheduleSchema>;

export const creatorProfileSchema = z.object({
  name: text(2, 60),
  niche: text(3, 160),
  targetAudience: text(3, 280),
  language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Use a language tag such as nl-NL"),
  targetRegions: z
    .array(z.string().trim().toUpperCase())
    .min(1, "Pick at least one region")
    .max(20)
    .refine((r) => r.every(isKnownRegion), "Unknown region code"),
  personality: text(3, 500),
  toneOfVoice: text(3, 280),
  backstory: text(10, 2000),
  contentPillars: z.array(contentPillarSchema).min(1, "Add at least one content pillar").max(8),
  contentFormats: z.array(z.enum(CONTENT_FORMATS)).min(1, "Pick at least one format"),
  timezone: z.string().refine(isKnownTimezone, "Unknown timezone"),
  publishingSchedule: publishingScheduleSchema,
});

export type CreatorProfileInput = z.infer<typeof creatorProfileSchema>;

export const creatorBriefSchema = z.object({
  brief: text(20, 4000),
  language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).default("nl-NL"),
  regions: z.array(z.string().trim().toUpperCase()).max(20).default(["NL"]),
});

export const appearanceSchema = z.object({
  ageRange: text(1, 20),
  build: text(0, 120).default(""),
  skinTone: text(0, 120).default(""),
  hair: text(0, 160).default(""),
  eyes: text(0, 120).default(""),
  face: text(0, 280).default(""),
  distinguishingFeatures: text(0, 280).default(""),
  wardrobe: text(0, 400).default(""),
});

export const consistencyStrategySchema = z.object({
  referenceWeight: z.number().min(0).max(1).default(0.8),
  seed: z.number().int().min(0).max(2 ** 31 - 1).nullable().default(null),
  notes: text(0, 1000).default(""),
});

export const characterDraftSchema = z.object({
  appearance: appearanceSchema,
  identityPrompt: text(20, 2000),
  negativePrompt: text(0, 1000).default(""),
  consistencyStrategy: consistencyStrategySchema,
});

export type CharacterDraftInput = z.infer<typeof characterDraftSchema>;

export const likenessAttestationSchema = z
  .string()
  .trim()
  .min(20, "Describe briefly why this identity is synthetic and not based on a real person");

export const AUTONOMY_RANK: Record<(typeof AUTONOMY_MODES)[number], number> = {
  MANUAL: 0,
  ASSISTED: 1,
  CONTROLLED_AUTONOMY: 2,
};
