// Server-side session helpers. The JWT only identifies the user; role and disabled state are
// re-read from the database on every request so revocations take effect immediately.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { can, type Permission } from "@/lib/rbac";
import { db } from "../db";
import { env } from "../env";
import { mfaRequiredFor } from "./mfa";
import type { Actor } from "../audit";
import { auth } from "./index";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** The role requires a second factor that this account has not set up yet. */
  mfaSetupRequired: boolean;
  mfaEnabled: boolean;
}

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await db.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true, disabledAt: true, mfaEnabledAt: true } });
  if (!user || user.disabledAt) return null;
  // Single sign-on satisfies the requirement only when the identity provider enforces a second factor.
  const viaSso = (session.user as { via?: string }).via === "sso";
  const satisfied = !!user.mfaEnabledAt || (viaSso && env().OIDC_IDP_ENFORCES_MFA);
  return { id: user.id, email: user.email, name: user.name, role: user.role, mfaEnabled: !!user.mfaEnabledAt, mfaSetupRequired: !satisfied && mfaRequiredFor(user.role) };
}

/** Signed-in user; one who still has to set up two-factor authentication is sent to do that first. */
export async function requireUser(opts: { allowMfaSetup?: boolean } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mfaSetupRequired && !opts.allowMfaSetup) redirect("/account/security");
  return user;
}

export class MfaSetupRequiredError extends Error {
  constructor() {
    super("Set up two-factor authentication first (Account → Security).");
    this.name = "MfaSetupRequiredError";
  }
}

export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mfaSetupRequired) throw new MfaSetupRequiredError();
  if (!can(user.role, permission)) throw new ForbiddenError(permission);
  return user;
}

export function actorOf(user: CurrentUser): Actor {
  return { type: "USER", id: user.id, label: user.email };
}

export function actingUserOf(user: CurrentUser) {
  return { id: user.id, role: user.role, actor: actorOf(user) };
}

export async function requestMeta() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}
