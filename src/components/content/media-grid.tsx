"use client";

import Link from "next/link";
import { useState } from "react";
import { Columns2 } from "lucide-react";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MediaReviewButtons } from "./content-actions";

export interface MediaTile {
  id: string;
  kind: "image" | "video";
  url: string;
  title: string;
  subtitle: string;
  status: string;
  isMock: boolean;
  reviewable: boolean;
  qualityScore: number | null;
  href: string | null;
}

/** Preview grid; pick two tiles to compare them side by side. */
export function MediaGrid({ tiles, canReview }: { tiles: MediaTile[]; canReview: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{picked.length === 0 ? "Select two assets to compare them." : `${picked.length} of 2 selected`}</span>
        {picked.length === 2 ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/media/compare?a=${picked[0]}&b=${picked[1]}`}>
              <Columns2 /> Compare
            </Link>
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
        {tiles.map((t) => (
          <figure key={t.id} className={cn("grid min-w-0 content-start gap-2 rounded-lg border bg-card p-2", picked.includes(t.id) && "ring-2 ring-primary")}>
            {t.kind === "video" ? (
              <video controls muted preload="metadata" src={`${t.url}#t=0.5`} className="aspect-square w-full rounded-md bg-black object-contain" aria-label={t.title} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
              <img src={t.url} alt={t.title} loading="lazy" className="aspect-square w-full rounded-md bg-muted object-contain" />
            )}
            <figcaption className="grid gap-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-1">
                <StatusBadge status={t.status} />
                {t.isMock ? <OriginBadge kind="mock" /> : null}
                {t.qualityScore !== null ? <span className="text-muted-foreground">QC {Math.round(t.qualityScore)}</span> : null}
              </div>
              <p className="truncate font-medium" title={t.title}>
                {t.href ? (
                  <Link href={t.href} className="hover:underline">
                    {t.title}
                  </Link>
                ) : (
                  t.title
                )}
              </p>
              <p className="truncate text-muted-foreground">{t.subtitle}</p>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} className="size-3.5 accent-primary" aria-label={`Select ${t.title} for comparison`} />
                Compare
              </label>
              {canReview && t.reviewable ? <MediaReviewButtons assetId={t.id} status={t.status} label={t.title} /> : null}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
