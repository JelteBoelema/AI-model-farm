import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { TestPanel, type TestRunView } from "@/components/prompts/test-panel";
import {
  ArchiveTemplateButton,
  DeprecateButton,
  NewPromptDraftButton,
  PinControl,
  PublishDialog,
  UnpinButton,
} from "@/components/prompts/version-controls";
import { IssueList, VersionEditor } from "@/components/prompts/version-editor";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { diffLines } from "@/lib/diff";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/rbac";
import { RULE_KINDS, TEXT_KINDS } from "@/lib/schemas/prompt";
import { cn, formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { versionIssues } from "@/server/services/prompts";

export const metadata: Metadata = { title: "Prompt template" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PromptTemplatePage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const sp = await searchParams;
  const user = await requireUser();
  const template = await db.promptTemplate.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { version: "desc" } },
      creator: { select: { name: true } },
      campaign: { select: { name: true } },
      pins: { include: { campaign: { select: { id: true, name: true, status: true } }, promptVersion: { select: { version: true } } } },
    },
  });
  if (!template) notFound();

  const requested = Number(typeof sp.v === "string" ? sp.v : NaN);
  const v =
    template.versions.find((x) => x.version === requested) ??
    template.versions.find((x) => x.status === "DRAFT") ??
    template.versions.find((x) => x.status === "PUBLISHED") ??
    template.versions[0];
  if (!v) notFound();
  const previous = template.versions.find((x) => x.version < v.version);
  const { defs, issues } = versionIssues(v);

  const canEdit = can(user.role, "prompts:edit") && !template.archivedAt;
  const needsAdmin = template.scope === "GLOBAL" || (RULE_KINDS as readonly string[]).includes(template.kind);
  const canPublish = canEdit && can(user.role, needsAdmin ? "prompts:publish" : "prompts:edit");
  const hasDraft = template.versions.some((x) => x.status === "DRAFT");
  const generates = (TEXT_KINDS as readonly string[]).includes(template.kind);

  const [creators, campaigns, runs] = await Promise.all([
    db.creator.findMany({ where: { status: { not: "ARCHIVED" }, ...(template.creatorId ? { id: template.creatorId } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.campaign.findMany({ where: { status: { notIn: ["COMPLETED", "ARCHIVED"] }, ...(template.campaignId ? { id: template.campaignId } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.promptTestRun.findMany({ where: { promptVersion: { templateId: template.id } }, orderBy: { createdAt: "desc" }, take: 20, include: { promptVersion: { select: { version: true } } } }),
  ]);
  const creatorNames = new Map(creators.map((c) => [c.id, c.name]));
  const runViews: TestRunView[] = runs.map((r) => ({
    id: r.id,
    version: r.promptVersion.version,
    createdAt: formatDateTime(r.createdAt),
    status: r.status,
    isMock: r.isMock,
    providerKey: r.providerKey,
    creatorName: r.creatorId ? creatorNames.get(r.creatorId) ?? "creator" : null,
    variables: r.variables as Record<string, unknown>,
    renderedPrompt: r.renderedPrompt,
    safetyRules: r.safetyRules,
    output: r.output,
    cost: r.costMicros === null ? "unknown" : formatMoney(r.costMicros, "EUR", 4),
  }));
  const diff = previous ? diffLines(previous.body, v.body) : null;
  const pinOptions = campaigns.map((c) => ({ id: c.id, name: c.name, pinnedVersion: template.pins.find((p) => p.campaignId === c.id)?.promptVersion.version ?? null }));

  return (
    <>
      <PageHeader
        title={template.name}
        description={`${template.key} · ${humanize(template.kind)} · ${humanize(template.scope)}${template.creator ? ` · ${template.creator.name}` : ""}${template.campaign ? ` · ${template.campaign.name}` : ""}`}
        actions={
          <>
            <Link href="/prompts" className="text-sm text-primary hover:underline">All templates</Link>
            {canEdit && !hasDraft ? <NewPromptDraftButton templateId={template.id} /> : null}
            {can(user.role, "prompts:edit") ? <ArchiveTemplateButton templateId={template.id} archived={template.archivedAt !== null} /> : null}
          </>
        }
      />
      {template.archivedAt ? <p className="-mt-3 text-xs text-warning">Archived — not used for new content. Existing content keeps its pinned version.</p> : null}

      <div className="grid gap-4 xl:grid-cols-[13rem_1fr]">
        <nav aria-label="Versions" className="flex gap-2 overflow-x-auto xl:flex-col">
          {template.versions.map((x) => (
            <Link
              key={x.id}
              href={`/prompts/${template.id}?v=${x.version}`}
              aria-current={x.id === v.id ? "page" : undefined}
              className={cn("flex min-w-36 flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm hover:bg-accent", x.id === v.id && "ring-2 ring-primary/40")}
            >
              <span className="flex items-center justify-between gap-2 font-medium">v{x.version} <StatusBadge status={x.status} /></span>
              <span className="text-xs text-muted-foreground">{formatDateTime(x.publishedAt ?? x.createdAt)}</span>
            </Link>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Version {v.version}</CardTitle>
                <CardDescription>{v.status === "DRAFT" ? "Draft — editable." : v.changelog ? `Changelog: ${v.changelog}` : humanize(v.status)}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {v.status === "DRAFT" && canPublish ? <PublishDialog versionId={v.id} version={v.version} needsAdmin={needsAdmin} /> : null}
                {v.status === "PUBLISHED" && canPublish ? <DeprecateButton versionId={v.id} /> : null}
              </div>
            </CardHeader>
            <CardContent>
              {v.status === "DRAFT" && canEdit ? (
                <VersionEditor key={v.id} versionId={v.id} initialBody={v.body} initialVariables={defs} initialIssues={issues} />
              ) : (
                <div className="grid gap-4">
                  <pre className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[13px]" aria-label="Template body">{v.body || "(empty)"}</pre>
                  {v.status === "DRAFT" ? <IssueList issues={issues} /> : null}
                  {defs.length > 0 ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Variable</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Required</TableHead>
                          <TableHead>Default</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {defs.map((d) => (
                          <TableRow key={d.name}>
                            <TableCell><code className="font-mono text-xs">{d.name}</code> <span className="text-xs text-muted-foreground">{d.label}</span></TableCell>
                            <TableCell className="text-xs">{d.type}{d.type === "enum" ? `: ${d.options.join(", ")}` : ""}</TableCell>
                            <TableCell className="text-xs">{d.required ? "yes" : "no"}</TableCell>
                            <TableCell className="text-xs">{d.default ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {diff ? (
            <Card>
              <CardHeader>
                <CardTitle>Changes since v{previous!.version}</CardTitle>
              </CardHeader>
              <CardContent>
                {diff.every((l) => l.op === "same") ? (
                  <p className="text-xs text-muted-foreground">Template body unchanged.</p>
                ) : (
                  <pre className="overflow-x-auto rounded-lg border font-mono text-xs" aria-label="Version diff">
                    {diff.map((l, i) => (
                      <div key={i} className={cn("px-3", l.op === "add" && "bg-success/10 text-success", l.op === "del" && "bg-destructive/10 text-destructive")}>
                        {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
                        {l.text}
                      </div>
                    ))}
                  </pre>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Campaign pins</CardTitle>
              <CardDescription>A pinned campaign keeps using that exact version until it is re-pinned, even when newer versions are published.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {template.pins.length === 0 ? <p className="text-xs text-muted-foreground">Not pinned by any campaign.</p> : null}
              {template.pins.map((p) => (
                <div key={p.campaignId} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="outline">v{p.promptVersion.version}</Badge> {p.campaign.name} <StatusBadge status={p.campaign.status} />
                  {canEdit ? <UnpinButton templateId={template.id} campaignId={p.campaignId} /> : null}
                </div>
              ))}
              {v.status === "PUBLISHED" && canEdit ? <PinControl templateId={template.id} versionId={v.id} campaigns={pinOptions} /> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test</CardTitle>
              <CardDescription>Render with real creator/campaign context and record test runs with their exact prompt, output and cost.</CardDescription>
            </CardHeader>
            <CardContent>
              {can(user.role, "prompts:edit") && v.status !== "DEPRECATED" ? (
                <TestPanel key={v.id} versionId={v.id} variables={defs} creators={creators} campaigns={campaigns} runs={runViews} generates={generates} />
              ) : (
                <EmptyState title="Testing unavailable" description={v.status === "DEPRECATED" ? "Deprecated versions cannot be tested." : "Your role cannot run prompt tests."} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
