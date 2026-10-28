// Provider price tables (stored in ai_providers.pricing) and cost calculation. All arithmetic is in
// integer micro-units and rounds up, so recorded costs never understate real spend. A missing price
// is reported as missing, never as zero.

import { z } from "zod";
import { toMicros } from "@/lib/money";

export const PRICE_UNITS = {
  input_mtok: "Input tokens (per million)",
  output_mtok: "Output tokens (per million)",
  cache_write_mtok: "Cache write tokens (per million)",
  cache_read_mtok: "Cache read tokens (per million)",
  text_input_mtok: "Text input tokens (per million)",
  image_input_mtok: "Image input tokens (per million)",
  image_output_mtok: "Image output tokens (per million)",
  long_input_mtok: "Input tokens, long-context tier (per million)",
  long_output_mtok: "Output tokens, long-context tier (per million)",
  per_image: "Per generated image (used for estimates)",
  video_second: "Per second of generated video",
  speech_kchar: "Speech synthesis (per 1,000 characters)",
} as const;

export type PriceUnit = keyof typeof PRICE_UNITS;
const decimal = z.string().trim().regex(/^\d{1,6}(\.\d{1,6})?$/, "Use a decimal such as 4.00 or 0.000123");

export const pricingSchema = z
  .object({
    currency: z.enum(["USD", "EUR"]),
    /** EUR per 1 unit of `currency`; required for USD, conservative (include a margin). */
    fxToEur: decimal.optional(),
    source: z.string().trim().url("Link the provider's official price page"),
    updatedAt: z.string().datetime(),
    /** Mock providers only: an explicit, known zero cost. */
    free: z.boolean().default(false),
    models: z.record(z.string().min(1).max(100), z.partialRecord(z.enum(Object.keys(PRICE_UNITS) as [PriceUnit, ...PriceUnit[]]), decimal)).default({}),
  })
  .refine((p) => p.currency === "EUR" || p.fxToEur !== undefined, { message: "USD prices need an exchange rate to EUR", path: ["fxToEur"] });

export type Pricing = z.infer<typeof pricingSchema>;

export function parsePricing(stored: unknown): Pricing | null {
  const r = pricingSchema.safeParse(stored);
  return r.success ? r.data : null;
}

export type Usage = Partial<Record<PriceUnit, number>>;

/** Maps raw usage quantities to the unit that prices them (token units are priced per million). */
const PER_THOUSAND: PriceUnit[] = ["speech_kchar"];
const PER_MILLION: PriceUnit[] = ["input_mtok", "output_mtok", "cache_write_mtok", "cache_read_mtok", "text_input_mtok", "image_input_mtok", "image_output_mtok", "long_input_mtok", "long_output_mtok"];

export interface CostResult {
  /** EUR micro-units, rounded up. Null when any used unit has no price. */
  eurMicros: bigint | null;
  missing: PriceUnit[];
}

function toEur(currencyMicros: bigint, pricing: Pricing): bigint {
  if (pricing.currency === "EUR") return currencyMicros;
  const fx = toMicros(pricing.fxToEur!);
  return (currencyMicros * fx + 999_999n) / 1_000_000n;
}

export function computeCost(pricing: Pricing | null, model: string, usage: Usage): CostResult {
  if (pricing?.free) return { eurMicros: 0n, missing: [] };
  const used = (Object.entries(usage) as [PriceUnit, number][]).filter(([, q]) => q > 0);
  if (!pricing) return { eurMicros: null, missing: used.map(([u]) => u) };
  const prices: Partial<Record<PriceUnit, string>> = pricing.models[model] ?? {};
  let total = 0n;
  const missing: PriceUnit[] = [];
  for (const [unit, quantity] of used) {
    const price = prices[unit];
    if (price === undefined) {
      missing.push(unit);
      continue;
    }
    const priceMicros = toMicros(price);
    const q = BigInt(Math.ceil(quantity));
    total += PER_MILLION.includes(unit) ? (q * priceMicros + 999_999n) / 1_000_000n : PER_THOUSAND.includes(unit) ? (q * priceMicros + 999n) / 1_000n : q * priceMicros;
  }
  return { eurMicros: missing.length ? null : toEur(total, pricing), missing };
}

export function hasPrice(pricing: Pricing | null, model: string, units: PriceUnit[]): boolean {
  if (pricing?.free) return true;
  const prices = pricing?.models[model];
  return !!prices && units.every((u) => prices[u] !== undefined);
}
