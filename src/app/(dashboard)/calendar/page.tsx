import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseFilters } from "@/lib/filters";
import { humanize } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Content Calendar" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CalendarPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 86_400_000);
  const jobs = await db.publishingJob.findMany({
    where: {
      scheduledFor: { gte: new Date(now.getTime() - 86_400_000), lte: horizon },
      status: { not: "CANCELLED" },
      ...(f.platform ? { platform: f.platform } : {}),
      contentItem: { ...(f.creator ? { creatorId: f.creator } : {}), ...(f.campaign ? { campaignId: f.campaign } : {}) },
    },
    orderBy: { scheduledFor: "asc" },
    include: { contentItem: { select: { title: true, isDemo: true, creator: { select: { name: true, timezone: true } } } }, socialAccount: { select: { handle: true } } },
  });

  const byDay = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const key = j.scheduledFor.toISOString().slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), j]);
  }
  const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(d));

  return (
    <>
      <PageHeader title="Content Calendar" description="Agenda of the next 30 days (UTC). Times are shown per creator timezone once the full calendar ships." />
      <PhaseNotice
        phase={7}
        title="Calendar"
        items={["Day, week and month views", "Bulk scheduling, pause/resume and rescheduling", "Conflict and frequency-limit detection", "Per-platform schedules within API rate limits"]}
      />
      {byDay.size === 0 ? (
        <Card>
          <EmptyState icon={CalendarDays} title="Nothing scheduled in the next 30 days" />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {[...byDay.entries()].map(([day, list]) => (
            <Card key={day}>
              <CardHeader>
                <CardTitle>{dayLabel(day)}</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <ul className="divide-y">
                  {list.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                      <span className="w-14 text-xs tabular-nums text-muted-foreground">{j.scheduledFor.toISOString().slice(11, 16)}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {j.contentItem.title} <span className="text-muted-foreground">· {j.contentItem.creator.name} · @{j.socialAccount.handle}</span>
                      </span>
                      <Badge tone="outline">{humanize(j.platform)}</Badge>
                      <StatusBadge status={j.status} />
                      {j.isMock ? <OriginBadge kind="mock" /> : j.contentItem.isDemo ? <OriginBadge kind="demo" /> : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
