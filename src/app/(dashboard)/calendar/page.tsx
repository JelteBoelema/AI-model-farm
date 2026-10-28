import type { Metadata } from "next";
import Link from "next/link";
import type { PublishingStatus } from "@prisma/client";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { BulkPlanDialog, TimeZoneSelect } from "@/components/publishing/calendar-controls";
import { JobActions } from "@/components/publishing/publishing-controls";
import { Card, CardContent } from "@/components/ui/card";
import { parseFilters } from "@/lib/filters";
import { can } from "@/lib/rbac";
import { addDays, dayKey, formatInZone, isKnownTimeZone, weekdayOf, zonedToUtc } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Content Calendar" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const VIEWS = ["month", "week", "day"] as const;
type View = (typeof VIEWS)[number];
const DEFAULT_TZ = "Europe/Amsterdam";
const OCCUPYING: PublishingStatus[] = ["SCHEDULED", "QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION", "PUBLISHED"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function range(view: View, anchor: string): { days: string[]; prev: string; next: string } {
  if (view === "day") return { days: [anchor], prev: addDays(anchor, -1), next: addDays(anchor, 1) };
  const monday = addDays(anchor, 1 - weekdayOf(anchor));
  if (view === "week") return { days: Array.from({ length: 7 }, (_, i) => addDays(monday, i)), prev: addDays(anchor, -7), next: addDays(anchor, 7) };
  const first = `${anchor.slice(0, 8)}01`;
  const start = addDays(first, 1 - weekdayOf(first));
  const nextMonth = addDays(first, 32).slice(0, 8) + "01";
  const days: string[] = [];
  for (let d = start; d < nextMonth || weekdayOf(d) !== 1; d = addDays(d, 1)) days.push(d);
  return { days, prev: addDays(first, -1).slice(0, 8) + "01", next: nextMonth };
}

export default async function CalendarPage({ searchParams }: Props) {
  const raw = await searchParams;
  const user = await requireUser();
  const f = parseFilters(raw);
  const tz = typeof raw.tz === "string" && isKnownTimeZone(raw.tz) ? raw.tz : DEFAULT_TZ;
  const view: View = VIEWS.includes(raw.view as View) ? (raw.view as View) : "week";
  const today = dayKey(new Date(), tz);
  const anchor = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : today;
  const { days, prev, next } = range(view, anchor);
  const at = (key: string) => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number];
    return zonedToUtc(y, m, d, 0, 0, tz);
  };
  const from = at(days[0]!);
  const to = at(addDays(days.at(-1)!, 1));

  const [jobs, creators, accounts] = await Promise.all([
    db.publishingJob.findMany({
      where: {
        scheduledFor: { gte: from, lt: to },
        status: { not: "CANCELLED" },
        ...(f.platform ? { platform: f.platform } : {}),
        contentItem: { ...(f.creator ? { creatorId: f.creator } : {}), ...(f.campaign ? { campaignId: f.campaign } : {}) },
      },
      orderBy: { scheduledFor: "asc" },
      include: {
        contentItem: { select: { id: true, title: true, isDemo: true, creator: { select: { name: true, timezone: true } } } },
        socialAccount: { select: { id: true, handle: true, maxPostsPerDay: true, minGapMinutes: true } },
      },
    }),
    db.creator.findMany({ select: { timezone: true }, distinct: ["timezone"] }),
    db.socialAccount.findMany({
      where: { status: { in: ["CONNECTED", "INSUFFICIENT_SCOPE"] }, ...(f.creator ? { creatorId: f.creator } : {}) },
      orderBy: { handle: "asc" },
      include: { creator: { select: { name: true, contentItems: { where: { status: "APPROVED" }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 50 } } } },
    }),
  ]);

  // Conflicts: per account, per day in the creator's time zone — over the daily limit or closer than the minimum gap.
  const conflicts = new Map<string, string>();
  const occupying = jobs.filter((j) => OCCUPYING.includes(j.status));
  for (const j of occupying) {
    const ctz = j.contentItem.creator.timezone;
    const sameDay = occupying.filter((o) => o.socialAccountId === j.socialAccountId && dayKey(o.scheduledFor, ctz) === dayKey(j.scheduledFor, ctz));
    if (sameDay.length > j.socialAccount.maxPostsPerDay) conflicts.set(j.id, `${sameDay.length} posts that day on @${j.socialAccount.handle} (limit ${j.socialAccount.maxPostsPerDay})`);
    const close = occupying.find((o) => o.id !== j.id && o.socialAccountId === j.socialAccountId && Math.abs(o.scheduledFor.getTime() - j.scheduledFor.getTime()) < j.socialAccount.minGapMinutes * 60_000);
    if (close) conflicts.set(j.id, `Less than ${j.socialAccount.minGapMinutes} minutes from another post on @${j.socialAccount.handle}`);
  }

  const byDay = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const key = dayKey(j.scheduledFor, tz);
    byDay.set(key, [...(byDay.get(key) ?? []), j]);
  }
  const zones = [...new Set(["UTC", DEFAULT_TZ, tz, ...creators.map((c) => c.timezone)])].sort();
  const href = (q: Record<string, string>) => {
    const p = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    for (const [k, v] of Object.entries(q)) p.set(k, v);
    return `/calendar?${p}`;
  };
  const canSchedule = can(user.role, "publishing:schedule");
  const title =
    view === "month"
      ? formatInZone(at(anchor), tz, { month: "long", year: "numeric" })
      : view === "week"
        ? `${formatInZone(at(days[0]!), tz, { day: "numeric", month: "short" })} – ${formatInZone(at(days[6]!), tz, { day: "numeric", month: "short", year: "numeric" })}`
        : formatInZone(at(anchor), tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const chip = (j: (typeof jobs)[number], compact: boolean) => {
    const conflict = conflicts.get(j.id);
    return (
      <li key={j.id} className={cn("grid gap-1 rounded-md border bg-card px-2 py-1.5 text-xs", conflict && "border-warning")} title={conflict}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium tabular-nums">{formatInZone(j.scheduledFor, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>
          <StatusBadge status={j.status} />
          {j.isMock ? <OriginBadge kind="mock" /> : j.contentItem.isDemo ? <OriginBadge kind="demo" /> : null}
          {conflict ? <AlertTriangle className="size-3.5 text-warning" aria-label={`Conflict: ${conflict}`} /> : null}
        </div>
        <Link href={`/content/${j.contentItem.id}`} className="truncate hover:underline">
          {j.contentItem.title}
        </Link>
        <span className="truncate text-muted-foreground">
          @{j.socialAccount.handle}
          {compact ? "" : ` · ${j.contentItem.creator.name}`}
        </span>
        {!compact && conflict ? <span className="text-warning">{conflict}</span> : null}
        {!compact && canSchedule ? <JobActions jobId={j.id} status={j.status} timeZone={tz} label={j.contentItem.title} /> : null}
      </li>
    );
  };

  return (
    <>
      <PageHeader
        title="Content Calendar"
        description="Scheduled and published posts. Daily limits and minimum gaps are checked per account in the creator's time zone."
        actions={
          canSchedule ? (
            <BulkPlanDialog accounts={accounts.map((a) => ({ id: a.id, label: `@${a.handle} · ${a.creator.name}${a.isMock ? " (mock)" : ""}`, items: a.creator.contentItems }))} />
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Link href={href({ date: prev })} aria-label="Previous" className="rounded-md border p-1.5 hover:bg-accent">
            <ChevronLeft className="size-4" />
          </Link>
          <Link href={href({ date: today })} className="rounded-md border px-2.5 py-1 text-sm hover:bg-accent">
            Today
          </Link>
          <Link href={href({ date: next })} aria-label="Next" className="rounded-md border p-1.5 hover:bg-accent">
            <ChevronRight className="size-4" />
          </Link>
        </div>
        <h2 className="text-sm font-semibold" aria-live="polite">
          {title}
        </h2>
        <nav className="ml-auto flex gap-1 text-sm" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <Link key={v} href={href({ view: v })} aria-current={v === view ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 capitalize", v === view ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}>
              {v}
            </Link>
          ))}
        </nav>
        <TimeZoneSelect zones={zones} value={tz} />
      </div>
      {conflicts.size ? (
        <p role="status" className="flex items-center gap-2 text-sm text-warning">
          <AlertTriangle className="size-4" aria-hidden /> {conflicts.size} post(s) conflict with an account limit in this view.
        </p>
      ) : null}

      {view === "month" ? (
        <Card>
          <CardContent className="overflow-x-auto p-2">
            <div className="grid min-w-[44rem] grid-cols-7 gap-1" role="grid" aria-label="Month">
              {WEEKDAYS.map((d) => (
                <div key={d} className="px-1 text-xs font-medium text-muted-foreground" role="columnheader">
                  {d}
                </div>
              ))}
              {days.map((d) => (
                <div key={d} role="gridcell" aria-label={d} className={cn("min-h-24 rounded-md border p-1", d.slice(0, 7) !== anchor.slice(0, 7) && "opacity-50", d === today && "border-primary")}>
                  <Link href={href({ view: "day", date: d })} className="text-xs text-muted-foreground hover:underline">
                    {Number(d.slice(8))}
                  </Link>
                  <ul className="mt-1 grid gap-1">{(byDay.get(d) ?? []).map((j) => chip(j, true))}</ul>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : view === "week" ? (
        <div className="grid gap-2 md:grid-cols-7" aria-label="Week">
          {days.map((d, i) => (
            <section key={d} aria-label={d} className={cn("grid content-start gap-1 rounded-lg border bg-card/50 p-2", d === today && "border-primary")}>
              <Link href={href({ view: "day", date: d })} className="text-xs font-medium hover:underline">
                {WEEKDAYS[i]} {Number(d.slice(8))}
              </Link>
              <ul className="grid gap-1">{(byDay.get(d) ?? []).map((j) => chip(j, true))}</ul>
            </section>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-3">
            {(byDay.get(anchor) ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Nothing scheduled on this day.</p> : <ul className="grid gap-2" aria-label="Day">{byDay.get(anchor)!.map((j) => chip(j, false))}</ul>}
          </CardContent>
        </Card>
      )}
    </>
  );
}
