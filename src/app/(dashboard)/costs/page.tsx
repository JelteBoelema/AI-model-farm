import type { Metadata } from "next";
import { Coins } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters } from "@/lib/filters";
import { formatMoney } from "@/lib/money";
import { formatDateTime, humanize } from "@/lib/utils";
import { db } from "@/server/db";
import { getSpend, ledgerWhere } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Costs & Budgets" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CostsPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const where = ledgerWhere(f);
  const [spend, entries, policies, held, creators, campaigns, providers] = await Promise.all([
    getSpend(where),
    db.costLedger.findMany({ where, orderBy: { occurredAt: "desc" }, take: 50, include: { provider: { select: { displayName: true } }, creator: { select: { name: true } } } }),
    db.budgetPolicy.findMany({ orderBy: [{ scope: "asc" }, { period: "asc" }] }),
    db.budgetReservation.aggregate({ where: { status: "HELD" }, _sum: { amountMicros: true }, _count: true }),
    db.creator.findMany({ select: { id: true, name: true } }),
    db.campaign.findMany({ select: { id: true, name: true } }),
    db.aiProvider.findMany({ select: { id: true, displayName: true } }),
  ]);
  const targetName = new Map<string, string>([...creators.map((c) => [c.id, c.name] as const), ...campaigns.map((c) => [c.id, c.name] as const), ...providers.map((p) => [p.id, p.displayName] as const)]);

  return (
    <>
      <PageHeader title="Costs & Budgets" description="Append-only cost ledger. Missing prices are never treated as zero; estimates are labelled with their uncertainty." />
      <PhaseNotice
        phase={5}
        title="Cost Manager"
        items={["Pre-flight estimate and budget reservation per job", "Settlement of actual cost; release of unused holds", "Automatic pause at hard limits (phase 8)", "Cost per usable asset and per published item (phase 9)"]}
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Measured / provider-reported" value={formatMoney(spend.measuredMicros)} badge={<OriginBadge kind="measured" />} />
        <StatCard label="Estimated" value={formatMoney(spend.estimatedMicros)} badge={<OriginBadge kind="estimated" />} hint="Conservative estimates where providers report no cost" />
        <StatCard label="Currently reserved" value={formatMoney(held._sum.amountMicros ?? 0n)} hint={`${held._count} open reservation(s)`} />
        <StatCard label="Mock-mode costs" value={formatMoney(spend.mockMicros)} badge={<OriginBadge kind="mock" />} hint="Simulated, never counted as spend" />
      </section>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Ledger entries</CardTitle>
            <CardDescription>Latest 50 entries in the selected period</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {entries.length === 0 ? (
              <EmptyState icon={Coins} title="No ledger entries" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Provider · creator</TableHead>
                    <TableHead>Basis</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(e.occurredAt)}</TableCell>
                      <TableCell className="text-xs">
                        {humanize(e.category)}
                        {e.units ? <span className="text-muted-foreground"> · {e.units.toString()} {e.unitType}</span> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.provider?.displayName ?? "—"} · {e.creator?.name ?? "—"}
                      </TableCell>
                      <TableCell>
                        {e.isMock ? <OriginBadge kind="mock" /> : e.basis === "ESTIMATED" ? <span title={e.uncertaintyNote ?? undefined}><OriginBadge kind="estimated" /></span> : <OriginBadge kind="measured" />}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(e.amountMicros, e.currency, 4)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Budget limits</CardTitle>
            <CardDescription>Hard limits. Lowering: admin. Raising: owner approval.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {policies.length === 0 ? (
              <EmptyState title="No budgets defined" description="Without a global monthly budget no paid generation can start." />
            ) : (
              <ul className="divide-y">
                {policies.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-5 py-2.5 text-sm">
                    <Badge tone="outline">{humanize(p.scope)}</Badge>
                    <span className="truncate text-xs">{p.targetId ? targetName.get(p.targetId) ?? p.targetId : "Farm-wide"}</span>
                    <span className="ml-auto text-xs text-muted-foreground">per {p.period.toLowerCase()}</span>
                    <span className="tabular-nums">{formatMoney(p.limitMicros)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
