"use server";

import { signOut } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { actorOf, getCurrentUser, requestMeta } from "@/server/auth/session";

export async function signOutAction(): Promise<void> {
  const user = await getCurrentUser();
  if (user) await recordAudit(actorOf(user), { action: "auth.logout", ...(await requestMeta()) });
  await signOut({ redirectTo: "/login" });
}
