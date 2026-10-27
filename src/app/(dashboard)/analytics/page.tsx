import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card } from "@/components/ui/card";
import { parseFilters, periodStart } from "@/lib/filters";
import { formatNumber } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Analytics" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AnalyticsPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const since = periodStart(f.period);
  const where = {
    ...(since ? { capturedAt: { gte: since } } : {}),
    ...(f.platform ? { socialAccount: { platform: f.platform } } : {}),
    ...(f.creator ? { socialAccount: { creatorId: f.creator, ...(f.platform ? { platform: f.platform } : {}) } } : {}),
    ...(f.campaign ? { contentItem: { campaignId: f.campaign } } : {}),
  };
  // Latest snapshot per content item avoids double counting cumulative platform metrics.
  const grouped = await db.analyticsSnapshot.groupBy({ by: ["origin"], where, _count: true });
  const latest = await db.analyticsSnapshot.findMany({
    where: { ...where, contentItemId: { not: null } },
    orderBy: { capturedAt: "desc" },
    distinct: ["contentItemId"],
    select: { origin: true, views: true, reach: true, likes: true, comments: true, shares: true },
  });
  const sum = (origin: "MEASURED" | "DEMO", key: "views" | "reach" | "likes" | "comments" | "shares") =>
    latest.filter((s) => s.origin === origin).reduce((t, s) => t + (s[key] ?? 0n), 0n);
  const measuredCount = grouped.find((g) => g.origin === "MEASURED")?._count ?? 0;
  const demoCount = grouped.find((g) => g.origin === "DEMO")?._count ?? 0;

  return (
    <>
      <PageHeader title="Analytics" description="Only metrics available through official APIs, stored as timestamped snapshots with their source." />
      <PhaseNotice phase={9} title="Analytics engine" items={["Scheduled snapshot collection per platform", "Per creator / campaign / content type views", "Cost per published item and per usable asset", "Pattern detection and experiment suggestions (clearly labelled)"]} />
      {measuredCount + demoCount === 0 ? (
        <Card>
          <EmptyState icon={BarChart3} title="No analytics snapshots" description="Measured statistics appear after publications are confirmed and metrics are fetched." />
        </Card>
      ) : (
        (["MEASURED", "DEMO"] as const)
          .filter((o) => (o === "MEASURED" ? measuredCount : demoCount) > 0)
          .map((origin) => (
            <section key={origin} className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                {origin === "MEASURED" ? "Measured results" : "Demo results"} <OriginBadge kind={origin === "MEASURED" ? "measured" : "demo"} />
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {(["views", "reach", "likes", "comments", "shares"] as const).map((k) => (
                  <StatCard key={k} label={k[0]!.toUpperCase() + k.slice(1)} value={formatNumber(sum(origin, k))} />
                ))}
              </div>
            </section>
          ))
      )}
    </>
  );
}
