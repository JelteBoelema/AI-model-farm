import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { NewTemplateDialog } from "@/components/prompts/new-template-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters } from "@/lib/filters";
import { can } from "@/lib/rbac";
import { humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Prompt Studio" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PromptsPage({ searchParams }: Props) {
  const raw = await searchParams;
  const f = parseFilters(raw);
  const showArchived = raw.archived === "1";
  const user = await requireUser();
  const [templates, creators, campaigns] = await Promise.all([
    db.promptTemplate.findMany({
      where: {
        archivedAt: showArchived ? { not: null } : null,
        ...(f.creator ? { OR: [{ scope: "GLOBAL" }, { creatorId: f.creator }] } : {}),
        ...(f.campaign ? { OR: [{ scope: "GLOBAL" }, { campaignId: f.campaign }] } : {}),
      },
      orderBy: [{ kind: "asc" }, { key: "asc" }],
      include: {
        versions: { orderBy: { version: "desc" }, select: { version: true, status: true } },
        creator: { select: { name: true } },
        campaign: { select: { name: true } },
        _count: { select: { pins: true } },
      },
    }),
    db.creator.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.campaign.findMany({ where: { status: { notIn: ["COMPLETED", "ARCHIVED"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <PageHeader
        title="Prompt Studio"
        description="Templates with validated variables and immutable published versions. Generations pin the exact version they used."
        actions={can(user.role, "prompts:edit") ? <NewTemplateDialog creators={creators} campaigns={campaigns} /> : undefined}
      />
      <div className="-mt-2 flex gap-3 text-xs">
        <Link href="/prompts" className={showArchived ? "text-muted-foreground hover:underline" : "font-medium"}>Active</Link>
        <Link href="/prompts?archived=1" className={showArchived ? "font-medium" : "text-muted-foreground hover:underline"}>Archived</Link>
      </div>
      <Card>
        <CardContent className="px-0 pt-2">
          {templates.length === 0 ? (
            <EmptyState icon={Sparkles} title={showArchived ? "No archived templates" : "No prompt templates"} description={showArchived ? undefined : "Create a template or run `pnpm db:seed` for the starter set."} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Live version</TableHead>
                  <TableHead>Draft</TableHead>
                  <TableHead className="text-right">Campaign pins</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => {
                  const live = t.versions.find((v) => v.status === "PUBLISHED");
                  const draft = t.versions.find((v) => v.status === "DRAFT");
                  return (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Link href={`/prompts/${t.id}`} className="font-medium hover:underline">{t.name}</Link>
                        <code className="block font-mono text-xs text-muted-foreground">{t.key}</code>
                      </TableCell>
                      <TableCell><Badge tone="outline">{humanize(t.kind)}</Badge></TableCell>
                      <TableCell className="text-xs">
                        {humanize(t.scope)}
                        {t.creator ? ` · ${t.creator.name}` : ""}
                        {t.campaign ? ` · ${t.campaign.name}` : ""}
                      </TableCell>
                      <TableCell>{live ? <span className="flex items-center gap-2 text-xs">v{live.version} <StatusBadge status="PUBLISHED" /></span> : <span className="text-xs text-muted-foreground">not published</span>}</TableCell>
                      <TableCell className="text-xs">{draft ? `v${draft.version}` : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{t._count.pins}</TableCell>
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
