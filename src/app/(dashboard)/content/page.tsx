import type { Metadata } from "next";
import { ContentStatus } from "@prisma/client";
import { Factory } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters } from "@/lib/filters";
import { formatDateTime, humanize } from "@/lib/utils";
import { db } from "@/server/db";
import { contentWhere } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Content Factory" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ContentPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const status = f.status && (Object.values(ContentStatus) as string[]).includes(f.status) ? (f.status as ContentStatus) : undefined;
  const items = await db.contentItem.findMany({
    where: { ...contentWhere(f), ...(status ? { status } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { creator: { select: { name: true } }, campaign: { select: { name: true } } },
  });

  return (
    <>
      <PageHeader title="Content Factory" description="Every content item moves through explicit, validated stages from idea to analytics." />
      <PhaseNotice
        phase={5}
        title="Workflow engine"
        items={["Idea → brief → script → prompt → generation → QC", "Separate resumable jobs per step with idempotency keys", "Budget reservation before every paid job", "Single items and batches; failed publish never regenerates"]}
      />
      <Card>
        <CardContent className="px-0 pt-2">
          {items.length === 0 ? (
            <EmptyState icon={Factory} title="No content items in this view" description="Adjust the filters or period." />
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
                      <p className="flex items-center gap-2 font-medium">
                        {i.title} {i.isDemo ? <OriginBadge kind="demo" /> : null}
                      </p>
                      {i.campaign ? <p className="text-xs text-muted-foreground">{i.campaign.name}</p> : null}
                    </TableCell>
                    <TableCell className="text-sm">{i.creator.name}</TableCell>
                    <TableCell>
                      <Badge tone="outline">{humanize(i.format)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {i.generationCount}/{i.maxGenerations}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={i.status} />
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
