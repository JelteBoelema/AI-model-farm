"use server";

import { z } from "zod";
import { characterDraftSchema } from "@/lib/schemas/creator";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import { DomainError } from "@/server/errors";
import {
  addReference,
  approveVersion,
  createDraftVersion,
  removeReference,
  setReferenceCanonical,
  updateDraft,
} from "@/server/services/characters";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/characters", "/creators"] };

export const createDraftAction = defineAction(
  "creators:edit",
  z.object({ creatorId: id }),
  async (input, { user }) => {
    const draft = await createDraftVersion(actingUserOf(user), input.creatorId);
    return { id: draft.id, version: draft.version };
  },
  REVALIDATE,
);

export const updateDraftAction = defineAction(
  "creators:edit",
  z.object({ profileId: id, draft: characterDraftSchema }),
  async (input, { user }) => updateDraft(actingUserOf(user), input.profileId, input.draft),
  REVALIDATE,
);

export const approveVersionAction = defineAction(
  "content:approve",
  z.object({ profileId: id, attestation: z.string().max(1000) }),
  async (input, { user }) => approveVersion(actingUserOf(user), input.profileId, input.attestation),
  REVALIDATE,
);

export const uploadReferenceAction = defineAction(
  "creators:edit",
  z.instanceof(FormData),
  async (form, { user }) => {
    const file = form.get("file");
    const profileId = id.safeParse(form.get("profileId"));
    if (!(file instanceof File) || !profileId.success) throw new DomainError("Choose an image to upload");
    await addReference(actingUserOf(user), profileId.data, {
      bytes: Buffer.from(await file.arrayBuffer()),
      label: String(form.get("label") ?? ""),
      rightsNote: String(form.get("rightsNote") ?? ""),
      canonical: form.get("canonical") === "on",
    });
  },
  REVALIDATE,
);

export const removeReferenceAction = defineAction(
  "creators:edit",
  z.object({ referenceId: id }),
  async (input, { user }) => removeReference(actingUserOf(user), input.referenceId),
  REVALIDATE,
);

export const setCanonicalAction = defineAction(
  "creators:edit",
  z.object({ referenceId: id, canonical: z.boolean() }),
  async (input, { user }) => setReferenceCanonical(actingUserOf(user), input.referenceId, input.canonical),
  REVALIDATE,
);
