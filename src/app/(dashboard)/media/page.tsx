import type { Metadata } from "next";
import Link from "next/link";
import type { MediaStatus, Prisma } from "@prisma/client";
import { Images } from "lucide-react";
import { MediaGrid, type MediaTile } from "@/components/content/media-grid";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { parseFilters, periodStart } from "@/lib/filters";
import { can } from "@/lib/rbac";
import { cn, formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { storage } from "@/server/storage";

export const metadata: Metadata = { title: "Media Library" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUS_TABS: { label: string; value: MediaStatus | null }[] = [
  { label: "All", value: null },
  { label: "Pending review", value: "PENDING_REVIEW" },
  { label: "Approved", value: "APPROVED" },
  { label: "Rejected", value: "REJECTED" },
];
const SOURCES = { generated: "GENERATED", uploaded: "UPLOADED" } as const;

export default async function MediaPage({ searchParams }: Props) {
  const raw = await searchParams;
  const user = await requireUser();
  const f = parseFilters(raw);
  const since = periodStart(f.period);
  const status = STATUS_TABS.find((t) => t.value === f.status)?.value ?? null;
  const source = typeof raw.source === "string" && raw.source in SOURCES ? SOURCES[raw.source as keyof typeof SOURCES] : null;
  const where: Prisma.MediaAssetWhereInput = {
    kind: "IMAGE",
    ...(f.creator ? { creatorId: f.creator } : {}),
    ...(f.campaign ? { contentItem: { campaignId: f.campaign } } : {}),
    ...(since ? { createdAt: { gte: since } } : {}),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
  };
  const assets = await db.mediaAsset.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 60,
    include: { creator: { select: { name: true } }, contentItem: { select: { id: true, title: true, status: true } } },
  });
  const tiles: MediaTile[] = await Promise.all(
    assets.map(async (a) => ({
      id: a.id,
      url: await storage().previewUrl(a.storageKey),
      title: a.contentItem ? `${a.contentItem.title}${a.shotIndex !== null ? ` · shot ${a.shotIndex + 1}` : ""}` : a.source === "UPLOADED" ? "Reference upload" : "Prompt test output",
      subtitle: `${a.creator?.name ?? "Shared"} · ${a.providerKey ?? humanize(a.source)} · ${formatDateTime(a.createdAt)}`,
      status: a.status,
      isMock: a.isMock,
      // Reference uploads are reviewed in Character Studio; content takes only while the item is in review.
      reviewable: a.source === "GENERATED" && (!a.contentItem || a.contentItem.status === "QC_REVIEW" || a.contentItem.status === "READY") && a.status !== "ARCHIVED",
      qualityScore: a.qualityScore,
      href: a.contentItem ? `/content/${a.contentItem.id}` : null,
    })),
  );
  const tabHref = (value: string | null, key = "status") => {
    const next = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    if (value) next.set(key, value);
    else next.delete(key);
    return `/media${next.size ? `?${next}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Media Library" description="Assets live in object storage; the database keeps checksum, provenance, prompt, parameters and quality reports." />
      <nav className="flex flex-wrap gap-1 text-sm" aria-label="Media status">
        {STATUS_TABS.map((t) => (
          <Link key={t.label} href={tabHref(t.value)} className={cn("rounded-md px-3 py-1.5", status === t.value ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}>
            {t.label}
          </Link>
        ))}
        <span className="mx-2 self-center text-muted-foreground">·</span>
        {(["generated", "uploaded"] as const).map((s) => (
          <Link key={s} href={tabHref(source === SOURCES[s] ? null : s, "source")} className={cn("rounded-md px-3 py-1.5", source === SOURCES[s] ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}>
            {humanize(s)}
          </Link>
        ))}
      </nav>
      <Card>
        <CardContent className="pt-5">
          {tiles.length === 0 ? (
            <EmptyState icon={Images} title="No images in this view" description="Generated images and reference uploads appear here." />
          ) : (
            <MediaGrid tiles={tiles} canReview={can(user.role, "content:approve")} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
