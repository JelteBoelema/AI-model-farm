"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { recordAudit } from "@/server/audit";
import { actorOf } from "@/server/auth/session";
import { setProviderEnabled, setProviderPricing, syncProviderRegistry, updateProviderConfig, verifyProvider } from "@/server/providers/registry";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/providers"] };

export const refreshProvidersAction = defineAction(
  "providers:manage",
  z.object({}),
  async (_input, { user }) => {
    await syncProviderRegistry();
    await recordAudit(actorOf(user), { action: "providers.status_refreshed" });
  },
  REVALIDATE,
);

export const verifyProviderAction = defineAction("providers:manage", z.object({ providerId: id }), async (input, { user }) => verifyProvider(actorOf(user), input.providerId), REVALIDATE);

export const updateProviderConfigAction = defineAction(
  "providers:manage",
  z.object({
    providerId: id,
    config: z.object({
      model: z.string().trim().min(1).max(100).optional(),
      bulkModel: z.string().trim().min(1).max(100).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      imageSize: z.enum(["1024x1024", "1024x1536", "1536x1024"]).optional(),
      imageQuality: z.enum(["low", "medium", "high"]).optional(),
      voiceId: z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/, "Voice ids are 8–64 letters and digits").optional(),
      maxRequestsPerMinute: z.number().int().min(1).max(10_000),
      timeoutMs: z.number().int().min(5_000).max(600_000),
    }),
  }),
  async (input, { user }) => updateProviderConfig(actorOf(user), input.providerId, input.config),
  REVALIDATE,
);

export const setProviderPricingAction = defineAction(
  "providers:manage",
  z.object({ providerId: id, pricing: z.unknown() }),
  async (input, { user }) => setProviderPricing(actorOf(user), input.providerId, input.pricing),
  REVALIDATE,
);

export const setProviderEnabledAction = defineAction(
  "providers:manage",
  z.object({ providerId: id, enabled: z.boolean() }),
  async (input, { user }) => setProviderEnabled(actorOf(user), input.providerId, input.enabled),
  REVALIDATE,
);
