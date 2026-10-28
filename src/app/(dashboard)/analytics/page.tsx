import type { Metadata } from "next";
import Link from "next/link";
import type { DataOrigin } from "@prisma/client";
import { BarChart3, Lightbulb } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters, periodStart } from "@/lib/filters";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/rbac";
import { cn, formatNumber, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { analyticsOverview, originCounts, type GroupRow } from "@/server/services/analytics";
import { listInsights, type ExperimentProposal } from "@/server/services/insights";
import { effectivePolicy } from "@/server/services/policy";
import { CollectNowButton, ExperimentDecision } from "./analytics-controls";

export const metadata: Metadata = { title: "Analytics" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const ORIGINS: { key: DataOrigin; param: string; label: string; badge: "measured" | "mock" | "demo"; note: string | null }[] = [
  { key: "MEASURED", param: "measured", label: "Measured", badge: "measured", note: null },
  { key: "MOCK", param: "mock", label: "Mock", badge: "mock", note: "Made-up numbers from the mock platform. They test the pipeline and are never real audience data." },
  { key: "DEMO", param: "demo", label: "Demo", badge: "demo", note: "Seeded demonstration data, not real activity." },
];

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (v: bigint | null, digits = 2) => (v === null ? "—" : formatMoney(v, "EUR", digits));

function EngagementMeter({ value, max }: { value: number | null; max: number }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex items-center justify-end gap-2" title={`Engagement ${pct(value)}`}>
      <span className="tabular-nums">{pct(value)}</span>
      <span className="hidden h-2 w-20 overflow-hidden rounded-full bg-muted sm:inline-block" aria-hidden>
        <span className="block h-full rounded-full bg-primary" style={{ width: `${max > 0 ? Math.max(4, (value / max) * 100) : 0}%` }} />
      </span>
    </span>
  );
}

function GroupTable({ title, rows, label, empty = "No posts." }: { title: string; rows: GroupRow[]; label: (k: string, l: string) => string; empty?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.engagement ?? 0));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Posts</TableHead>
                <TableHead className="text-right">Views</TableHead>
                <TableHead className="text-right">Engagement</TableHead>
                <TableHead className="text-right">Cost / post</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="max-w-48 truncate">{label(r.key, r.label)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.posts}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.views)}</TableCell>
                  <TableCell className="text-right">
                    <EngagementMeter value={r.engagement} max={max} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.costPerPostMicros)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default async function AnalyticsPage({ searchParams }: Props) {
  const raw = await searchParams;
  const user = await requireUser();
  const f = parseFilters(raw);
  const counts = await originCounts();
  const asked = ORIGINS.find((o) => o.param === raw.origin);
  const origin = asked ?? ORIGINS.find((o) => (counts[o.key] ?? 0) > 0) ?? ORIGINS[0]!;
  const filter = { origin: origin.key, since: periodStart(f.period), creatorId: f.creator, campaignId: f.campaign, platform: f.platform };
  const [overview, insights, policy] = await Promise.all([analyticsOverview(filter), listInsights({ origin: origin.key, creatorId: f.creator }), effectivePolicy({ creatorId: f.creator })]);
  const t = overview.total;
  const params = (o: string) => {
    const q = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" && k !== "origin" ? [[k, v]] : [])));
    q.set("origin", o);
    return `?${q}`;
  };
  const patterns = insights.filter((i) => i.kind === "PATTERN");
  const experiments = insights.filter((i) => i.kind === "EXPERIMENT");

  return (
    <>
      <PageHeader title="Analytics" description="Results from official platform statistics, stored as timestamped snapshots with their source. Measured, mock and demo data are never mixed." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1 border-b" aria-label="Data origin">
          {ORIGINS.map((o) => (
            <Link
              key={o.key}
              href={params(o.param)}
              aria-current={o.key === origin.key ? "page" : undefined}
              className={cn("-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm", o.key === origin.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              {o.label} <span className="text-xs text-muted-foreground tabular-nums">{counts[o.key] ?? 0}</span>
            </Link>
          ))}
        </nav>
        {can(user.role, "publishing:schedule") ? <CollectNowButton /> : null}
      </div>
      {origin.note ? (
        <p role="note" className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm">
          <OriginBadge kind={origin.badge} /> {origin.note}
        </p>
      ) : null}

      {t.posts === 0 ? (
        <Card>
          <EmptyState icon={BarChart3} title={`No ${origin.label.toLowerCase()} results`} description="Statistics appear after publications are confirmed and their first snapshot (one hour after publishing) is collected." />
        </Card>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${origin.label} totals`}>
            <StatCard label="Published posts" value={formatNumber(t.posts)} badge={<OriginBadge kind={origin.badge} />} />
            <StatCard label="Views" value={formatNumber(t.views)} hint={`Reach ${formatNumber(t.reach)}${overview.followers !== null ? ` · ${formatNumber(overview.followers)} followers` : ""}`} />
            <StatCard label="Engagement rate" value={pct(t.engagement)} hint="Likes, comments, shares and saves per person reached" />
            <StatCard
              label="Cost per published item"
              value={money(t.costPerPostMicros)}
              hint={t.costMicros === null ? "No booked costs for these posts (mock or demo generation costs nothing)" : `${money(t.costMicros)} content cost · ${money(t.costPer1kViewsMicros)} per 1,000 views`}
            />
          </section>
          <div className="grid gap-4 xl:grid-cols-2">
            <GroupTable title="By creator" rows={overview.byCreator} label={(_k, l) => l} />
            <GroupTable title="By content type" rows={overview.byFormat} label={(k) => humanize(k)} />
            <GroupTable title="By campaign" rows={overview.byCampaign} label={(_k, l) => l} empty="None of these posts belongs to a campaign." />
            <GroupTable title="By platform" rows={overview.byPlatform} label={(k) => humanize(k)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Top posts</CardTitle>
              <CardDescription>Highest engagement in the selection; numbers from each post&apos;s latest snapshot.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Top posts">
                <TableHeader>
                  <TableRow>
                    <TableHead>Post</TableHead>
                    <TableHead>Creator</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Engagement</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.top.map((p) => (
                    <TableRow key={p.publishingJobId}>
                      <TableCell className="max-w-64 truncate">
                        <Link href={`/content/${p.contentItemId}`} className="hover:underline">
                          {p.title}
                        </Link>
                      </TableCell>
                      <TableCell>{p.creatorName}</TableCell>
                      <TableCell>{humanize(p.format)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.ageHours === null ? "—" : p.ageHours < 48 ? `${p.ageHours} h` : `${Math.round(p.ageHours / 24)} d`}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(p.views)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(p.engagement)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <Card className="border-dashed" aria-label="Predictions and suggestions">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Lightbulb className="size-4" aria-hidden /> Predictions & suggestions <Badge tone="warning">Prediction — not measured</Badge>
            <OriginBadge kind={origin.badge} />
          </CardTitle>
          <CardDescription>
            Patterns in the {origin.label.toLowerCase()} results above, compared at the same post age (up to 72 h). They are estimates from a sample and can be wrong.
            {policy.analyticsMinSample === null
              ? " The minimum sample is not set (Settings → Autonomy), so analytics never steers the autopilot."
              : ` Only measured patterns with at least ${policy.analyticsMinSample} posts in both compared groups and p ≤ 0.05 may steer the autopilot's planning (every other new item); below that nothing changes automatically.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {insights.length === 0 ? <p className="text-sm text-muted-foreground">Not enough posts older than 24 hours to compare yet (at least two per group).</p> : null}
          {patterns.length ? (
            <ul className="grid gap-2" aria-label="Patterns">
              {patterns.map((i) => {
                const steers = origin.key === "MEASURED" && i.meetsMinSample && (i.pValue ?? 1) <= 0.05 && (i.dimension === "pillar" || i.dimension === "format") && i.creatorId !== null;
                return (
                  <li key={i.id} className="rounded-lg border px-4 py-3 text-sm">
                    <p>{i.finding}</p>
                    <p className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>sample {i.sampleSize} posts</span>
                      <span>·</span>
                      <span>{i.pValue === null ? "p not computable" : `p = ${i.pValue.toFixed(3)}`}</span>
                      <span>·</span>
                      {i.meetsMinSample ? <span>meets the minimum sample ({i.minSample})</span> : <span className="font-medium text-foreground">below the minimum sample{i.minSample ? ` (${i.minSample} per group)` : ""} — not used for planning</span>}
                      {steers ? <Badge tone="info">Steers autopilot planning</Badge> : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {experiments.length ? (
            <div className="grid gap-2">
              <h3 className="text-sm font-semibold">Proposed experiments</h3>
              <ul className="grid gap-2" aria-label="Experiments">
                {experiments.map((i) => {
                  const p = i.proposal as unknown as ExperimentProposal;
                  return (
                    <li key={i.id} className="flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm md:flex-row md:items-center">
                      <div className="min-w-0 flex-1">
                        <p>{i.finding}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {i.status === "OPEN" ? "Proposal" : humanize(i.status)} · progress {p.variants.map((v) => `${v}: ${p.progress?.[v] ?? 0}/${p.perVariant}`).join(", ")}
                        </p>
                      </div>
                      {i.status === "OPEN" && can(user.role, "autonomy:raise") ? <ExperimentDecision insightId={i.id} canAccept={i.origin === "MEASURED"} /> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
