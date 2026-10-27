"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { recordAudit } from "@/server/audit";
import { actorOf } from "@/server/auth/session";
import { syncProviderRegistry } from "@/server/providers/catalog";

export const refreshProvidersAction = defineAction(
  "providers:manage",
  z.object({}),
  async (_input, { user }) => {
    await syncProviderRegistry();
    await recordAudit(actorOf(user), { action: "providers.status_refreshed" });
  },
  { revalidate: ["/providers"] },
);
