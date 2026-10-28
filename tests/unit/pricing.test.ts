import { describe, expect, it } from "vitest";
import { computeCost, hasPrice, parsePricing, type Pricing } from "@/server/providers/pricing";

const usd: Pricing = parsePricing({
  currency: "USD",
  fxToEur: "0.95",
  source: "https://example.com/pricing",
  updatedAt: "2026-10-01T00:00:00.000Z",
  models: { "claude-opus-5-5": { input_mtok: "4.00", output_mtok: "20.00" }, img: { per_image: "0.04" } },
})!;

describe("pricing", () => {
  it("prices tokens per million and converts USD to EUR, rounding up", () => {
    // 1,000 in × $4/M = $0.004 ; 500 out × $20/M = $0.01 → $0.014 → €0.0133
    expect(computeCost(usd, "claude-opus-5-5", { input_mtok: 1000, output_mtok: 500 })).toEqual({ eurMicros: 13_300n, missing: [] });
    // a single token still costs something (never rounds to zero)
    expect(computeCost(usd, "claude-opus-5-5", { input_mtok: 1 }).eurMicros).toBe(4n);
    expect(computeCost(usd, "img", { per_image: 2 }).eurMicros).toBe(76_000n);
  });

  it("reports missing prices instead of zero", () => {
    expect(computeCost(usd, "claude-opus-5-5", { input_mtok: 10, cache_write_mtok: 5 })).toEqual({ eurMicros: null, missing: ["cache_write_mtok"] });
    expect(computeCost(usd, "unknown-model", { input_mtok: 10 }).eurMicros).toBeNull();
    expect(computeCost(null, "x", { input_mtok: 10 }).eurMicros).toBeNull();
    expect(computeCost(usd, "claude-opus-5-5", { cache_write_mtok: 0 }).eurMicros).toBe(0n); // unused units need no price
  });

  it("treats explicit mock pricing as a known zero", () => {
    const free = parsePricing({ currency: "EUR", source: "urn:creator-farm:mock", updatedAt: "2026-01-01T00:00:00.000Z", free: true })!;
    expect(computeCost(free, "mock", { per_image: 5 }).eurMicros).toBe(0n);
  });

  it("validates price lists", () => {
    expect(parsePricing({ currency: "USD", source: "https://x.y", updatedAt: "2026-10-01T00:00:00.000Z", models: {} })).toBeNull(); // USD without FX
    expect(parsePricing({ currency: "EUR", source: "not a url", updatedAt: "2026-10-01T00:00:00.000Z" })).toBeNull();
    expect(parsePricing({ ...usd, models: { m: { input_mtok: "-1" } } })).toBeNull();
    expect(hasPrice(usd, "claude-opus-5-5", ["input_mtok", "output_mtok"])).toBe(true);
    expect(hasPrice(usd, "claude-opus-5-5", ["per_image"])).toBe(false);
  });
});
