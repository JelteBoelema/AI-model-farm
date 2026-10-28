// Single sign-on (OpenID Connect) admission. No accounts are created through SSO: the owner adds
// people under Settings → Users first, and SSO then signs in the account with the same verified
// email. Roles stay in this database.

import { db } from "../db";
import { recordAudit } from "../audit";

export async function ssoUser(p: { email?: string | null; emailVerified?: boolean; subject?: string }) {
  const email = p.email?.trim().toLowerCase();
  if (!email || p.emailVerified === false) {
    await recordAudit({ type: "USER", label: email ?? "unknown" }, { action: "auth.sso_denied", metadata: { reason: "email missing or not verified", subject: p.subject } });
    return null;
  }
  const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true, role: true, disabledAt: true, isSystem: true } });
  if (!user || user.disabledAt || user.isSystem) {
    await recordAudit({ type: "USER", id: user?.id, label: email }, { action: "auth.sso_denied", metadata: { reason: user ? "disabled" : "no account", subject: p.subject } });
    return null;
  }
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({ type: "USER", id: user.id, label: email }, { action: "auth.login_succeeded", metadata: { via: "sso", subject: p.subject } });
  return { id: user.id, role: user.role };
}
