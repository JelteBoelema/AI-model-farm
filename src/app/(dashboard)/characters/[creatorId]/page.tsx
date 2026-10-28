import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CharacterDraftForm } from "@/components/characters/character-draft-form";
import { ReferenceGrid, ReferenceUploader, type ReferenceView } from "@/components/characters/references";
import { ApproveVersionDialog, NewDraftButton } from "@/components/characters/version-actions";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/rbac";
import { characterDraftSchema, type CharacterDraftInput } from "@/lib/schemas/creator";
import { cn, formatDateTime } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { storage } from "@/server/storage";

export const metadata: Metadata = { title: "Character Studio" };

type Props = { params: Promise<{ creatorId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const EMPTY_DRAFT: CharacterDraftInput = {
  appearance: { ageRange: "", build: "", skinTone: "", hair: "", eyes: "", face: "", distinguishingFeatures: "", wardrobe: "" },
  identityPrompt: "",
  negativePrompt: "",
  consistencyStrategy: { referenceWeight: 0.8, seed: null, notes: "" },
};

export default async function CharacterStudioPage({ params, searchParams }: Props) {
  const { creatorId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(creatorId)) notFound();
  const sp = await searchParams;
  const user = await requireUser();
  const creator = await db.creator.findUnique({ where: { id: creatorId }, select: { id: true, name: true, status: true } });
  if (!creator) notFound();
  const versions = await db.characterProfile.findMany({
    where: { creatorId },
    orderBy: { version: "desc" },
    include: { references: { orderBy: { createdAt: "asc" }, include: { mediaAsset: true } } },
  });

  const requested = Number(typeof sp.v === "string" ? sp.v : NaN);
  const selected =
    versions.find((v) => v.version === requested) ?? versions.find((v) => v.status === "DRAFT") ?? versions.find((v) => v.status === "APPROVED") ?? versions[0];
  const archived = creator.status === "ARCHIVED";
  const editable = selected?.status === "DRAFT" && !archived && can(user.role, "creators:edit");
  const hasDraft = versions.some((v) => v.status === "DRAFT");

  const parsed = selected
    ? characterDraftSchema.safeParse({
        appearance: { ...EMPTY_DRAFT.appearance, ...(selected.appearance as object) },
        identityPrompt: selected.identityPrompt,
        negativePrompt: selected.negativePrompt,
        consistencyStrategy: { ...EMPTY_DRAFT.consistencyStrategy, ...(selected.consistencyStrategy as object) },
      })
    : null;
  // Incomplete drafts do not pass the schema yet; show their raw values for editing.
  const draftValues: CharacterDraftInput = parsed?.success
    ? parsed.data
    : selected
      ? {
          appearance: { ...EMPTY_DRAFT.appearance, ...(selected.appearance as object) },
          identityPrompt: selected.identityPrompt,
          negativePrompt: selected.negativePrompt,
          consistencyStrategy: { ...EMPTY_DRAFT.consistencyStrategy, ...(selected.consistencyStrategy as object) },
        }
      : EMPTY_DRAFT;

  const references: ReferenceView[] = selected
    ? await Promise.all(
        selected.references.map(async (r) => ({
          id: r.id,
          label: r.label,
          isCanonical: r.isCanonical,
          url: await storage().previewUrl(r.mediaAsset.storageKey),
          width: r.mediaAsset.width,
          height: r.mediaAsset.height,
          rightsNote: r.mediaAsset.rightsNote,
        })),
      )
    : [];

  return (
    <>
      <PageHeader
        title={`Character Studio · ${creator.name}`}
        description="Approved versions are immutable; generations pin the version they used."
        actions={
          <>
            <Link href={`/creators/${creator.id}`} className="text-sm text-primary hover:underline">
              Creator profile
            </Link>
            {!hasDraft && !archived && can(user.role, "creators:edit") ? <NewDraftButton creatorId={creator.id} /> : null}
          </>
        }
      />

      {!selected ? (
        <Card>
          <EmptyState title="No character versions yet" description="Create the first draft version to define this creator's visual identity." />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[14rem_1fr]">
          <nav aria-label="Versions" className="flex gap-2 overflow-x-auto xl:flex-col">
            {versions.map((v) => (
              <Link
                key={v.id}
                href={`/characters/${creator.id}?v=${v.version}`}
                aria-current={v.id === selected.id ? "page" : undefined}
                className={cn(
                  "flex min-w-40 flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm transition-colors hover:bg-accent",
                  v.id === selected.id && "ring-2 ring-primary/40",
                )}
              >
                <span className="flex items-center justify-between gap-2 font-medium">
                  Version {v.version} <StatusBadge status={v.status} />
                </span>
                <span className="text-xs text-muted-foreground">{formatDateTime(v.approvedAt ?? v.createdAt)}</span>
              </Link>
            ))}
          </nav>

          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle>Version {selected.version}</CardTitle>
                  <CardDescription>
                    {selected.status === "DRAFT"
                      ? "Draft — editable. Approval needs a complete description, a canonical reference and a likeness attestation."
                      : selected.likenessAttestation
                        ? `Attestation: ${selected.likenessAttestation}`
                        : "Read-only."}
                  </CardDescription>
                </div>
                {editable && can(user.role, "content:approve") ? <ApproveVersionDialog profileId={selected.id} version={selected.version} /> : null}
              </CardHeader>
              <CardContent>
                <CharacterDraftForm key={selected.id} profileId={selected.id} initial={draftValues} readOnly={!editable} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Reference images</CardTitle>
                <CardDescription>Canonical references anchor the identity for reference-conditioned generation.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <ReferenceGrid references={references} editable={editable} />
                {editable ? <ReferenceUploader profileId={selected.id} /> : null}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
