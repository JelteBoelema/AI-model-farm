import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, stepAt, verifyTotp } from "@/server/auth/totp";

// RFC 6238 appendix B (SHA-1 seed "12345678901234567890"), last 6 of the 8-digit codes.
const SEED = Buffer.from("12345678901234567890");
const VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [t, code] of VECTORS) expect(hotp(SEED, Math.floor(t / 30))).toBe(code);
  });

  it("round-trips base32", () => {
    expect(base32Encode(SEED)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3tqojq gezdgnbvgy3tqojq")).toEqual(SEED);
  });

  it("accepts the current step and one step of drift, refuses replays and other codes", () => {
    const secret = base32Encode(SEED);
    const now = new Date(1111111111 * 1000);
    const step = stepAt(now);
    expect(verifyTotp(secret, "050471", now)).toBe(step);
    expect(verifyTotp(secret, hotp(SEED, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(SEED, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(SEED, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, "050471", now, step)).toBeNull(); // already used
    expect(verifyTotp(secret, "12345", now)).toBeNull();
  });

  it("builds an otpauth URI for authenticator apps", () => {
    expect(otpauthUri("ABC", "a@b.nl")).toBe("otpauth://totp/Creator%20Farm%3Aa%40b.nl?secret=ABC&issuer=Creator%20Farm&algorithm=SHA1&digits=6&period=30");
  });
});
