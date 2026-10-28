import type { Metadata } from "next";
import { Activity, Server, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn, formatDateTime, humanize } from "@/lib/utils";
import { db } from "@/server/db";
import { DEAD_LETTER_QUEUE, QUEUES, type QueueName } from "@/server/queue/definitions";
import { getQueue, getQueueStats, type QueueStats } from "@/server/queue/queues";
import { listHeartbeats, type WorkerHeartbeat } from "@/server/queue/worker";

export const metadata: Metadata = { title: "Workflow Monitor" };

async function loadQueueState() {
  try {
    const [stats, workers, dead] = await Promise.all([
      getQueueStats(),
      listHeartbeats(),
      getQueue(DEAD_LETTER_QUEUE).getJobs(["waiting", "delayed", "paused"], 0, 9),
    ]);
    return { ok: true as const, stats, workers, dead };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}

function consumers(workers: WorkerHeartbeat[], queue: string) {
  return workers.filter((w) => w.alive && w.queues.includes(queue)).length;
}

export default async function WorkflowsPage() {
  const [queueState, attentionJobs, attentionPublishing] = await Promise.all([
    loadQueueState(),
    db.generationJob.findMany({
      where: { status: { in: ["FAILED", "DEAD_LETTER", "BLOCKED_BUDGET", "BLOCKED_POLICY", "RUNNING"] } },
      orderBy: { updatedAt: "desc" },
      take: 15,
      select: { id: true, kind: true, status: true, attempt: true, maxAttempts: true, isMock: true, updatedAt: true, creator: { select: { name: true } }, provider: { select: { displayName: true } } },
    }),
    db.publishingJob.findMany({
      where: { status: { in: ["FAILED", "AWAITING_CONFIRMATION", "NEEDS_MANUAL_ACTION", "PUBLISHING"] } },
      orderBy: { updatedAt: "desc" },
      take: 15,
      select: { id: true, platform: true, status: true, attempt: true, isMock: true, updatedAt: true, contentItem: { select: { title: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader title="Workflow Monitor" description="Live queue depth, worker liveness and jobs that need attention. The database is the source of truth for job status." />

      {!queueState.ok ? (
        <Card className="border-destructive/40">
          <EmptyState icon={TriangleAlert} title="Queue backend unreachable" description="Redis did not respond. Check REDIS_URL and the Redis service; jobs persist and resume when it returns." />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Queues</CardTitle>
              <CardDescription>BullMQ queues with per-queue concurrency, retries with jittered exponential backoff, and dead-lettering after the final attempt.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <QueueTable stats={queueState.stats} workers={queueState.workers} />
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Workers</CardTitle>
                <CardDescription>Heartbeat every 15s; considered down after 60s of silence.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {queueState.workers.length === 0 ? (
                  <EmptyState icon={Server} title="No workers have reported" description="Start one with `pnpm worker` (or deploy the worker images)." />
                ) : (
                  <ul className="divide-y">
                    {queueState.workers.map((w) => (
                      <li key={w.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                        <span className={cn("size-2 rounded-full", w.alive ? "bg-success" : "bg-muted-foreground/40")} aria-label={w.alive ? "alive" : "down"} />
                        <code className="font-mono text-xs">{w.id}</code>
                        <span className="ml-auto truncate text-xs text-muted-foreground">{w.queues.join(", ") || "no queues"}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{formatDateTime(new Date(w.at))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Dead-letter queue</CardTitle>
                <CardDescription>Jobs that exhausted their retries. Nothing here is retried automatically.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {queueState.dead.length === 0 ? (
                  <EmptyState icon={Activity} title="No dead-lettered jobs" />
                ) : (
                  <ul className="divide-y">
                    {queueState.dead.map((j) => (
                      <li key={j.id} className="px-5 py-2.5 text-sm">
                        <code className="font-mono text-xs">{j.name}</code>
                        <p className="truncate text-xs text-muted-foreground">{String((j.data as { failedReason?: string }).failedReason ?? "")}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Generation jobs needing attention</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {attentionJobs.length === 0 ? (
              <EmptyState title="All clear" description="No running, failed or blocked generation jobs." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempt</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attentionJobs.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="text-xs">
                        {humanize(j.kind)} · {j.creator.name} <span className="text-muted-foreground">via {j.provider?.displayName ?? "FFmpeg (local)"}</span> {j.isMock ? <OriginBadge kind="mock" /> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {j.attempt}/{j.maxAttempts}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(j.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Publications needing attention</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {attentionPublishing.length === 0 ? (
              <EmptyState title="All clear" description="No failed, unconfirmed or in-flight publications." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Content</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attentionPublishing.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="text-xs">
                        {j.contentItem.title} <Badge tone="outline">{humanize(j.platform)}</Badge> {j.isMock ? <OriginBadge kind="mock" /> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(j.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function QueueTable({ stats, workers }: { stats: QueueStats[]; workers: WorkerHeartbeat[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Queue</TableHead>
          <TableHead className="text-right">Waiting</TableHead>
          <TableHead className="text-right">Active</TableHead>
          <TableHead className="text-right">Delayed</TableHead>
          <TableHead className="text-right">Failed</TableHead>
          <TableHead className="text-right">Completed</TableHead>
          <TableHead>Concurrency · retries · timeout</TableHead>
          <TableHead>Consumers</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stats.map((s) => {
          const def = s.name in QUEUES ? QUEUES[s.name as QueueName] : null;
          const n = consumers(workers, s.name);
          return (
            <TableRow key={s.name}>
              <TableCell>
                <p className="font-mono text-xs font-medium">{s.name}</p>
                <p className="text-xs text-muted-foreground">{def?.description ?? "Exhausted jobs awaiting manual review"}</p>
              </TableCell>
              {(["waiting", "active", "delayed", "failed", "completed"] as const).map((k) => (
                <TableCell key={k} className={cn("text-right tabular-nums", k === "failed" && s.counts[k] > 0 && "text-destructive")}>
                  {(s.counts[k] ?? 0) + (k === "waiting" ? (s.counts.prioritized ?? 0) : 0)}
                </TableCell>
              ))}
              <TableCell className="text-xs text-muted-foreground">
                {def ? `${def.concurrency} · ${def.attempts}× · ${Math.round(def.timeoutMs / 60000)}m` : "—"}
              </TableCell>
              <TableCell>{def ? n > 0 ? <Badge tone="success">{n} live</Badge> : <Badge tone="neutral">none</Badge> : null}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
