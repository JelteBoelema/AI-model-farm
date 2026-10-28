"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import {
  createDraftVersion,
  createTemplate,
  createTemplateSchema,
  deprecateVersion,
  draftSchema,
  pinVersion,
  publishVersion,
  renderVersion,
  runPromptTest,
  saveDraft,
  setTemplateArchived,
  testRunSchema,
} from "@/server/services/prompts";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/prompts"] };

export const createTemplateAction = defineAction(
  "prompts:edit",
  createTemplateSchema,
  async (input, { user }) => createTemplate(actingUserOf(user), input),
  REVALIDATE,
);

export const saveDraftAction = defineAction(
  "prompts:edit",
  z.object({ versionId: id, draft: draftSchema }),
  async (input, { user }) => saveDraft(actingUserOf(user), input.versionId, input.draft),
  REVALIDATE,
);

export const createPromptDraftAction = defineAction(
  "prompts:edit",
  z.object({ templateId: id }),
  async (input, { user }) => {
    const v = await createDraftVersion(actingUserOf(user), input.templateId);
    return { version: v.version };
  },
  REVALIDATE,
);

// Lowest common permission; the service requires an admin for global and rule templates.
export const publishPromptAction = defineAction(
  "prompts:edit",
  z.object({ versionId: id, changelog: z.string().max(500) }),
  async (input, { user }) => publishVersion(actingUserOf(user), input.versionId, input.changelog),
  REVALIDATE,
);

export const deprecatePromptAction = defineAction(
  "prompts:edit",
  z.object({ versionId: id }),
  async (input, { user }) => deprecateVersion(actingUserOf(user), input.versionId),
  REVALIDATE,
);

export const pinPromptAction = defineAction(
  "prompts:edit",
  z.object({ campaignId: id, templateId: id, versionId: id.nullable() }),
  async (input, { user }) => pinVersion(actingUserOf(user), input.campaignId, input.versionId, input.templateId),
  REVALIDATE,
);

export const archiveTemplateAction = defineAction(
  "prompts:edit",
  z.object({ templateId: id, archived: z.boolean() }),
  async (input, { user }) => setTemplateArchived(actingUserOf(user), input.templateId, input.archived),
  REVALIDATE,
);

export const previewPromptAction = defineAction("prompts:edit", testRunSchema, async (input) =>
  renderVersion(input.versionId, input.values, { creatorId: input.creatorId, campaignId: input.campaignId }),
);

export const runPromptTestAction = defineAction(
  "prompts:edit",
  testRunSchema,
  async (input, { user }) => {
    const run = await runPromptTest(actingUserOf(user), input);
    return { id: run.id, status: run.status };
  },
  REVALIDATE,
);
