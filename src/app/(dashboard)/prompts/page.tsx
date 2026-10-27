import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { humanize } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Prompt Studio" };

export default async function PromptsPage() {
  const templates = await db.promptTemplate.findMany({
    where: { archivedAt: null },
    orderBy: [{ kind: "asc" }, { key: "asc" }],
    include: { versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } }, creator: { select: { name: true } } },
  });

  return (
    <>
      <PageHeader title="Prompt Studio" description="Templates with validated variables and immutable published versions." />
      <PhaseNotice
        phase={3}
        title="Prompt management"
        items={["Global, creator and campaign templates", "Variable schema with validation", "Versioning, publishing and deprecation", "Test generations, comparison and cost per test"]}
      />
      <Card>
        <CardContent className="px-0 pt-2">
          {templates.length === 0 ? (
            <EmptyState icon={Sparkles} title="No prompt templates" description="Run `pnpm db:seed` to install the starter templates." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Latest version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <p className="font-medium">{t.name}</p>
                      <code className="font-mono text-xs text-muted-foreground">{t.key}</code>
                    </TableCell>
                    <TableCell>
                      <Badge tone="outline">{humanize(t.kind)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {humanize(t.scope)}
                      {t.creator ? ` · ${t.creator.name}` : ""}
                    </TableCell>
                    <TableCell>{t.versions[0] ? <span className="flex items-center gap-2 text-xs">v{t.versions[0].version} <StatusBadge status={t.versions[0].status} /></span> : "—"}</TableCell>
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
