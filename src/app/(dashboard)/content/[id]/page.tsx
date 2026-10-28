import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";
import { ItemActions, LiveRefresh, MediaReviewButtons, RegenerateShotButton } from "@/components/content/content-actions";
import { JobActions, ScheduleForm } from "@/components/publishing/publishing-controls";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FORMAT_SPECS, isProducible, stepLabel, stepsFor, type PipelineStep, type TechnicalCheck } from "@/lib/content-pipeline";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/rbac";
import { formatInZone } from "@/lib/time";
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
      creator: { select: { id: true, name: true, timezone: true } },
      campaign: { select: { id: true, name: true } },
      batch: { select: { id: true, name: true } },
      generationJobs: { orderBy: { createdAt: "asc" }, include: { provider: { select: { displayName: true } } } },
      mediaAssets: { where: { source: { in: ["GENERATED", "DERIVED"] } }, orderBy: { createdAt: "asc" } },
      scenes: { orderBy: { position: "asc" } },
    },
  });
  if (!item) notFound();

  const cost = await costPerUsableAsset({ contentItemId: item.id });
  const [accounts, publications] = await Promise.all([
    db.socialAccount.findMany({ where: { creatorId: item.creatorId }, orderBy: { handle: "asc" }, select: { id: true, handle: true, status: true, isMock: true } }),
    db.publishingJob.findMany({ where: { contentItemId: item.id }, orderBy: { scheduledFor: "asc" }, include: { socialAccount: { select: { handle: true } } } }),
  ]);
  const publishable = ["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"].includes(item.status);
  const tz = item.creator.timezone;
  const busy = item.generationJobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING");
  // Between two steps no job is active for a moment; keep refreshing while the chain is underway.
  const chainRunning =
    !item.failedStep &&
    item.generationJobs.length > 0 &&
    (["BRIEFED", "SCRIPTED", "PROMPTED", "GENERATING"].includes(item.status) || (item.status === "QC_REVIEW" && !item.qualityReport));
  const inFlight = busy || chainRunning;
  const shots = shotList(item);
  const kind = FORMAT_SPECS[item.format]?.kind ?? "photo";
  const video = kind === "video";
  const visualKind = video ? "VIDEO" : "IMAGE";
  const finals = item.mediaAssets.filter((a) => a.kind === "VIDEO" && a.source === "DERIVED");
  const final = finals.at(-1) ?? null;
  const subtitles = item.mediaAssets.filter((a) => a.kind === "SUBTITLE").at(-1) ?? null;
  const finalReport = final?.qualityReport as { technical?: TechnicalCheck[]; pass?: boolean } | null;
  const noun = video ? "Scene" : "Shot";
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
      <LiveRefresh
        active={inFlight || publications.some((p) => ["QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION"].includes(p.status) || (p.status === "SCHEDULED" && p.scheduledFor.getTime() < Date.now() + 120_000))}
      />
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
            <p className="font-medium">{stepLabel(item.failedStep as PipelineStep, kind)} failed</p>
            <p className="text-muted-foreground">{item.lastError}</p>
            <p className="mt-1 text-xs text-muted-foreground">Fix the cause, then resume: steps that already succeeded are not run (or paid for) again.</p>
          </div>
        </div>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Pipeline">
            {stepsFor(kind).map((s) => (
              <li key={s} className="flex items-center gap-1.5" data-state={stepState(s)}>
                <StepIcon state={stepState(s)} /> {stepLabel(s, kind)}
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
                      {i.shot > 0 ? `${noun} ${i.shot}: ` : ""}
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

      {final ? (
        <Card aria-label="Final video">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Final video <StatusBadge status={final.status} /> {final.isMock ? <OriginBadge kind="mock" /> : null}
              <span className="text-sm font-normal text-muted-foreground">
                {final.width}×{final.height} · {((final.durationMs ?? 0) / 1000).toFixed(1)} s{finals.length > 1 ? ` · assembly ${finals.length}` : ""}
              </span>
            </CardTitle>
            <CardDescription>Assembled from the {video ? "scene clips and voice-overs" : "takes"} below, loudness-normalised, with subtitles as a separate WebVTT file.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
            <video controls preload="metadata" src={urls.get(final.id)} className="aspect-[9/16] w-full rounded-md bg-black" aria-label="Final video player">
              {subtitles ? <track kind="subtitles" src={urls.get(subtitles.id)} srcLang="en" label="Subtitles" default /> : null}
            </video>
            <ul className="grid content-start gap-1 text-xs" aria-label="Technical checks">
              {(finalReport?.technical ?? []).map((c) => (
                <li key={c.check} className={c.ok ? "text-muted-foreground" : c.severity === "error" ? "text-destructive" : "text-warning"}>
                  {c.ok ? "✓" : "✗"} <span className="font-medium">{c.check}</span>: {c.detail}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {shots.length ? (
        <section className="grid gap-4" aria-label={video ? "Scenes" : "Shots"}>
          {shots.map((shot, i) => {
            const takes = item.mediaAssets.filter((a) => a.shotIndex === i && a.kind === visualKind);
            const scene = item.scenes[i];
            const voice = item.mediaAssets.filter((a) => a.shotIndex === i && a.kind === "AUDIO").at(-1);
            return (
              <Card key={i} aria-label={`${noun} ${i + 1}`}>
                <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>
                      {noun} {i + 1}
                      {scene ? <span className="ml-2 text-sm font-normal text-muted-foreground">{scene.durationMs / 1000} s</span> : null}
                    </CardTitle>
                    <CardDescription>{shot.scene}</CardDescription>
                  </div>
                  {reviewing && can(user.role, "generation:run") ? <RegenerateShotButton itemId={item.id} shot={i} disabled={inFlight} label={video ? "New clip" : "New take"} /> : null}
                </CardHeader>
                <CardContent className="grid gap-3">
                  {scene?.dialogue ? (
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="text-muted-foreground">Voice-over:</span> <span className="min-w-0 flex-1">“{scene.dialogue}”</span>
                      {voice ? <audio controls preload="none" src={urls.get(voice.id)} className="h-8 max-w-full" aria-label={`Voice-over scene ${i + 1}`} /> : null}
                    </div>
                  ) : null}
                  {takes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{video ? "No clip yet." : "No image yet."}</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {takes.map((a, t) => {
                        const report = a.qualityReport as { technical?: TechnicalCheck[] } | null;
                        const failing = report?.technical?.filter((c) => !c.ok) ?? [];
                        return (
                          <figure key={a.id} className={cn("grid min-w-0 gap-2 rounded-lg border p-2", a.status === "APPROVED" && "border-success ring-1 ring-success")}>
                            {video ? (
                              <video controls muted preload="metadata" src={`${urls.get(a.id)}#t=0.5`} className="aspect-[9/16] w-full rounded-md bg-black" aria-label={`Scene ${i + 1}, take ${t + 1}`} />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element -- authenticated media route, not optimisable
                              <img src={urls.get(a.id)} alt={`Shot ${i + 1}, take ${t + 1}`} className="aspect-[2/3] w-full rounded-md bg-muted object-contain" />
                            )}
                            <figcaption className="grid gap-1.5 text-xs">
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="font-medium">Take {t + 1}</span>
                                <StatusBadge status={a.status} />
                                {a.isMock ? <OriginBadge kind="mock" /> : null}
                              </div>
                              {failing.length ? <p className="text-muted-foreground">{failing.map((c) => c.check).join(", ")}</p> : null}
                              {reviewing && can(user.role, "content:approve") && a.status !== "ARCHIVED" ? <MediaReviewButtons assetId={a.id} status={a.status} label={`${noun.toLowerCase()} ${i + 1} take ${t + 1}`} /> : null}
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

      {publishable ? (
        <Card aria-label="Publishing">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Publishing</CardTitle>
              <CardDescription>Times in {item.creator.name}&apos;s time zone ({tz}). The export package is the supported alternative when API publishing is not possible.</CardDescription>
            </div>
            {can(user.role, "publishing:schedule") ? (
              <a href={`/api/content/${item.id}/export`} className="text-sm underline-offset-2 hover:underline" download>
                Download export package
              </a>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-4">
            {can(user.role, "publishing:schedule") && item.status !== "PUBLISHED" ? <ScheduleForm itemId={item.id} accounts={accounts} timeZone={tz} /> : null}
            {publications.length ? (
              <ul className="divide-y rounded-md border" aria-label="Publications">
                {publications.map((pub) => {
                  const err = pub.lastError as { message?: string } | null;
                  return (
                    <li key={pub.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className="font-medium">@{pub.socialAccount.handle}</span>
                      <span className="text-muted-foreground">{formatInZone(pub.scheduledFor, tz)}</span>
                      <StatusBadge status={pub.status} />
                      {pub.isMock ? <OriginBadge kind="mock" /> : null}
                      {pub.externalUrl ? (
                        <a href={pub.externalUrl} className="text-xs underline-offset-2 hover:underline">
                          View post
                        </a>
                      ) : null}
                      <span className="ml-auto">
                        {can(user.role, "publishing:schedule") ? <JobActions jobId={pub.id} status={pub.status} timeZone={tz} label={`@${pub.socialAccount.handle}`} /> : null}
                      </span>
                      {err?.message && pub.status !== "PUBLISHED" ? <p className="w-full text-xs text-destructive">{err.message}</p> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </CardContent>
        </Card>
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
                        {stepLabel(j.step as PipelineStep, kind)}
                        {p.shot !== undefined ? <span className="text-muted-foreground"> · {noun.toLowerCase()} {p.shot + 1}, take {p.take}</span> : null}
                        {err?.message ? <p className="max-w-md text-xs text-destructive">{err.message}</p> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {j.provider?.displayName ?? "FFmpeg (local)"} {j.isMock ? <OriginBadge kind="mock" /> : null}
                        {p.model ? <span className="block font-mono text-muted-foreground">{p.model}</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{j.attempt}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {j.isMock ? "€0 (mock)" : !j.providerId ? "€0 (local)" : j.actualCostMicros === null ? "—" : `${formatMoney(j.actualCostMicros, "EUR", 4)}${j.costBasis === "ESTIMATED" ? " (estimated)" : ""}`}
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
