import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { scrubMetadata } from "@/server/audit";
import { decrypt, encrypt, safeEqual } from "@/server/crypto";
import { createLogger } from "@/server/logger";
import { parseSecretRef, resolveSecret } from "@/server/secrets";

const key = Buffer.alloc(32, 9).toString("base64");

describe("encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("token-123", key, "social:1");
    const b = encrypt("token-123", key, "social:1");
    expect(a).not.toBe(b);
    expect(decrypt(a, key, "social:1")).toBe("token-123");
  });

  it("detects tampering and wrong associated data", () => {
    const env = encrypt("token-123", key, "social:1");
    expect(() => decrypt(env, key, "social:2")).toThrow();
    const parts = env.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key, "social:1")).toThrow();
  });

  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("credential redaction", () => {
  it("scrubs secrets from audit metadata at any depth", () => {
    const out = scrubMetadata({ email: "a@b.c", password: "p", nested: { apiKey: "k", accessToken: "t", credentialRef: "env:X" }, big: 5n }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).accessToken).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).credentialRef).toBe("env:X"); // references are not secrets
    expect(out.big).toBe("5");
  });

  it("redacts secrets in structured logs", () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
    createLogger(sink).error({ apiKey: "sk-live-123", req: { headers: { authorization: "Bearer abc" } }, password: "pw" }, "boom");
    const out = lines.join("");
    expect(out).not.toContain("sk-live-123");
    expect(out).not.toContain("Bearer abc");
    expect(out).not.toContain('"pw"');
  });
});

describe("secret references", () => {
  it("parses scheme and name", () => {
    expect(parseSecretRef("env:ANTHROPIC_API_KEY")).toEqual({ scheme: "env", name: "ANTHROPIC_API_KEY" });
    expect(() => parseSecretRef("nope")).toThrow();
  });

  it("resolves env secrets and reports missing ones as null", async () => {
    process.env.CF_TEST_SECRET = "value";
    expect(await resolveSecret("env:CF_TEST_SECRET")).toBe("value");
    expect(await resolveSecret("env:CF_DOES_NOT_EXIST")).toBeNull();
  });

  it("refuses arbitrary env lookups", async () => {
    await expect(resolveSecret("env:../../etc")).rejects.toThrow();
    await expect(resolveSecret("vault:x")).rejects.toThrow(/Unknown secret store/);
  });
});
