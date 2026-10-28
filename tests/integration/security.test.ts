import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate } from "@/server/auth/credentials";
import { confirmEnrollment, disableMfa, mfaRequiredFor, regenerateRecoveryCodes, resetMfa, startEnrollment } from "@/server/auth/mfa";
import { ssoUser } from "@/server/auth/sso";
import { base32Decode, hotp, stepAt } from "@/server/auth/totp";
import { autopilotUser } from "@/server/services/autopilot";
import { db } from "@/server/db";
import { mfaRequiredRoles, parseEnv, resetEnvCache } from "@/server/env";
import { enforce, hit } from "@/server/rate-limit";
import { redis } from "@/server/redis";
import { acting, makeUser, uid } from "./helpers";

const PASSWORD = "correct-horse-battery";
const codeAt = (secret: string, when: Date) => hotp(base32Decode(secret), stepAt(when));

async function enrolled(role: "OWNER" | "ADMIN" | "OPERATOR" = "ADMIN") {
  const user = await makeUser(role, PASSWORD);
  const { secret } = await startEnrollment(user);
  // Enrol 2 minutes ago so "now" codes are fresh steps.
  const then = new Date(Date.now() - 120_000);
  const codes = await confirmEnrollment(acting(user).actor, user.id, codeAt(secret, then), then);
  return { user, secret, codes };
}

beforeEach(async () => {
  await redis().flushdb();
});

afterEach(() => {
  delete process.env.MFA_REQUIRED_ROLES;
  resetEnvCache();
});

afterAll(() => redis().disconnect());

describe("two-factor authentication", () => {
  it("enrols with a code, stores the secret encrypted and gives ten single-use recovery codes", async () => {
    const { user, secret, codes } = await enrolled();
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.mfaEnabledAt).not.toBeNull();
    expect(row.mfaSecret).toMatch(/^v1\./);
    expect(row.mfaSecret).not.toContain(secret);
    expect(codes).toHaveLength(10);
    expect(row.mfaRecoveryCodes).toHaveLength(10);
    expect(row.mfaRecoveryCodes.some((h) => codes.some((c) => h.includes(c)))).toBe(false);
    expect(await db.auditLog.findFirst({ where: { action: "auth.mfa_enabled", entityId: user.id } })).not.toBeNull();
  });

  it("refuses a wrong enrolment code and an expired setup", async () => {
    const user = await makeUser("ADMIN", PASSWORD);
    await expect(confirmEnrollment(acting(user).actor, user.id, "000000")).rejects.toThrow(/setup expired/);
    await startEnrollment(user);
    await expect(confirmEnrollment(acting(user).actor, user.id, "000000")).rejects.toThrow(/not valid/);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnabledAt).toBeNull();
  });

  it("asks for the second factor after the password, accepts a code once, and accepts each recovery code once", async () => {
    const { user, secret, codes } = await enrolled();
    const base = { email: user.email, password: PASSWORD };
    expect(await authenticate(base)).toEqual({ ok: false, reason: "mfa_required" });
    expect(await authenticate({ ...base, otp: "000000" })).toEqual({ ok: false, reason: "mfa_invalid" });
    const code = codeAt(secret, new Date());
    expect(await authenticate({ ...base, otp: code })).toMatchObject({ ok: true });
    expect(await authenticate({ ...base, otp: code })).toEqual({ ok: false, reason: "mfa_invalid" }); // replay

    expect(await authenticate({ ...base, otp: codes[0]!.toLowerCase() })).toMatchObject({ ok: true });
    expect(await authenticate({ ...base, otp: codes[0]! })).toEqual({ ok: false, reason: "mfa_invalid" });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mfaRecoveryCodes).toHaveLength(9);
    expect(await db.auditLog.count({ where: { action: "auth.mfa_recovery_code_used", actorId: user.id } })).toBe(1);
    // A wrong password never reveals that a second factor exists.
    expect(await authenticate({ email: user.email, password: "wrong-password", otp: code })).toEqual({ ok: false, reason: "invalid" });
  });

  it("counts code guesses towards the sign-in limit", async () => {
    const { user } = await enrolled();
    for (let i = 0; i < 5; i++) await authenticate({ email: user.email, password: PASSWORD, otp: "000000" }, { ip: "10.0.0.9" });
    expect(await authenticate({ email: user.email, password: PASSWORD, otp: "000000" }, { ip: "10.0.0.9" })).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("requires a valid code to renew recovery codes or turn it off, and keeps it on where the role requires it", async () => {
    const { user, secret } = await enrolled("ADMIN");
    const actor = acting(user).actor;
    await expect(regenerateRecoveryCodes(actor, user.id, "000000")).rejects.toThrow(/not valid/);
    const fresh = await regenerateRecoveryCodes(actor, user.id, codeAt(secret, new Date(Date.now() - 30_000)));
    expect(fresh).toHaveLength(10);

    process.env.MFA_REQUIRED_ROLES = "OWNER,ADMIN";
    resetEnvCache();
    await expect(disableMfa(actor, user.id, codeAt(secret, new Date()))).rejects.toThrow(/role requires/);
    process.env.MFA_REQUIRED_ROLES = "OWNER";
    resetEnvCache();
    await disableMfa(actor, user.id, codeAt(secret, new Date(Date.now() + 30_000)));
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ mfaEnabledAt: null, mfaSecret: null, mfaRecoveryCodes: [] });
  });

  it("lets only a human owner reset someone else's second factor, with a reason", async () => {
    const { user } = await enrolled("OPERATOR");
    const owner = acting(await makeUser("OWNER"));
    const admin = acting(await makeUser("ADMIN"));
    await expect(resetMfa(admin, user.id, "lost phone")).rejects.toThrow(/Only the owner/);
    await expect(resetMfa({ ...(await autopilotUser()), role: "OWNER" }, user.id, "lost phone")).rejects.toThrow(/person/);
    await expect(resetMfa(owner, owner.id, "lost phone")).rejects.toThrow(/another owner/);
    await expect(resetMfa(owner, user.id, "x")).rejects.toThrow(/reason/);
    await resetMfa(owner, user.id, "lost phone and codes");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnabledAt).toBeNull();
    expect(await authenticate({ email: user.email, password: PASSWORD })).toMatchObject({ ok: true });
  });

  it("requires a second factor for owners and admins in production by default", () => {
    const base = { DATABASE_URL: "postgresql://x/y", REDIS_URL: "redis://x", AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") };
    expect(mfaRequiredRoles(parseEnv({ ...base, APP_ENV: "production", STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_REGION: "eu-central-1", SECRETS_DRIVER: "aws" }))).toEqual(["OWNER", "ADMIN"]);
    expect(mfaRequiredRoles(parseEnv(base))).toEqual([]);
    expect(mfaRequiredRoles(parseEnv({ ...base, MFA_REQUIRED_ROLES: "owner, admin,operator" }))).toEqual(["OWNER", "ADMIN", "OPERATOR"]);
    process.env.MFA_REQUIRED_ROLES = "OWNER";
    resetEnvCache();
    expect([mfaRequiredFor("OWNER"), mfaRequiredFor("ADMIN")]).toEqual([true, false]);
    expect(() => parseEnv({ ...base, OIDC_ISSUER: "https://idp.example.com" })).toThrow(/must be set together/);
  });
});

describe("single sign-on admission", () => {
  it("signs in only existing, enabled people with a verified email; never creates accounts", async () => {
    const user = await makeUser("OPERATOR");
    expect(await ssoUser({ email: user.email.toUpperCase(), emailVerified: true, subject: "abc" })).toEqual({ id: user.id, role: "OPERATOR" });
    expect(await ssoUser({ email: user.email, emailVerified: false })).toBeNull();
    const stranger = `nobody-${uid()}@test.local`;
    expect(await ssoUser({ email: stranger, emailVerified: true })).toBeNull();
    expect(await db.user.findUnique({ where: { email: stranger } })).toBeNull();
    await db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect(await ssoUser({ email: user.email, emailVerified: true })).toBeNull();
    const pilot = await autopilotUser();
    expect(await ssoUser({ email: (await db.user.findUniqueOrThrow({ where: { id: pilot.id } })).email, emailVerified: true })).toBeNull();
    expect(await db.auditLog.count({ where: { action: "auth.sso_denied", actorLabel: stranger } })).toBe(1);
  });
});

describe("rate limits", () => {
  it("counts per bucket and identity within a window, then lets the next window through", async () => {
    const t = Date.UTC(2026, 9, 28, 12, 0, 10);
    for (let i = 0; i < 3; i++) expect((await hit("test", "a", 3, 60, t)).allowed).toBe(true);
    const blocked = await hit("test", "a", 3, 60, t);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 50 });
    expect((await hit("test", "b", 3, 60, t)).allowed).toBe(true); // other identity
    expect((await hit("other", "a", 3, 60, t)).allowed).toBe(true); // other bucket
    expect((await hit("test", "a", 3, 60, t + 60_000)).allowed).toBe(true); // next window
  });

  it("throws a readable error when an action limit is exceeded", async () => {
    await enforce("test-enforce", "u", 1);
    await expect(enforce("test-enforce", "u", 1)).rejects.toThrow(/Too many requests/);
  });
});
