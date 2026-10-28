"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { recordAudit } from "@/server/audit";
import { actingUserOf, actorOf } from "@/server/auth/session";
import { collectAllNow } from "@/server/services/analytics-collect";
import { computeInsights, decideExperiment } from "@/server/services/insights";

/** Fetches due statistics for every connected account and recomputes the insights. */
export const collectNowAction = defineAction(
  "publishing:schedule",
  z.object({}),
  async (_input, { user }) => {
    await recordAudit(actorOf(user), { action: "analytics.collect_requested" });
    const collected = await collectAllNow();
    const insights = await computeInsights();
    return { ...collected, ...insights };
  },
  { revalidate: ["/analytics"] },
);

export const decideExperimentAction = defineAction(
  "autonomy:raise",
  z.object({ insightId: z.string().uuid(), accept: z.boolean(), reason: z.string().trim().max(500).default("") }),
  async (input, { user }) => decideExperiment(actingUserOf(user), input.insightId, input.accept, input.reason),
  { revalidate: ["/analytics"] },
);
