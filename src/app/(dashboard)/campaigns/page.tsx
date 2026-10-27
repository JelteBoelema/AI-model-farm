import type { Metadata } from "next";
import { Megaphone } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters } from "@/lib/filters";
import { formatMoney } from "@/lib/money";
import { formatDateTime } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Campaigns" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CampaignsPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const campaigns = await db.campaign.findMany({
    where: { ...(f.campaign ? { id: f.campaign } : {}), ...(f.creator ? { creators: { some: { creatorId: f.creator } } } : {}) },
    orderBy: [{ status: "asc" }, { startsAt: "desc" }],
    include: { creators: { include: { creator: { select: { name: true } } } }, _count: { select: { contentItems: true } } },
  });
  const budgets = await db.budgetPolicy.findMany({ where: { scope: "CAMPAIGN", targetId: { in: campaigns.map((c) => c.id) } } });

  return (
    <>
      <PageHeader title="Campaigns" description="Campaigns group content across creators with their own budget and prompts." />
      <PhaseNotice phase={7} title="Campaign planning" items={["Create and edit campaigns and briefs", "Assign creators and campaign prompts", "Campaign budgets with hard stop", "Campaign-level pause and results"]} />
      <Card>
        <CardContent className="px-0 pt-2">
          {campaigns.length === 0 ? (
            <EmptyState icon={Megaphone} title="No campaigns" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Creators</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Monthly budget</TableHead>
                  <TableHead className="text-right">Content</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => {
                  const budget = budgets.find((b) => b.targetId === c.id && b.period === "MONTH");
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="max-w-xs">
                        <p className="flex items-center gap-2 font-medium">
                          {c.name} {c.isDemo ? <OriginBadge kind="demo" /> : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{c.objective}</p>
                      </TableCell>
                      <TableCell className="text-xs">{c.creators.map((x) => x.creator.name).join(", ") || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(c.startsAt)} → {formatDateTime(c.endsAt)}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{budget ? formatMoney(budget.limitMicros) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{c._count.contentItems}</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
