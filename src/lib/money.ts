// Money is handled as integer micro-units (1 EUR = 1_000_000 micros) to avoid float drift when
// summing many tiny token costs. Never coerce a missing price to zero: use `null` and block.

export const MICROS_PER_UNIT = 1_000_000n;

export function toMicros(value: string | number): bigint {
  const text = typeof value === "number" ? value.toFixed(6) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error(`Invalid money amount: ${value}`);
  const [, sign, whole, frac = ""] = match;
  const micros = BigInt(whole!) * MICROS_PER_UNIT + BigInt(frac.padEnd(6, "0"));
  return sign ? -micros : micros;
}

export function microsToDecimalString(micros: bigint, fractionDigits = 2): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const scale = 10n ** BigInt(6 - fractionDigits);
  // round half up at the requested precision
  const rounded = (abs + scale / 2n) / scale;
  const factor = 10n ** BigInt(fractionDigits);
  const whole = rounded / factor;
  const frac = (rounded % factor).toString().padStart(fractionDigits, "0");
  return `${negative ? "-" : ""}${whole}${fractionDigits > 0 ? `.${frac}` : ""}`;
}

export function formatMoney(micros: bigint | null | undefined, currency = "EUR", fractionDigits = 2): string {
  if (micros === null || micros === undefined) return "—";
  const amount = Number(microsToDecimalString(micros, fractionDigits));
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

export function sumMicros(values: Iterable<bigint | null | undefined>): bigint {
  let total = 0n;
  for (const v of values) if (v) total += v;
  return total;
}

/** Percentage of `used` against `limit`, clamped to [0, 999]; null when there is no limit. */
export function usagePercent(used: bigint, limit: bigint | null | undefined): number | null {
  if (!limit || limit <= 0n) return null;
  const pct = Number((used * 10_000n) / limit) / 100;
  return Math.min(Math.max(pct, 0), 999);
}
