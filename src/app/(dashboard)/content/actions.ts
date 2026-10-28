"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import {
  approveContent,
  approveMedia,
  archiveContent,
  createBatch,
  createContent,
  produceBatch,
  regenerateShot,
  rejectContent,
  rejectMedia,
  resumeProduction,
  startProduction,
} from "@/server/services/content";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/content", "/media"] };

export const createContentAction = defineAction(
  "content:edit",
  z.unknown(),
  async (input, { user }) => {
    const item = await createContent(actingUserOf(user), input as never);
    return { id: item.id };
  },
  REVALIDATE,
);

export const createBatchAction = defineAction(
  "content:edit",
  z.unknown(),
  async (input, { user }) => {
    const batch = await createBatch(actingUserOf(user), input as never);
    return { id: batch.id };
  },
  REVALIDATE,
);

export const produceBatchAction = defineAction("generation:run", z.object({ batchId: id }), async (input, { user }) => produceBatch(actingUserOf(user), input.batchId), REVALIDATE);

export const startProductionAction = defineAction("generation:run", z.object({ itemId: id }), async (input, { user }) => startProduction(actingUserOf(user), input.itemId), REVALIDATE);

export const resumeProductionAction = defineAction("generation:run", z.object({ itemId: id }), async (input, { user }) => resumeProduction(actingUserOf(user), input.itemId), REVALIDATE);

export const regenerateShotAction = defineAction(
  "generation:run",
  z.object({ itemId: id, shot: z.number().int().min(0).max(9) }),
  async (input, { user }) => regenerateShot(actingUserOf(user), input.itemId, input.shot),
  REVALIDATE,
);

export const approveMediaAction = defineAction("content:approve", z.object({ assetId: id }), async (input, { user }) => approveMedia(actingUserOf(user), input.assetId), REVALIDATE);

export const rejectMediaAction = defineAction(
  "content:approve",
  z.object({ assetId: id, reason: z.string().max(500).default("") }),
  async (input, { user }) => rejectMedia(actingUserOf(user), input.assetId, input.reason),
  REVALIDATE,
);

export const approveContentAction = defineAction(
  "content:approve",
  z.object({ itemId: id, overrideReason: z.string().max(500).default("") }),
  async (input, { user }) => approveContent(actingUserOf(user), input.itemId, input.overrideReason),
  REVALIDATE,
);

export const rejectContentAction = defineAction(
  "content:approve",
  z.object({ itemId: id, reason: z.string().max(500) }),
  async (input, { user }) => rejectContent(actingUserOf(user), input.itemId, input.reason),
  REVALIDATE,
);

export const archiveContentAction = defineAction("content:edit", z.object({ itemId: id }), async (input, { user }) => archiveContent(actingUserOf(user), input.itemId), REVALIDATE);
