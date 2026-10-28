import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";
import { ItemActions, LiveRefresh, MediaReviewButtons, RegenerateShotButton } from "@/components/content/content-actions";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isProducible, PIPELINE_STEPS, STEP_LABELS, type PipelineStep, type TechnicalCheck } from "@/lib/content-pipeline";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/rbac";
import { cn, formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { costPerUsableAsset } from "@/server/services/content";
import { shotList } from "@/server/services/content-pipeline";
import { storage } from "@/server/storage";

export const metadata: Metadata = { title: "Content item" };
type Props = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f-]{36}$/;

interface QcReport {
  pass: boolean;
  reasons: string[];
  score: number;
  summary: string;
  identityChecked: boolean;
  issues: { severity: string; shot: number; message: string }[];
  notes: string[];
}

function StepIcon({ state }: { state: "done" | "running" | "failed" | "pending" }) {
  if (state === "done") return <CircleCheck className="size-4 text-success" aria-hidden />;
  if (state === "running") return <Loader2 className="size-4 animate-spin text-info" aria-hidden />;
  if (state === "failed") return <CircleX className="size-4 text-destructive" aria-hidden />;
  return <CircleDashed className="size-4 text-muted-foreground" aria-hidden />;
}

export default async function ContentItemPage({ params }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await requireUser();
  const item = await db.contentItem.findUnique({
    where: { id },
    include: {
      creator: { select: { id: true, name: true } },
      campaign: { select: { id: true, name: true } },
      batch: { select: { id: true, name: true } },
      generationJobs: { orderBy: { createdAt: "asc" }, include: { provider: { select: { displayName: true } } } },
      mediaAssets: { where: { source: "GENERATED" }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!item) notFound();

  const cost = await costPerUsableAsset({ contentItemId: item.id });
  const busy = item.generationJobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING");
  // Between two steps no job is active for a moment; keep refreshing while the chain is underway.
  const chainRunning =
    !item.failedStep &&
    item.generationJobs.length > 0 &&
    (["BRIEFED", "SCRIPTED", "PROMPTED", "GENERATING"].includes(item.status) || (item.status === "QC_REVIEW" && !item.qualityReport));
  const inFlight = busy || chainRunning;
  const shots = shotList(item);
  const urls = new Map(await Promise.all(item.mediaAssets.map(async (a) => [a.id, await storage().previewUrl(a.storageKey)] as const)));
  const qc = item.qualityReport as QcReport | null;
  const brief = item.brief as Record<string, string>;

  const stepState = (step: PipelineStep): "done" | "running" | "failed" | "pending" => {
    const jobs = item.generationJobs.filter((j) => j.step === step);
    if (jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING")) return "running";
    if (item.failedStep === step) return "failed";
    return jobs.some((j) => j.status === "SUCCEEDED") ? "done" : "pending";
  };
  const reviewing = item.status === "QC_REVIEW" || item.status === "READY";

  return (
    <>
      <LiveRefresh active={inFlight} />
      <PageHeader
        title={item.title}
        description={`${humanize(item.format)} · ${item.creator.name}${item.campaign ? ` · ${item.campaign.name}` : ""}${item.batch ? ` · batch ${item.batch.name}` : ""}`}
        actions={
          <ItemActions
            itemId={item.id}
            status={item.status}
            failedStep={item.failedStep}
            busy={inFlight}
            producible={isProducible(item.format)}
            canRun={can(user.role, "generation:run")}
            canApprove={can(user.role, "content:approve")}
            canEdit={can(user.role, "content:edit")}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={item.status} />
        {inFlight ? <StatusBadge status="RUNNING" /> : null}
        {item.isDemo ? <OriginBadge kind="demo" /> : null}
        {item.mediaAssets.some((a) => a.isMock) ? <OriginBadge kind="mock" /> : null}
        <span className="text-xs text-muted-foreground">
          Generations {item.generationCount}/{item.maxGenerations} · content cost {formatMoney(cost.spentMicros, "EUR", 4)}
          {cost.perAssetMicros !== null ? ` · ${formatMoney(cost.perAssetMicros, "EUR", 4)} per usable asset` : ""}
        </span>
      </div>

      {item.failedStep && item.lastError ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-medium">{STEP_LABELS[item.failedStep as PipelineStep] ?? item.failedStep} failed</p>
            <p className="text-muted-foreground">{item.lastError}</p>
            <p className="mt-1 text-xs text-muted-foreground">Fix the cause, then resume: steps that already succeeded are not run (or paid for) again.</p>
          </div>
        </div>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Pipeline">
            {PIPELINE_STEPS.map((s) => (
              <li key={s} className="flex items-center gap-1.5" data-state={stepState(s)}>
                <StepIcon state={stepState(s)} /> {STEP_LABELS[s]}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <StepIcon state={item.status === "APPROVED" || item.status === "SCHEDULED" || item.status === "PUBLISHED" ? "done" : "pending"} /> Human approval
            </li>
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Brief</CardTitle>
            <CardDescription>{item.idea || "No idea text"}</CardDescription>
          </CardHeader>
          <CardContent>
            {brief.angle ? (
              <dl className="grid gap-2 text-sm">
                {(["angle", "hook", "key_message", "visual_direction", "pillar"] as const).map((k) => (
                  <div key={k}>
                    <dt className="text-xs text-muted-foreground">{humanize(k)}</dt>
                    <dd>{brief[k]}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Not written yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Caption</CardTitle>
            <CardDescription>{item.aiDisclosure ? "AI disclosure on" : "AI disclosure off"}</CardDescription>
          </CardHeader>
          <CardContent>
            {item.caption ? (
              <>
                <p className="whitespace-pre-wrap text-sm">{item.caption}</p>
                <p className="mt-2 text-xs text-muted-foreground">{item.hashtags.map((h) => `#${h}`).join(" ")}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Not written yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {qc ? (
        <Card aria-label="Quality control">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Quality control <Badge tone={qc.pass ? "success" : "warning"}>{qc.pass ? "Passed" : "Needs attention"}</Badge>
              <span className="text-sm font-normal text-muted-foreground">score {qc.score}/100</span>
            </CardTitle>
            <CardDescription>{qc.summary}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {qc.reasons.length ? <p className="text-destructive">{qc.reasons.join(" · ")}</p> : null}
            {!qc.identityChecked ? <p className="text-xs text-muted-foreground">No canonical reference photos: character consistency was not checked.</p> : null}
            {qc.issues.length ? (
              <ul className="grid gap-1">
                {qc.issues.map((i, n) => (
                  <li key={n} className="flex gap-2">
                    <Badge tone={i.severity === "error" ? "danger" : "warning"}>{i.severity}</Badge>
                    <span>
                      {i.shot > 0 ? `Shot ${i.shot}: ` : ""}
                      {i.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {qc.notes.map((n) => (
              <p key={n} className="text-xs text-muted-foreground">
                {n}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {shots.length ? (
        <section className="grid gap-4" aria-label="Shots">
          {shots.map((shot, i) => {
            const takes = item.mediaAssets.filter((a) => a.shotIndex === i);
            return (
              <Card key={i} aria-label={`Shot ${i + 1}`}>
                <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>Shot {i + 1}</CardTitle>
                    <CardDescription>{shot.scene}</CardDescription>
                  </div>
                  {reviewing && can(user.role, "generation:run") ? <RegenerateShotButton itemId={item.id} shot={i} disabled={inFlight} /> : null}
                </CardHeader>
                <CardContent>
                  {takes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No image yet.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {takes.map((a, t) => {
                        const report = a.qualityReport as { technical?: TechnicalCheck[] } | null;
                        const failing = report?.technical?.filter((c) => !c.ok) ?? [];
                        return (
                          <figure key={a.id} className={cn("grid min-w-0 gap-2 rounded-lg border p-2", a.status === "APPROVED" && "border-success ring-1 ring-success")}>
                            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated media route, not optimisable */}
                            <img src={urls.get(a.id)} alt={`Shot ${i + 1}, take ${t + 1}`} className="aspect-[2/3] w-full rounded-md bg-muted object-contain" />
                            <figcaption className="grid gap-1.5 text-xs">
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="font-medium">Take {t + 1}</span>
                                <StatusBadge status={a.status} />
                                {a.isMock ? <OriginBadge kind="mock" /> : null}
                              </div>
                              {failing.length ? <p className="text-muted-foreground">{failing.map((c) => c.check).join(", ")}</p> : null}
                              {reviewing && can(user.role, "content:approve") && a.status !== "ARCHIVED" ? <MediaReviewButtons assetId={a.id} status={a.status} label={`shot ${i + 1} take ${t + 1}`} /> : null}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </section>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>Each step is a separate job with its own idempotency key; costs come from the ledger.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {item.generationJobs.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">No jobs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Finished</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {item.generationJobs.map((j) => {
                  const p = j.params as { shot?: number; take?: number; model?: string };
                  const err = j.error as { message?: string } | null;
                  return (
                    <TableRow key={j.id}>
                      <TableCell className="text-sm">
                        {STEP_LABELS[j.step as PipelineStep] ?? j.step}
                        {j.step === "image" ? <span className="text-muted-foreground"> · shot {(p.shot ?? 0) + 1}, take {p.take}</span> : null}
                        {err?.message ? <p className="max-w-md text-xs text-destructive">{err.message}</p> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {j.provider.displayName} {j.isMock ? <OriginBadge kind="mock" /> : null}
                        {p.model ? <span className="block font-mono text-muted-foreground">{p.model}</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{j.attempt}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {j.isMock ? "€0 (mock)" : j.actualCostMicros === null ? "—" : `${formatMoney(j.actualCostMicros, "EUR", 4)}${j.costBasis === "ESTIMATED" ? " (estimated)" : ""}`}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(j.finishedAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <Link href={`/content?creator=${item.creator.id}`} className="underline-offset-2 hover:underline">
          More content from {item.creator.name}
        </Link>
      </p>
    </>
  );
}
