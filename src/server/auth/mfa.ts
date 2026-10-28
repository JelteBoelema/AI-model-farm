// Two-factor authentication: enrolment, verification at sign-in, recovery codes, and an owner's
// reset. TOTP secrets are encrypted at rest; recovery codes are single-use and stored as keyed hashes.

import { createHmac, randomBytes } from "node:crypto";
import type { User, UserRole } from "@prisma/client";
import { recordAudit, type Actor } from "../audit";
import { decrypt, encrypt, safeEqual } from "../crypto";
import { db } from "../db";
import { env, mfaRequiredRoles } from "../env";
import { DomainError } from "../errors";
import { redis } from "../redis";
import { assertHuman } from "../services/policy";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp";

const ENROLL_TTL_SECONDS = 600;
const RECOVERY_CODES = 10;
const enrollKey = (userId: string) => `cf:mfa:enroll:${userId}`;
const aad = (userId: string) => `mfa:${userId}`;

export const mfaRequiredFor = (role: UserRole) => mfaRequiredRoles().includes(role);

function hashRecovery(code: string) {
  return createHmac("sha256", Buffer.from(env().APP_ENCRYPTION_KEY, "base64")).update(`recovery:${normalizeRecovery(code)}`).digest("hex");
}

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const raw = randomBytes(8).toString("hex").toUpperCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Starts enrolment: a fresh secret, kept (encrypted) for ten minutes until confirmed with a code. */
export async function startEnrollment(user: Pick<User, "id" | "email">) {
  const secret = newTotpSecret();
  await redis().set(enrollKey(user.id), encrypt(secret, env().APP_ENCRYPTION_KEY, aad(user.id)), "EX", ENROLL_TTL_SECONDS);
  return { secret, uri: otpauthUri(secret, user.email) };
}

/** Confirms enrolment with a code from the app; returns the recovery codes (shown once). */
export async function confirmEnrollment(actor: Actor, userId: string, code: string, now = new Date()): Promise<string[]> {
  assertHuman(actor);
  const pending = await redis().get(enrollKey(userId));
  if (!pending) throw new DomainError("The setup expired; start again");
  const secret = decrypt(pending, env().APP_ENCRYPTION_KEY, aad(userId));
  const step = verifyTotp(secret, code.trim(), now);
  if (step === null) throw new DomainError("That code is not valid; check the time on your phone and try again");
  const codes = newRecoveryCodes();
  const { count } = await db.user.updateMany({
    where: { id: userId, mfaEnabledAt: null },
    data: { mfaSecret: encrypt(secret, env().APP_ENCRYPTION_KEY, aad(userId)), mfaEnabledAt: now, mfaLastStep: step, mfaRecoveryCodes: codes.map(hashRecovery) },
  });
  if (count !== 1) throw new DomainError("Two-factor authentication is already on");
  await redis().del(enrollKey(userId));
  await recordAudit(actor, { action: "auth.mfa_enabled", entityType: "user", entityId: userId });
  return codes;
}

export type SecondFactorResult = "ok" | "recovery" | "invalid";

/** Checks a TOTP code or a recovery code; a used recovery code is removed, a used step is recorded. */
export async function verifySecondFactor(user: Pick<User, "id" | "mfaSecret" | "mfaLastStep" | "mfaRecoveryCodes">, input: string, now = new Date()): Promise<SecondFactorResult> {
  if (!user.mfaSecret) return "invalid";
  const code = input.trim().replace(/\s/g, "");
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decrypt(user.mfaSecret, env().APP_ENCRYPTION_KEY, aad(user.id)), code, now, user.mfaLastStep);
    if (step === null) return "invalid";
    // Compare-and-set: two sign-ins racing with the same code cannot both pass.
    const { count } = await db.user.updateMany({ where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } });
    return count === 1 ? "ok" : "invalid";
  }
  const hash = hashRecovery(code);
  const match = user.mfaRecoveryCodes.find((h) => safeEqual(h, hash));
  if (!match) return "invalid";
  const fresh = await db.user.findUnique({ where: { id: user.id }, select: { mfaRecoveryCodes: true } });
  if (!fresh?.mfaRecoveryCodes.includes(match)) return "invalid";
  const { count } = await db.user.updateMany({ where: { id: user.id, mfaRecoveryCodes: { has: match } }, data: { mfaRecoveryCodes: fresh.mfaRecoveryCodes.filter((h) => h !== match) } });
  return count === 1 ? "recovery" : "invalid";
}

async function requireCode(userId: string, code: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaEnabledAt) throw new DomainError("Two-factor authentication is off");
  if ((await verifySecondFactor(user, code)) === "invalid") throw new DomainError("That code is not valid");
  return user;
}

/** New recovery codes (the old ones stop working). */
export async function regenerateRecoveryCodes(actor: Actor, userId: string, code: string) {
  assertHuman(actor);
  await requireCode(userId, code);
  const codes = newRecoveryCodes();
  await db.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: codes.map(hashRecovery) } });
  await recordAudit(actor, { action: "auth.mfa_recovery_regenerated", entityType: "user", entityId: userId });
  return codes;
}

/** Turns the second factor off (with a valid code), unless the user's role requires it. */
export async function disableMfa(actor: Actor, userId: string, code: string) {
  assertHuman(actor);
  const user = await requireCode(userId, code);
  if (mfaRequiredFor(user.role)) throw new DomainError("Your role requires two-factor authentication");
  await db.user.update({ where: { id: userId }, data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryCodes: [] } });
  await recordAudit(actor, { action: "auth.mfa_disabled", entityType: "user", entityId: userId });
}

/** The owner resets a user who lost their device and recovery codes; they enrol again at next sign-in. */
export async function resetMfa(by: { id: string; role: UserRole; actor: Actor }, userId: string, reason: string) {
  assertHuman(by.actor);
  if (by.role !== "OWNER") throw new DomainError("Only the owner can reset two-factor authentication");
  if (userId === by.id) throw new DomainError("Ask another owner to reset your own two-factor authentication");
  const why = reason.trim();
  if (why.length < 5) throw new DomainError("Give a reason (at least 5 characters)");
  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true, isSystem: true } });
  if (!target || target.isSystem) throw new DomainError("User not found");
  await db.user.update({ where: { id: userId }, data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryCodes: [] } });
  await recordAudit(by.actor, { action: "auth.mfa_reset", entityType: "user", entityId: userId, metadata: { reason: why } });
  await db.notification.create({ data: { severity: "WARNING", type: "auth.mfa_reset", title: `Two-factor authentication reset for ${target.email}`, body: why.slice(0, 300), link: "/settings/users" } });
}
