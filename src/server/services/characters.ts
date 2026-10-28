// Character Engine: versioned visual identities. Only DRAFT versions are editable; approving a draft
// supersedes the previous approved version in the same transaction, so generations always pin one
// immutable identity.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { can, type Permission } from "@/lib/rbac";
import { sniffImage } from "@/lib/image-meta";
import { characterDraftSchema, likenessAttestationSchema, type CharacterDraftInput } from "@/lib/schemas/creator";
import { assertTransition } from "@/lib/state-machines";
import { db } from "../db";
import { recordAudit } from "../audit";
import { sha256Hex } from "../crypto";
import { DomainError } from "../errors";
import { buildStorageKey, storage } from "../storage";
import type { ActingUser } from "./users";

export const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
export const MIN_REFERENCE_SIDE = 512;
export const MAX_REFERENCE_SIDE = 8192;
export const MAX_REFERENCES = 12;

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

async function loadDraft(profileId: string) {
  const profile = await db.characterProfile.findUnique({ where: { id: profileId }, include: { creator: { select: { status: true } } } });
  if (!profile) throw new DomainError("Character profile not found");
  if (profile.status !== "DRAFT") throw new DomainError("Approved and superseded versions are immutable; create a new draft");
  if (profile.creator.status === "ARCHIVED") throw new DomainError("The creator is archived");
  return profile;
}

/** New draft version, copied from the approved (or latest) version including its references. */
export async function createDraftVersion(by: ActingUser, creatorId: string) {
  require(by, "creators:edit");
  const creator = await db.creator.findUnique({ where: { id: creatorId }, select: { status: true } });
  if (!creator) throw new DomainError("Creator not found");
  if (creator.status === "ARCHIVED") throw new DomainError("The creator is archived");
  const versions = await db.characterProfile.findMany({ where: { creatorId }, orderBy: { version: "desc" }, include: { references: true } });
  if (versions.some((v) => v.status === "DRAFT")) throw new DomainError("This creator already has a draft version");
  const base = versions.find((v) => v.status === "APPROVED") ?? versions[0];
  const version = (versions[0]?.version ?? 0) + 1;

  return db.$transaction(async (tx) => {
    const draft = await tx.characterProfile.create({
      data: {
        creatorId,
        version,
        status: "DRAFT",
        appearance: (base?.appearance ?? { ageRange: "" }) as Prisma.InputJsonValue,
        identityPrompt: base?.identityPrompt ?? "",
        negativePrompt: base?.negativePrompt ?? "",
        consistencyStrategy: (base?.consistencyStrategy ?? { referenceWeight: 0.8, seed: null, notes: "" }) as Prisma.InputJsonValue,
      },
    });
    if (base?.references.length) {
      await tx.characterReference.createMany({
        data: base.references.map((r) => ({ characterProfileId: draft.id, mediaAssetId: r.mediaAssetId, label: r.label, isCanonical: r.isCanonical })),
      });
    }
    await recordAudit(by.actor, { action: "character.draft_created", entityType: "character_profile", entityId: draft.id, metadata: { creatorId, version, basedOn: base?.version ?? null } }, tx);
    return draft;
  });
}

export async function updateDraft(by: ActingUser, profileId: string, raw: CharacterDraftInput) {
  require(by, "creators:edit");
  const input = characterDraftSchema.parse(raw);
  await loadDraft(profileId);
  await db.$transaction(async (tx) => {
    const res = await tx.characterProfile.updateMany({
      where: { id: profileId, status: "DRAFT" },
      data: {
        appearance: input.appearance as Prisma.InputJsonValue,
        identityPrompt: input.identityPrompt,
        negativePrompt: input.negativePrompt,
        consistencyStrategy: input.consistencyStrategy as Prisma.InputJsonValue,
      },
    });
    if (res.count !== 1) throw new DomainError("This version was approved meanwhile");
    await recordAudit(by.actor, { action: "character.draft_updated", entityType: "character_profile", entityId: profileId }, tx);
  });
}

export async function approveVersion(by: ActingUser, profileId: string, attestationRaw: string) {
  require(by, "content:approve");
  const attestation = likenessAttestationSchema.parse(attestationRaw);
  const draft = await loadDraft(profileId);
  const check = characterDraftSchema.safeParse({
    appearance: draft.appearance,
    identityPrompt: draft.identityPrompt,
    negativePrompt: draft.negativePrompt,
    consistencyStrategy: draft.consistencyStrategy,
  });
  if (!check.success) throw new DomainError(`The draft is incomplete: ${check.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const canonical = await db.characterReference.count({ where: { characterProfileId: profileId, isCanonical: true } });
  if (canonical === 0) throw new DomainError("Mark at least one reference image as canonical before approving");

  assertTransition("characterProfile", "DRAFT", "APPROVED");
  await db.$transaction(async (tx) => {
    const previous = await tx.characterProfile.findFirst({ where: { creatorId: draft.creatorId, status: "APPROVED" }, select: { id: true, version: true } });
    if (previous) {
      assertTransition("characterProfile", "APPROVED", "SUPERSEDED");
      await tx.characterProfile.update({ where: { id: previous.id }, data: { status: "SUPERSEDED" } });
    }
    const res = await tx.characterProfile.updateMany({
      where: { id: profileId, status: "DRAFT" },
      data: { status: "APPROVED", approvedAt: new Date(), approvedById: by.id, likenessAttestation: attestation },
    });
    if (res.count !== 1) throw new DomainError("This version changed meanwhile");
    await recordAudit(
      by.actor,
      { action: "character.approved", entityType: "character_profile", entityId: profileId, metadata: { creatorId: draft.creatorId, version: draft.version, superseded: previous?.version ?? null } },
      tx,
    );
  });
}

export interface ReferenceUpload {
  bytes: Buffer;
  label: string;
  rightsNote: string;
  canonical: boolean;
}

export async function addReference(by: ActingUser, profileId: string, upload: ReferenceUpload) {
  require(by, "creators:edit");
  const draft = await loadDraft(profileId);
  const label = upload.label.trim().slice(0, 60);
  const rightsNote = upload.rightsNote.trim();
  if (label.length < 2) throw new DomainError("Give the reference a label, e.g. 'front, neutral light'");
  if (rightsNote.length < 10) throw new DomainError("Record the source and rights of this image (licence, consent or 'generated by …')");
  if (upload.bytes.length === 0) throw new DomainError("The file is empty");
  if (upload.bytes.length > MAX_REFERENCE_BYTES) throw new DomainError("Reference images may be at most 15 MB");

  const meta = sniffImage(upload.bytes);
  if (!meta) throw new DomainError("Only PNG, JPEG or WebP images are accepted");
  if (Math.min(meta.width, meta.height) < MIN_REFERENCE_SIDE) throw new DomainError(`References need at least ${MIN_REFERENCE_SIDE}px on the short side`);
  if (Math.max(meta.width, meta.height) > MAX_REFERENCE_SIDE) throw new DomainError(`References may be at most ${MAX_REFERENCE_SIDE}px on the long side`);

  const count = await db.characterReference.count({ where: { characterProfileId: profileId } });
  if (count >= MAX_REFERENCES) throw new DomainError(`A version can hold at most ${MAX_REFERENCES} references`);

  const checksum = sha256Hex(upload.bytes);
  let asset = await db.mediaAsset.findFirst({ where: { creatorId: draft.creatorId, checksumSha256: checksum, source: "UPLOADED" } });
  if (asset && (await db.characterReference.findFirst({ where: { characterProfileId: profileId, mediaAssetId: asset.id } })))
    throw new DomainError("This image is already a reference of this version");

  let storedKey: string | null = null;
  if (!asset) {
    const id = randomUUID();
    storedKey = buildStorageKey({ creatorId: draft.creatorId, kind: "references", id, extension: meta.extension });
    await storage().put(storedKey, upload.bytes, meta.mimeType);
  }
  try {
    return await db.$transaction(async (tx) => {
      asset ??= await tx.mediaAsset.create({
        data: {
          creatorId: draft.creatorId,
          kind: "IMAGE",
          source: "UPLOADED",
          status: "APPROVED",
          storageKey: storedKey!,
          mimeType: meta.mimeType,
          sizeBytes: BigInt(upload.bytes.length),
          checksumSha256: checksum,
          width: meta.width,
          height: meta.height,
          rightsNote,
        },
      });
      const ref = await tx.characterReference.create({
        data: { characterProfileId: profileId, mediaAssetId: asset.id, label, isCanonical: upload.canonical },
      });
      await recordAudit(
        by.actor,
        { action: "character.reference_added", entityType: "character_profile", entityId: profileId, metadata: { mediaAssetId: asset.id, label, canonical: upload.canonical, width: meta.width, height: meta.height } },
        tx,
      );
      return ref;
    });
  } catch (err) {
    if (storedKey) await storage().delete(storedKey).catch(() => undefined); // no orphaned objects
    throw err;
  }
}

async function loadReferenceOfDraft(referenceId: string) {
  const ref = await db.characterReference.findUnique({ where: { id: referenceId }, select: { id: true, characterProfileId: true } });
  if (!ref) throw new DomainError("Reference not found");
  await loadDraft(ref.characterProfileId);
  return ref;
}

export async function removeReference(by: ActingUser, referenceId: string) {
  require(by, "creators:edit");
  const ref = await loadReferenceOfDraft(referenceId);
  await db.$transaction(async (tx) => {
    await tx.characterReference.delete({ where: { id: referenceId } });
    await recordAudit(by.actor, { action: "character.reference_removed", entityType: "character_profile", entityId: ref.characterProfileId, metadata: { referenceId } }, tx);
  });
}

export async function setReferenceCanonical(by: ActingUser, referenceId: string, canonical: boolean) {
  require(by, "creators:edit");
  const ref = await loadReferenceOfDraft(referenceId);
  await db.$transaction(async (tx) => {
    await tx.characterReference.update({ where: { id: referenceId }, data: { isCanonical: canonical } });
    await recordAudit(by.actor, { action: "character.reference_updated", entityType: "character_profile", entityId: ref.characterProfileId, metadata: { referenceId, canonical } }, tx);
  });
}
