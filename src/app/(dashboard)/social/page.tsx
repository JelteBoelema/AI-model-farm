import type { Metadata } from "next";
import { Share2 } from "lucide-react";
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

export const metadata: Metadata = { title: "Social Accounts" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SocialPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const accounts = await db.socialAccount.findMany({
    where: { ...(f.creator ? { creatorId: f.creator } : {}), ...(f.platform ? { platform: f.platform } : {}) },
    orderBy: [{ platform: "asc" }, { handle: "asc" }],
    include: { creator: { select: { name: true } } },
  });

  return (
    <>
      <PageHeader title="Social Accounts" description="Only official platform APIs. Tokens are stored in the secrets manager; this table only holds references." />
      <PhaseNotice
        phase={7}
        title="Platform integrations"
        items={["OAuth connect with owner approval", "Scope and capability verification before publishing", "Token refresh and expiry alerts", "Instagram, TikTok and YouTube adapters"]}
      />
      <Card>
        <CardContent className="px-0 pt-2">
          {accounts.length === 0 ? (
            <EmptyState icon={Share2} title="No social accounts linked" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Creator</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Posts/day limit</TableHead>
                  <TableHead>Last verified</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <p className="flex items-center gap-2 font-medium">
                        @{a.handle} {a.isDemo ? <OriginBadge kind="demo" /> : null}
                      </p>
                      <Badge tone="outline">{humanize(a.platform)}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{a.creator.name}</TableCell>
                    <TableCell className="max-w-xs text-xs text-muted-foreground">{a.grantedScopes.join(", ") || "—"}</TableCell>
                    <TableCell className="tabular-nums">{a.maxPostsPerDay}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(a.lastVerifiedAt)}</TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
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
