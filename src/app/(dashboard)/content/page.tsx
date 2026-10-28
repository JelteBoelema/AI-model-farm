import type { Metadata } from "next";
import Link from "next/link";
import { ContentStatus } from "@prisma/client";
import { CircleAlert, Coins, Factory, Hourglass, ListChecks } from "lucide-react";
import { LiveRefresh, ProduceBatchButton } from "@/components/content/content-actions";
import { NewContentDialog } from "@/components/content/new-content-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STEP_LABELS, type PipelineStep } from "@/lib/content-pipeline";
import { parseFilters, periodStart } from "@/lib/filters";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/rbac";
import { formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { costPerUsableAsset } from "@/server/services/content";
import { contentWhere } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Content Factory" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const IN_PRODUCTION: ContentStatus[] = ["BRIEFED", "SCRIPTED", "PROMPTED", "GENERATING"];
const UUID = /^[0-9a-f-]{36}$/;

export default async function ContentPage({ searchParams }: Props) {
  const raw = await searchParams;
  const user = await requireUser();
  const f = parseFilters(raw);
  const status = f.status && (Object.values(ContentStatus) as string[]).includes(f.status) ? (f.status as ContentStatus) : undefined;
  const batchId = typeof raw.batch === "string" && UUID.test(raw.batch) ? raw.batch : undefined;
  const where = { ...contentWhere(f), ...(status ? { status } : {}), ...(batchId ? { batchId } : {}) };

  const [items, batch, activeJobs, creators, counts, cost, chainsRunning] = await Promise.all([
    db.contentItem.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { creator: { select: { name: true } }, campaign: { select: { name: true } }, batch: { select: { id: true, name: true } } },
    }),
    batchId ? db.contentBatch.findUnique({ where: { id: batchId } }) : null,
    db.generationJob.groupBy({ by: ["contentItemId"], where: { status: { in: ["QUEUED", "RUNNING"] }, contentItemId: { not: null } }, _count: true }),
    db.creator.findMany({
      where: { status: { not: "ARCHIVED" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, campaigns: { where: { campaign: { status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } } }, select: { campaign: { select: { id: true, name: true } } } } },
    }),
    db.contentItem.groupBy({ by: ["status"], where: contentWhere(f), _count: true }),
    costPerUsableAsset({ since: periodStart(f.period), creatorId: f.creator, campaignId: f.campaign }),
    // Items between two steps have no active job for a moment but are still in production.
    db.contentItem.count({ where: { status: { in: IN_PRODUCTION }, failedStep: null, generationJobs: { some: {} } } }),
  ]);
  const busy = new Set(activeJobs.map((j) => j.contentItemId));
  const count = (s: ContentStatus[]) => counts.filter((c) => s.includes(c.status)).reduce((n, c) => n + c._count, 0);
  const creatorOptions = creators.map((c) => ({ id: c.id, name: c.name, campaigns: c.campaigns.map((x) => x.campaign) }));
  const canEdit = can(user.role, "content:edit");

  return (
    <>
      <LiveRefresh active={busy.size > 0 || chainsRunning > 0} />
      <PageHeader
        title="Content Factory"
        description="Every item runs brief → shot list → caption → images → quality control as separate, resumable jobs, then waits for human approval."
        actions={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              <NewContentDialog creators={creatorOptions} mode="batch" />
              <NewContentDialog creators={creatorOptions} mode="single" />
            </div>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="In production" value={count(IN_PRODUCTION)} icon={Hourglass} hint={`${busy.size} with active jobs`} />
        <StatCard label="Needs review" value={count(["QC_REVIEW", "READY"])} icon={ListChecks} hint="Quality control done, waiting for a human" />
        <StatCard label="Failed" value={count(["FAILED"])} icon={CircleAlert} hint="Resume from the item page" />
        <StatCard
          label="Cost per usable asset"
          value={cost.perAssetMicros === null ? "—" : formatMoney(cost.perAssetMicros, "EUR", 3)}
          icon={Coins}
          hint={`${formatMoney(cost.spentMicros)} content spend · ${cost.usableAssets} approved asset(s)${cost.estimatedMicros > 0n ? ` · ${formatMoney(cost.estimatedMicros)} estimated` : ""}`}
          badge={cost.estimatedMicros > 0n ? <OriginBadge kind="estimated" /> : undefined}
        />
      </div>

      {batch ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
          <span>
            Batch <strong>{batch.name}</strong> · created {formatDateTime(batch.createdAt)}
          </span>
          <div className="flex gap-2">
            {can(user.role, "generation:run") ? <ProduceBatchButton batchId={batch.id} /> : null}
            <Link href="/content" className="self-center text-xs text-muted-foreground underline-offset-2 hover:underline">
              Show all items
            </Link>
          </div>
        </div>
      ) : null}

      <Card>
        <CardContent className="px-0 pt-2">
          {items.length === 0 ? (
            <EmptyState icon={Factory} title="No content items in this view" description={canEdit ? "Create an item or a batch of ideas to start production." : "Adjust the filters or period."} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Creator</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Generations</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/content/${i.id}`} className="flex items-center gap-2 font-medium hover:underline">
                        {i.title} {i.isDemo ? <OriginBadge kind="demo" /> : null}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {[i.campaign?.name, i.batch ? `batch ${i.batch.name}` : null].filter(Boolean).join(" · ")}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm">{i.creator.name}</TableCell>
                    <TableCell>
                      <Badge tone="outline">{humanize(i.format)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {i.generationCount}/{i.maxGenerations}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={i.status} />
                        {busy.has(i.id) ? <StatusBadge status="RUNNING" /> : null}
                        {i.failedStep ? <Badge tone="danger">{STEP_LABELS[i.failedStep as PipelineStep] ?? i.failedStep} failed</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(i.updatedAt)}</TableCell>
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
