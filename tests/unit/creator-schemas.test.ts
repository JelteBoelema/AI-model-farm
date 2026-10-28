import { describe, expect, it } from "vitest";
import { creatorProfileSchema, isKnownRegion, isKnownTimezone, publishingScheduleSchema } from "@/lib/schemas/creator";
import { mockProposalGenerator } from "@/server/services/creator-wizard";
import { slugify } from "@/server/services/creators";

const valid = {
  name: "Noor Vale",
  niche: "Minimal fashion",
  targetAudience: "Women 22–35",
  language: "nl-NL",
  targetRegions: ["nl", "BE"],
  personality: "Warm and curious",
  toneOfVoice: "Friendly",
  backstory: "A fictional designer from Utrecht.",
  contentPillars: [{ name: "How-to", description: "" }],
  contentFormats: ["IMAGE_POST"],
  timezone: "Europe/Amsterdam",
  publishingSchedule: { slots: [{ platform: "INSTAGRAM", weekday: 2, time: "18:00" }] },
};

describe("creator profile schema", () => {
  it("accepts a valid profile and normalises regions", () => {
    expect(creatorProfileSchema.parse(valid).targetRegions).toEqual(["NL", "BE"]);
  });

  it.each([
    ["unknown region", { targetRegions: ["XX"] }],
    ["bad language", { language: "Dutch" }],
    ["unknown timezone", { timezone: "Mars/Olympus" }],
    ["no pillars", { contentPillars: [] }],
    ["no formats", { contentFormats: [] }],
    ["bad time", { publishingSchedule: { slots: [{ platform: "INSTAGRAM", weekday: 1, time: "25:00" }] } }],
    ["bad weekday", { publishingSchedule: { slots: [{ platform: "INSTAGRAM", weekday: 8, time: "10:00" }] } }],
  ])("rejects %s", (_label, patch) => {
    expect(creatorProfileSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("rejects duplicate schedule slots", () => {
    const slot = { platform: "INSTAGRAM", weekday: 1, time: "10:00" };
    expect(publishingScheduleSchema.safeParse({ slots: [slot, slot] }).success).toBe(false);
  });

  it("knows regions and timezones", () => {
    expect(isKnownRegion("NL")).toBe(true);
    expect(isKnownRegion("ZZ")).toBe(false);
    expect(isKnownTimezone("UTC")).toBe(true);
    expect(isKnownTimezone("Europe/Amsterdam")).toBe(true);
  });
});

describe("slugify", () => {
  it("creates url-safe slugs", () => {
    expect(slugify("Noor Vålé!")).toBe("noor-vale");
    expect(slugify("  ---  ")).toBe("creator");
    expect(slugify("a".repeat(80))).toHaveLength(40);
  });
});

describe("mock proposal generator", () => {
  const brief = { brief: "A plant-based food creator for Dutch students. Quick recipes under 15 minutes.", language: "nl-NL", regions: ["NL"] };

  it("is deterministic and labels its content as mock", async () => {
    const a = await mockProposalGenerator.propose(brief);
    const b = await mockProposalGenerator.propose(brief);
    expect(a).toEqual(b);
    expect(a.profile.personality).toContain("[Mock]");
    expect(a.character.identityPrompt).toContain("[Mock]");
    expect(mockProposalGenerator.isMock).toBe(true);
  });

  it("produces output that passes the real schema", async () => {
    const out = await mockProposalGenerator.propose(brief);
    expect(creatorProfileSchema.safeParse(out.profile).success).toBe(true);
  });
});

describe("stableJson", () => {
  it("ignores object key order but not array order", async () => {
    const { stableJson } = await import("@/server/services/creators");
    expect(stableJson({ a: 1, b: { c: 2, d: 3 } })).toBe(stableJson({ b: { d: 3, c: 2 }, a: 1 }));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
});
