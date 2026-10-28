"use server";

import { z } from "zod";
import { toMicros } from "@/lib/money";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import { campaignSchema, changeCampaignStatus, createCampaign, setCampaignBudget, updateCampaign } from "@/server/services/campaigns";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/campaigns", "/content", "/calendar"] };

export const createCampaignAction = defineAction("content:edit", campaignSchema, async (input, { user }) => ({ id: (await createCampaign(actingUserOf(user), input)).id }), REVALIDATE);

export const updateCampaignAction = defineAction("content:edit", z.object({ campaignId: id, campaign: campaignSchema }), async (input, { user }) => updateCampaign(actingUserOf(user), input.campaignId, input.campaign), REVALIDATE);

export const campaignStatusAction = defineAction(
  "dashboard:view",
  z.object({ campaignId: id, action: z.enum(["activate", "pause", "resume", "complete", "archive"]), reason: z.string().max(300).default("") }),
  async (input, { user }) => changeCampaignStatus(actingUserOf(user), input.campaignId, input.action, input.reason),
  REVALIDATE,
);

export const campaignBudgetAction = defineAction(
  "budgets:lower",
  z.object({ campaignId: id, period: z.enum(["DAY", "MONTH"]), limitEur: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "Use an amount such as 250 or 99.50").nullable() }),
  async (input, { user }) => setCampaignBudget(actingUserOf(user), input.campaignId, input.period, input.limitEur === null ? null : toMicros(input.limitEur)),
  REVALIDATE,
);
