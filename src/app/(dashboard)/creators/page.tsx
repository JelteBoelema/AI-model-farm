import type { Metadata } from "next";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters } from "@/lib/filters";
import { humanize } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Creators" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CreatorsPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const creators = await db.creator.findMany({
    where: {
      ...(f.creator ? { id: f.creator } : {}),
      ...(f.campaign ? { campaigns: { some: { campaignId: f.campaign } } } : {}),
      ...(f.platform ? { socialAccounts: { some: { platform: f.platform } } } : {}),
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { _count: { select: { contentItems: true, socialAccounts: true } }, characterProfiles: { where: { status: "APPROVED" }, select: { version: true } } },
  });

  return (
    <>
      <PageHeader title="Creators" description={`${creators.length} creator(s). Each creator has a fictional identity, a versioned visual profile and its own limits.`} />
      <PhaseNotice
        phase={2}
        title="Creator management"
        items={["Create, edit, duplicate, pause, resume, archive", "Briefing wizard that proposes a full profile", "Content pillars, formats and publishing schedule", "Per-creator budgets and autonomy mode"]}
      />
      <Card>
        <CardContent className="px-0 pt-2">
          {creators.length === 0 ? (
            <EmptyState icon={Users} title="No creators yet" description="Seed demo data with `pnpm db:seed:demo`, or create creators once phase 2 lands." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Creator</TableHead>
                  <TableHead>Niche & audience</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Autonomy</TableHead>
                  <TableHead>Character</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Content</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creators.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <p className="flex items-center gap-2 font-medium">
                        {c.name} {c.isDemo ? <OriginBadge kind="demo" /> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">@{c.slug}</p>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <p className="truncate">{c.niche}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.targetAudience}</p>
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.language} <span className="text-muted-foreground">· {c.targetRegions.join(", ")}</span>
                    </TableCell>
                    <TableCell>
                      <Badge tone="outline">{humanize(c.autonomyMode)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{c.characterProfiles[0] ? `v${c.characterProfiles[0].version} approved` : <span className="text-muted-foreground">none approved</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{c._count.socialAccounts}</TableCell>
                    <TableCell className="text-right tabular-nums">{c._count.contentItems}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
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
