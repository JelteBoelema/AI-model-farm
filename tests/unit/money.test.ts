import { describe, expect, it } from "vitest";
import { formatMoney, microsToDecimalString, sumMicros, toMicros, usagePercent } from "@/lib/money";

describe("money", () => {
  it("parses decimal strings exactly", () => {
    expect(toMicros("1")).toBe(1_000_000n);
    expect(toMicros("0.000003")).toBe(3n);
    expect(toMicros("12.5")).toBe(12_500_000n);
    expect(toMicros("-2.25")).toBe(-2_250_000n);
  });

  it("rejects malformed and over-precise amounts", () => {
    expect(() => toMicros("1.0000001")).toThrow();
    expect(() => toMicros("abc")).toThrow();
    expect(() => toMicros("")).toThrow();
  });

  it("sums many tiny token costs without float drift", () => {
    const perToken = toMicros("0.000003");
    expect(sumMicros(Array(1_000_000).fill(perToken))).toBe(toMicros("3"));
  });

  it("rounds half up when formatting", () => {
    expect(microsToDecimalString(1_005_000n)).toBe("1.01");
    expect(microsToDecimalString(1_004_999n)).toBe("1.00");
    expect(microsToDecimalString(-1_005_000n)).toBe("-1.01");
  });

  it("formats null as unknown, never as zero", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(0n)).not.toBe("—");
  });

  it("computes usage percent and handles missing limits", () => {
    expect(usagePercent(50n, 200n)).toBe(25);
    expect(usagePercent(50n, null)).toBeNull();
    expect(usagePercent(50n, 0n)).toBeNull();
  });
});
