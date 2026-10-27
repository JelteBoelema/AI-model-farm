import { describe, expect, it } from "vitest";
import { parseFilters, periodStart } from "@/lib/filters";

const id = "3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f";

describe("dashboard filters", () => {
  it("parses valid values", () => {
    expect(parseFilters({ creator: id, platform: "TIKTOK", period: "7d" })).toEqual({ creator: id, platform: "TIKTOK", period: "7d" });
  });

  it("drops invalid values instead of failing the page", () => {
    const f = parseFilters({ creator: "not-a-uuid", platform: "MYSPACE", period: "1y", status: "drop table;" });
    expect(f).toEqual({ period: "30d" });
  });

  it("takes the first value of repeated params", () => {
    expect(parseFilters({ period: ["mtd", "7d"] }).period).toBe("mtd");
  });

  it("computes UTC period starts", () => {
    const now = new Date("2026-10-27T15:30:00Z");
    expect(periodStart("today", now)?.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(periodStart("mtd", now)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodStart("all", now)).toBeNull();
  });
});
