import Link from "next/link";
import type { Metadata } from "next";
import { CalendarClock, CircleAlert, Coins, Factory, Users } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { SpendChart } from "@/components/dashboard/spend-chart";
import { StatCard } from "@/components/dashboard/stat-card";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { parseFilters, PERIOD_LABELS } from "@/lib/filters";
import { formatMoney, usagePercent } from "@/lib/money";
import { cn, formatDateTime, humanize } from "@/lib/utils";
import { getDailySpend, getOverview } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Overview" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OverviewPage({ searchParams }: Props) {
  const filters = parseFilters(await searchParams);
  const [o, daily] = await Promise.all([getOverview(filters), getDailySpend(filters)]);
  const budgetPct = usagePercent(o.monthSpend.measuredMicros + o.monthSpend.estimatedMicros, o.monthlyBudgetMicros);
  const pipelineMax = Math.max(1, ...o.pipeline.map((p) => p.count));
  const hasSpend = daily.some((d) => d.measuredMicros > 0n || d.estimatedMicros > 0n);

  return (
    <>
      <PageHeader title="Overview" description={`Farm status · ${PERIOD_LABELS[filters.period]}`} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Key figures">
        <StatCard
          icon={Users}
          label="Active creators"
          value={o.creators.active}
          hint={`${o.creators.total} total · ${o.creators.paused} paused · ${o.creators.draft} draft`}
          badge={o.creators.demo > 0 ? <OriginBadge kind="demo" /> : undefined}
        />
        <StatCard icon={Factory} label="Content items" value={o.contentTotal} hint={`Created in period · ${o.pendingApprovals} pending approvals`} />
        <StatCard
          icon={Coins}
          label="Spend this month"
          value={formatMoney(o.monthSpend.measuredMicros + o.monthSpend.estimatedMicros)}
          badge={o.monthSpend.estimatedMicros > 0n ? <OriginBadge kind="estimated" /> : o.monthSpend.measuredMicros > 0n ? <OriginBadge kind="measured" /> : undefined}
          hint={
            o.monthlyBudgetMicros !== null ? (
              <div className="flex flex-col gap-1.5">
                <span>
                  {budgetPct?.toFixed(1)}% of {formatMoney(o.monthlyBudgetMicros)} monthly budget · {formatMoney(o.heldMicros)} reserved
                </span>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", (budgetPct ?? 0) >= 100 ? "bg-destructive" : (budgetPct ?? 0) >= 80 ? "bg-warning" : "bg-primary")}
                    style={{ width: `${Math.min(budgetPct ?? 0, 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <span className="text-warning">No global monthly budget set — paid generation stays blocked.</span>
            )
          }
        />
        <StatCard
          icon={CircleAlert}
          label="Job health"
          value={
            <span className="flex items-baseline gap-3">
              {o.jobs.failed}
              <span className="text-sm font-normal text-muted-foreground">failed</span>
            </span>
          }
          hint={`${o.jobs.running} running/queued · ${o.jobs.blocked} blocked · ${o.jobs.succeeded} succeeded`}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>Daily spend</CardTitle>
              <CardDescription>Last 30 days, real providers only. Mock-mode costs are excluded.</CardDescription>
            </div>
            {o.spend.mockMicros > 0n ? <Badge tone="primary">Mock spend excluded: {formatMoney(o.spend.mockMicros)}</Badge> : null}
          </CardHeader>
          <CardContent>
            {hasSpend ? (
              <SpendChart data={daily} />
            ) : (
              <EmptyState icon={Coins} title="No costs recorded" description="Costs appear here once real provider jobs are booked in the cost ledger." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content pipeline</CardTitle>
            <CardDescription>Items created in the selected period, by stage</CardDescription>
          </CardHeader>
          <CardContent>
            {o.contentTotal === 0 ? (
              <EmptyState icon={Factory} title="Pipeline is empty" description="Content Factory (phase 5) will fill this pipeline." />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {o.pipeline.map((p) => (
                  <li key={p.stage} className="grid grid-cols-[7.5rem_1fr_2rem] items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{humanize(p.stage)}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", p.stage === "FAILED" ? "bg-destructive" : "bg-primary/80")} style={{ width: `${(p.count / pipelineMax) * 100}%` }} />
                    </div>
                    <span className="text-right tabular-nums">{p.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Upcoming publications</CardTitle>
            <CardDescription>Next 7 days</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {o.upcoming.length === 0 ? (
              <EmptyState icon={CalendarClock} title="Nothing scheduled" description="Scheduled posts appear here once publishing is set up (phase 7)." />
            ) : (
              <ul className="divide-y">
                {o.upcoming.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className="w-36 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDateTime(u.scheduledFor)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {u.contentItem.title} <span className="text-muted-foreground">· {u.contentItem.creator.name}</span>
                    </span>
                    <Badge tone="outline">{humanize(u.platform)}</Badge>
                    {u.isMock ? <OriginBadge kind="mock" /> : u.contentItem.isDemo ? <OriginBadge kind="demo" /> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>Latest audit log entries</CardDescription>
            </div>
            <Link href="/settings/audit" className="text-xs text-primary hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y">
              {o.recentAudit.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <span className="w-36 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDateTime(a.occurredAt)}</span>
                  <code className="truncate font-mono text-xs">{a.action}</code>
                  <span className="ml-auto truncate text-xs text-muted-foreground">{a.actorLabel}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      {o.pausedSwitches.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Active pauses</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {o.pausedSwitches.map((s) => (
              <span key={s.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                <StatusBadge status="PAUSED" /> {humanize(s.scope)} — {s.reason}
              </span>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
