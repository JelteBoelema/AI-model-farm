import type { Metadata } from "next";
import { Images } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters, periodStart } from "@/lib/filters";
import { formatDateTime, formatNumber, humanize } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Media Library" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function MediaPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const since = periodStart(f.period);
  const assets = await db.mediaAsset.findMany({
    where: {
      ...(f.creator ? { creatorId: f.creator } : {}),
      ...(f.campaign ? { contentItem: { campaignId: f.campaign } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { creator: { select: { name: true } } },
  });

  return (
    <>
      <PageHeader title="Media Library" description="Assets live in object storage; the database keeps checksum, provenance, prompt and parameters." />
      <PhaseNotice
        phase={5}
        title="Media review"
        items={["Previews and side-by-side comparison", "Approve / reject with audit trail", "Quality scores and technical QC reports", "Upload of licensed reference material"]}
      />
      <Card>
        <CardContent className="px-0 pt-2">
          {assets.length === 0 ? (
            <EmptyState icon={Images} title="No media assets yet" description="Generated images, videos and audio will appear here." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Provenance</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <code className="block max-w-xs truncate font-mono text-xs">{a.storageKey}</code>
                      <p className="text-xs text-muted-foreground">{a.creator?.name ?? "Shared"}</p>
                    </TableCell>
                    <TableCell>
                      <Badge tone="outline">{humanize(a.kind)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {humanize(a.source)}
                      {a.providerKey ? ` · ${a.providerKey}` : ""} {a.isMock ? <OriginBadge kind="mock" /> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(Number(a.sizeBytes))} B</TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</TableCell>
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
