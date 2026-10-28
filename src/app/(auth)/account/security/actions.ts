"use server";

import { z } from "zod";
import { actorOf, getCurrentUser } from "@/server/auth/session";
import { confirmEnrollment, disableMfa, regenerateRecoveryCodes, startEnrollment } from "@/server/auth/mfa";
import { DomainError } from "@/server/errors";
import { enforce } from "@/server/rate-limit";

// These actions are reachable before two-factor setup is complete, so they do not go through
// defineAction (which requires it). They only ever act on the signed-in user's own account.
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>) => Promise<T>): Promise<Result<T>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in again" };
  try {
    // Code guessing is bounded per account.
    await enforce("mfa", user.id, 10);
    return { ok: true, data: await fn(user) };
  } catch (err) {
    if (err instanceof DomainError || err instanceof z.ZodError) return { ok: false, error: err.message };
    throw err;
  }
}

const code = z.string().trim().min(6).max(32);

export async function startEnrollmentAction() {
  return run(async (user) => startEnrollment(user));
}

export async function confirmEnrollmentAction(raw: string) {
  return run(async (user) => {
    const codes = await confirmEnrollment(actorOf(user), user.id, code.parse(raw));
    return { codes };
  });
}

export async function regenerateRecoveryAction(raw: string) {
  return run(async (user) => ({ codes: await regenerateRecoveryCodes(actorOf(user), user.id, code.parse(raw)) }));
}

export async function disableMfaAction(raw: string) {
  return run(async (user) => disableMfa(actorOf(user), user.id, code.parse(raw)));
}
