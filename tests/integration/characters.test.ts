import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { sha256Hex } from "@/server/crypto";
import { DomainError } from "@/server/errors";
import { storage } from "@/server/storage";
import {
  addReference,
  approveVersion,
  createDraftVersion,
  removeReference,
  setReferenceCanonical,
  updateDraft,
} from "@/server/services/characters";
import { acting, makeCreator, makeUser } from "./helpers";

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures", name));
const ATTEST = "Synthetic identity; references are generated, not photos of a real person.";
const draftInput = {
  appearance: { ageRange: "25-30", build: "slim", skinTone: "", hair: "auburn waves", eyes: "green", face: "", distinguishingFeatures: "", wardrobe: "" },
  identityPrompt: "Synthetic adult woman, auburn wavy hair, green eyes, light freckles",
  negativePrompt: "real people",
  consistencyStrategy: { referenceWeight: 0.85, seed: 42, notes: "" },
};
const upload = (file: string, extra: Partial<{ label: string; rightsNote: string; canonical: boolean }> = {}) => ({
  bytes: fixture(file),
  label: "front",
  rightsNote: "Generated with mock-image for tests",
  canonical: true,
  ...extra,
});

describe("character versions", () => {
  it("full flow: draft → references → approve → immutable → new draft → supersede", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const creator = await makeCreator({ status: "DRAFT" });

    const v1 = await createDraftVersion(op, creator.id);
    expect(v1.version).toBe(1);
    await expect(createDraftVersion(op, creator.id)).rejects.toThrow(/already has a draft/);

    await expect(approveVersion(op, v1.id, ATTEST)).rejects.toThrow(/incomplete/);
    await updateDraft(op, v1.id, draftInput);
    await expect(approveVersion(op, v1.id, ATTEST)).rejects.toThrow(/canonical/);

    const ref = await addReference(op, v1.id, upload("ref-600.png"));
    const asset = await db.mediaAsset.findFirstOrThrow({ where: { characterReferences: { some: { id: ref.id } } } });
    expect(asset).toMatchObject({ kind: "IMAGE", source: "UPLOADED", mimeType: "image/png", width: 600, height: 600, isMock: false });
    expect(asset.checksumSha256).toBe(sha256Hex(fixture("ref-600.png")));
    expect(asset.storageKey).toMatch(new RegExp(`^creators/${creator.id}/references/\\d{4}/\\d{2}/[0-9a-f-]+\\.png$`));
    expect(await storage().exists(asset.storageKey)).toBe(true);

    await expect(approveVersion(op, v1.id, "too short")).rejects.toThrow();
    await approveVersion(op, v1.id, ATTEST);
    const approved = await db.characterProfile.findUniqueOrThrow({ where: { id: v1.id } });
    expect(approved).toMatchObject({ status: "APPROVED", approvedById: op.id, likenessAttestation: ATTEST });

    // approved versions are immutable
    await expect(updateDraft(op, v1.id, draftInput)).rejects.toThrow(/immutable/);
    await expect(addReference(op, v1.id, upload("ref-640x512.jpg"))).rejects.toThrow(/immutable/);
    await expect(removeReference(op, ref.id)).rejects.toThrow(/immutable/);

    // new draft copies the identity and its references
    const v2 = await createDraftVersion(op, creator.id);
    expect(v2.version).toBe(2);
    expect(v2.identityPrompt).toBe(draftInput.identityPrompt);
    const v2refs = await db.characterReference.findMany({ where: { characterProfileId: v2.id } });
    expect(v2refs.map((r) => r.mediaAssetId)).toEqual([asset.id]);

    await approveVersion(op, v2.id, ATTEST);
    const statuses = await db.characterProfile.findMany({ where: { creatorId: creator.id }, orderBy: { version: "asc" }, select: { status: true } });
    expect(statuses.map((s) => s.status)).toEqual(["SUPERSEDED", "APPROVED"]);
    expect(await db.auditLog.count({ where: { action: "character.approved", entityId: { in: [v1.id, v2.id] } } })).toBe(2);
  });

  it("validates uploads by content, size, dimensions, rights and duplicates", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const creator = await makeCreator({ status: "DRAFT" });
    const draft = await createDraftVersion(op, creator.id);

    await expect(addReference(op, draft.id, { ...upload("ref-600.png"), bytes: Buffer.from("<svg onload=alert(1)>") })).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(addReference(op, draft.id, upload("small-100.png"))).rejects.toThrow(/at least 512px/);
    await expect(addReference(op, draft.id, upload("ref-600.png", { rightsNote: "" }))).rejects.toThrow(/source and rights/);
    await expect(addReference(op, draft.id, upload("ref-600.png", { label: "" }))).rejects.toThrow(/label/);
    await expect(addReference(op, draft.id, { ...upload("ref-600.png"), bytes: Buffer.alloc(16 * 1024 * 1024) })).rejects.toThrow(/15 MB/);

    const webp = await addReference(op, draft.id, upload("ref-512x520.webp", { canonical: false }));
    await expect(addReference(op, draft.id, upload("ref-512x520.webp"))).rejects.toThrow(/already a reference/);
    expect(await db.mediaAsset.count({ where: { creatorId: creator.id } })).toBe(1);

    await setReferenceCanonical(op, webp.id, true);
    expect((await db.characterReference.findUniqueOrThrow({ where: { id: webp.id } })).isCanonical).toBe(true);
    await removeReference(op, webp.id);
    expect(await db.characterReference.count({ where: { characterProfileId: draft.id } })).toBe(0);
    expect(await db.mediaAsset.count({ where: { creatorId: creator.id } })).toBe(1); // asset is kept for history
  });

  it("enforces roles", async () => {
    const viewer = acting(await makeUser("VIEWER"));
    const creator = await makeCreator({ status: "DRAFT" });
    await expect(createDraftVersion(viewer, creator.id)).rejects.toBeInstanceOf(DomainError);
  });
});
