// Media helpers shared by the generation workers: storing generated output with full provenance and
// loading the character's canonical references.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { sniffImage } from "@/lib/image-meta";
import { sha256Hex } from "../crypto";
import { db } from "../db";
import type { ReferenceImage } from "../providers/types";
import { buildStorageKey, storage } from "../storage";

export async function canonicalReferences(creatorId: string, max = 4): Promise<ReferenceImage[]> {
  const profile = await db.characterProfile.findFirst({
    where: { creatorId, status: "APPROVED" },
    include: { references: { where: { isCanonical: true }, include: { mediaAsset: true }, orderBy: { createdAt: "asc" }, take: max } },
  });
  const refs: ReferenceImage[] = [];
  for (const r of profile?.references ?? []) refs.push({ bytes: await storage().get(r.mediaAsset.storageKey), mimeType: r.mediaAsset.mimeType });
  return refs;
}

export interface GeneratedImageInput {
  bytes: Buffer;
  mimeType?: string;
  creatorId: string | null;
  contentItemId?: string | null;
  generationJobId?: string | null;
  shotIndex?: number | null;
  providerKey: string;
  modelVersion: string;
  prompt: string;
  params: Record<string, unknown>;
  isMock: boolean;
}

/** Writes the object first (keys are never reused), then the row; an orphaned object is harmless. */
export async function storeGeneratedImage(input: GeneratedImageInput, tx: Prisma.TransactionClient | typeof db = db) {
  const meta = sniffImage(input.bytes);
  const key = buildStorageKey({ creatorId: input.creatorId, kind: "generated", id: randomUUID(), extension: meta?.extension ?? "png" });
  const mimeType = meta?.mimeType ?? input.mimeType ?? "image/png";
  await storage().put(key, input.bytes, mimeType);
  return tx.mediaAsset.create({
    data: {
      creatorId: input.creatorId,
      contentItemId: input.contentItemId ?? null,
      generationJobId: input.generationJobId ?? null,
      shotIndex: input.shotIndex ?? null,
      kind: "IMAGE",
      source: "GENERATED",
      status: "PENDING_REVIEW",
      storageKey: key,
      mimeType,
      sizeBytes: BigInt(input.bytes.length),
      checksumSha256: sha256Hex(input.bytes),
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      providerKey: input.providerKey,
      modelVersion: input.modelVersion,
      promptSnapshot: input.prompt,
      paramsSnapshot: input.params as Prisma.InputJsonValue,
      isMock: input.isMock,
    },
  });
}
