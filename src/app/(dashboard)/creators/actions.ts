"use server";

import { z } from "zod";
import { AUTONOMY_MODES, characterDraftSchema, creatorProfileSchema } from "@/lib/schemas/creator";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import { proposeCreator } from "@/server/services/creator-wizard";
import {
  changeCreatorStatus,
  createCreator,
  duplicateCreator,
  setAutonomyMode,
  updateCreator,
} from "@/server/services/creators";
import { changeBudget } from "@/server/services/policy-admin";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/creators", "/characters", "/"] };

export const proposeCreatorAction = defineAction("creators:edit", z.unknown(), async (input, { user }) =>
  proposeCreator(actingUserOf(user), input),
);

export const createCreatorAction = defineAction(
  "creators:edit",
  z.object({ profile: creatorProfileSchema, character: characterDraftSchema.optional(), proposalSource: z.string().max(40).optional() }),
  async (input, { user }) => createCreator(actingUserOf(user), input.profile, { character: input.character, proposalSource: input.proposalSource }),
  REVALIDATE,
);

export const updateCreatorAction = defineAction(
  "creators:edit",
  z.object({ creatorId: id, profile: creatorProfileSchema }),
  async (input, { user }) => updateCreator(actingUserOf(user), input.creatorId, input.profile),
  REVALIDATE,
);

// Lowest common permission; the service enforces the per-action rule (e.g. resume needs admin).
export const changeCreatorStatusAction = defineAction(
  "controls:pause",
  z.object({ creatorId: id, action: z.enum(["activate", "pause", "resume", "archive"]), reason: z.string().max(500).optional() }),
  async (input, { user }) => changeCreatorStatus(actingUserOf(user), input.creatorId, input.action, input.reason),
  REVALIDATE,
);

export const duplicateCreatorAction = defineAction(
  "creators:edit",
  z.object({ creatorId: id }),
  async (input, { user }) => duplicateCreator(actingUserOf(user), input.creatorId),
  REVALIDATE,
);

export const setAutonomyAction = defineAction(
  "creators:edit",
  z.object({ creatorId: id, mode: z.enum(AUTONOMY_MODES) }),
  async (input, { user }) => setAutonomyMode(actingUserOf(user), input.creatorId, input.mode),
  REVALIDATE,
);

export const setCreatorBudgetAction = defineAction(
  "budgets:lower",
  z.object({
    creatorId: id,
    period: z.enum(["DAY", "MONTH"]),
    amountEur: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "Enter an amount such as 150 or 150.50").nullable(),
  }),
  // Raising or removing a limit is filed as a request for the owner unless the owner makes it.
  async (input, { user }) => changeBudget(actingUserOf(user), { scope: "CREATOR", targetId: input.creatorId, period: input.period, limitEur: input.amountEur }),
  REVALIDATE,
);
