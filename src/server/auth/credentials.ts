// Credential verification with brute-force protection. Kept free of Next.js imports so it can be
// integration-tested directly.

import type { UserRole } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { redis } from "../redis";
import { recordAudit } from "../audit";
import { verifySecondFactor } from "./mfa";
import { verifyPassword } from "./password";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
  // Second factor: a 6-digit code or a recovery code (only asked for when enabled).
  otp: z.string().trim().max(32).optional().catch(undefined),
});

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export type AuthOutcome =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "invalid" | "rate_limited" | "disabled" | "mfa_required" | "mfa_invalid" };

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

function rateKey(ip: string | null | undefined, email: string) {
  return `cf:login:${ip ?? "unknown"}:${email}`;
}

export async function authenticate(raw: unknown, meta: RequestMeta = {}): Promise<AuthOutcome> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { email, password, otp } = parsed.data;
  const { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS } = env();
  const auditMeta = { ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null };

  const key = rateKey(meta.ip, email);
  const attempts = await redis().incr(key);
  if (attempts === 1) await redis().expire(key, LOGIN_WINDOW_SECONDS);
  if (attempts > LOGIN_MAX_ATTEMPTS) {
    await recordAudit({ type: "USER", label: email }, { action: "auth.login_rate_limited", metadata: { email }, ...auditMeta });
    return { ok: false, reason: "rate_limited" };
  }

  const user = await db.user.findUnique({ where: { email } });
  const valid = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !valid) {
    await recordAudit({ type: "USER", id: user?.id, label: email }, { action: "auth.login_failed", metadata: { email }, ...auditMeta });
    return { ok: false, reason: "invalid" };
  }
  if (user.disabledAt) {
    await recordAudit({ type: "USER", id: user.id, label: email }, { action: "auth.login_disabled_account", ...auditMeta });
    return { ok: false, reason: "disabled" };
  }

  if (user.mfaEnabledAt) {
    // The password was right; without a valid second factor nothing else happens. Attempts keep
    // counting towards the same limit, so codes cannot be guessed.
    if (!otp) return { ok: false, reason: "mfa_required" };
    const second = await verifySecondFactor(user, otp);
    if (second === "invalid") {
      await recordAudit({ type: "USER", id: user.id, label: email }, { action: "auth.mfa_failed", ...auditMeta });
      return { ok: false, reason: "mfa_invalid" };
    }
    if (second === "recovery") await recordAudit({ type: "USER", id: user.id, label: email }, { action: "auth.mfa_recovery_code_used", ...auditMeta });
  }

  await redis().del(key);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({ type: "USER", id: user.id, label: user.email }, { action: "auth.login_succeeded", ...auditMeta });
  return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}
