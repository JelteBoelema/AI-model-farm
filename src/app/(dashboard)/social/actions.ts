"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import { env } from "@/server/env";
import { DomainError } from "@/server/errors";
import { mockConsentCode } from "@/server/platforms/mock";
import { decideConnection, disconnectAccount, limitsSchema, startConnect, startConnectSchema, updateAccountLimits, verifyAccount } from "@/server/services/social";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/social", "/calendar"] };

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export const startConnectAction = defineAction("social:connect", startConnectSchema, async (input, { user }) => ({ url: await startConnect(actingUserOf(user), input, await origin()) }));

export const mockConsentAction = defineAction("social:connect", z.object({ handle: z.string().regex(/^[a-z0-9._]{2,30}$/, "Use 2–30 lowercase letters, digits, . or _") }), async (input) => {
  if (!env().MOCK_MODE) throw new DomainError("The mock platform is only available in mock mode");
  return { code: mockConsentCode(input.handle) };
});

export const decideConnectionAction = defineAction(
  "social:approve",
  z.object({ accountId: id, approve: z.boolean(), reason: z.string().max(500).default("") }),
  async (input, { user }) => decideConnection(actingUserOf(user), input.accountId, input.approve, input.reason),
  REVALIDATE,
);

export const verifyAccountAction = defineAction("social:connect", z.object({ accountId: id }), async (input, { user }) => {
  await verifyAccount(actingUserOf(user), input.accountId);
}, REVALIDATE);

export const updateLimitsAction = defineAction("social:connect", limitsSchema.extend({ accountId: id }), async (input, { user }) => updateAccountLimits(actingUserOf(user), input.accountId, input), REVALIDATE);

export const disconnectAction = defineAction("social:connect", z.object({ accountId: id }), async (input, { user }) => disconnectAccount(actingUserOf(user), input.accountId), REVALIDATE);
