import { describe, expect, it } from "vitest";
import { authenticate } from "@/server/auth/credentials";
import { db } from "@/server/db";
import { makeUser, uid } from "./helpers";

describe("credential authentication", () => {
  it("accepts correct credentials, case-insensitively by email, and audits it", async () => {
    const user = await makeUser("OPERATOR");
    const res = await authenticate({ email: user.email.toUpperCase(), password: "correct-horse-battery" }, { ip: `10.0.0.${uid()}` });
    expect(res).toMatchObject({ ok: true, user: { id: user.id, role: "OPERATOR" } });
    expect(JSON.stringify(res)).not.toContain("passwordHash");
    const audit = await db.auditLog.findFirst({ where: { actorId: user.id, action: "auth.login_succeeded" } });
    expect(audit).not.toBeNull();
    expect((await db.user.findUnique({ where: { id: user.id } }))!.lastLoginAt).not.toBeNull();
  });

  it("rejects a wrong password and unknown email with the same outcome", async () => {
    const user = await makeUser();
    const ip = `ip-${uid()}`;
    expect(await authenticate({ email: user.email, password: "wrong-password" }, { ip })).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticate({ email: `nobody-${uid()}@x.y`, password: "whatever" }, { ip })).toEqual({ ok: false, reason: "invalid" });
    const failures = await db.auditLog.count({ where: { action: "auth.login_failed", actorLabel: user.email } });
    expect(failures).toBe(1);
  });

  it("blocks disabled accounts", async () => {
    const user = await makeUser();
    await db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect(await authenticate({ email: user.email, password: "correct-horse-battery" }, { ip: uid() })).toEqual({ ok: false, reason: "disabled" });
  });

  it("rate-limits brute force even when the password becomes correct", async () => {
    const user = await makeUser();
    const ip = `bf-${uid()}`;
    for (let i = 0; i < 3; i++) await authenticate({ email: user.email, password: `bad-${i}` }, { ip });
    expect(await authenticate({ email: user.email, password: "correct-horse-battery" }, { ip })).toEqual({ ok: false, reason: "rate_limited" });
    // another client is unaffected
    expect((await authenticate({ email: user.email, password: "correct-horse-battery" }, { ip: `other-${uid()}` })).ok).toBe(true);
  });

  it("rejects malformed input without touching the database", async () => {
    expect(await authenticate({ email: "not-an-email", password: "x" })).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticate(null)).toEqual({ ok: false, reason: "invalid" });
  });
});
