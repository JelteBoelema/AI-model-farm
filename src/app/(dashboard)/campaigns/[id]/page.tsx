import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CampaignBudgetForm, CampaignDialog, CampaignStatusButtons } from "@/components/campaigns/campaign-controls";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, microsToDecimalString } from "@/lib/money";
import { can } from "@/lib/rbac";
import { formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { findActivePause } from "@/server/controls";
import { db } from "@/server/db";
import { costPerUsableAsset } from "@/server/services/content";

export const metadata: Metadata = { title: "Campaign" };
type Props = { params: Promise<{ id: string }> };

export default async function CampaignPage({ params }: Props) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const user = await requireUser();
  const campaign = await db.campaign.findUnique({
    where: { id },
    include: {
      creators: { include: { creator: { select: { id: true, name: true, status: true } } } },
      contentItems: { orderBy: { updatedAt: "desc" }, take: 50, include: { creator: { select: { name: true } }, publishingJobs: { where: { status: { not: "CANCELLED" } }, select: { status: true } } } },
      promptPins: { include: { promptVersion: { include: { template: { select: { name: true, key: true } } } } } },
    },
  });
  if (!campaign) notFound();
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [budgets, spentMonth, spentTotal, cost, pause, allCreators, published] = await Promise.all([
    db.budgetPolicy.findMany({ where: { scope: "CAMPAIGN", targetId: id } }),
    db.costLedger.aggregate({ where: { campaignId: id, isMock: false, occurredAt: { gte: monthStart } }, _sum: { amountMicros: true } }),
    db.costLedger.aggregate({ where: { campaignId: id, isMock: false }, _sum: { amountMicros: true } }),
    costPerUsableAsset({ campaignId: id }),
    findActivePause({ chain: "publishing", campaignId: id }),
    db.creator.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.publishingJob.count({ where: { status: "PUBLISHED", contentItem: { campaignId: id } } }),
  ]);
  const month = budgets.find((b) => b.period === "MONTH");
  const day = budgets.find((b) => b.period === "DAY");
  const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  const canEdit = can(user.role, "content:edit");
  const closed = ["COMPLETED", "ARCHIVED"].includes(campaign.status);

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={campaign.objective || "No objective set"}
        actions={
          <div className="flex flex-wrap gap-2">
            {canEdit && !closed ? (
              <CampaignDialog
                creators={allCreators}
                campaignId={campaign.id}
                initial={{ name: campaign.name, objective: campaign.objective, brief: campaign.brief, startsAt: date(campaign.startsAt), endsAt: date(campaign.endsAt), creatorIds: campaign.creators.map((c) => c.creatorId) }}
              />
            ) : null}
            <CampaignStatusButtons campaignId={campaign.id} status={campaign.status} canPause={can(user.role, "controls:pause")} canResume={can(user.role, "controls:resume")} canEdit={canEdit} />
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={campaign.status} />
        {campaign.isDemo ? <OriginBadge kind="demo" /> : null}
        {pause ? <span className="text-xs text-warning">Paused: generation and publishing for this campaign are stopped ({pause.reason})</span> : null}
        <span className="text-xs text-muted-foreground">
          {formatDateTime(campaign.startsAt)} → {formatDateTime(campaign.endsAt)}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Spend this month" value={formatMoney(spentMonth._sum.amountMicros ?? 0n)} hint={month ? `of ${formatMoney(month.limitMicros)} monthly budget` : "No monthly budget"} />
        <StatCard label="Spend to date" value={formatMoney(spentTotal._sum.amountMicros ?? 0n)} hint={day ? `daily cap ${formatMoney(day.limitMicros)}` : "No daily cap"} />
        <StatCard label="Content items" value={campaign.contentItems.length} hint={`${published} published post(s)`} />
        <StatCard label="Cost per usable asset" value={cost.perAssetMicros === null ? "—" : formatMoney(cost.perAssetMicros, "EUR", 3)} hint={`${cost.usableAssets} approved asset(s)`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Brief and creators</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p className="whitespace-pre-wrap">{campaign.brief || <span className="text-muted-foreground">No brief yet.</span>}</p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Campaign creators">
              {campaign.creators.map((c) => (
                <li key={c.creatorId}>
                  <Link href={`/creators/${c.creator.id}`}>
                    <Badge tone="outline">{c.creator.name}</Badge>
                  </Link>
                </li>
              ))}
              {campaign.creators.length === 0 ? <li className="text-muted-foreground">No creators assigned.</li> : null}
            </ul>
            {campaign.promptPins.length ? (
              <p className="text-xs text-muted-foreground">Pinned prompts: {campaign.promptPins.map((p) => `${p.promptVersion.template.name} v${p.promptVersion.version}`).join(", ")}</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Budget</CardTitle>
            <CardDescription>Hard limits checked before every paid generation of this campaign&apos;s content.</CardDescription>
          </CardHeader>
          <CardContent>
            {can(user.role, "budgets:lower") ? (
              <CampaignBudgetForm campaignId={campaign.id} current={{ MONTH: month ? microsToDecimalString(month.limitMicros) : "", DAY: day ? microsToDecimalString(day.limitMicros) : "" }} />
            ) : (
              <p className="text-sm">
                {month ? `${formatMoney(month.limitMicros)} per month` : "No monthly cap"}
                {day ? ` · ${formatMoney(day.limitMicros)} per day` : ""}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Content</CardTitle>
          <Link href={`/content?campaign=${campaign.id}`} className="text-sm underline-offset-2 hover:underline">
            Open in Content Factory
          </Link>
        </CardHeader>
        <CardContent className="px-0">
          {campaign.contentItems.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">No content in this campaign yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Creator</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Publications</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaign.contentItems.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/content/${i.id}`} className="font-medium hover:underline">
                        {i.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{i.creator.name}</TableCell>
                    <TableCell>
                      <Badge tone="outline">{humanize(i.format)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {i.publishingJobs.filter((j) => j.status === "PUBLISHED").length}/{i.publishingJobs.length}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={i.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
