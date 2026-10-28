// Analytics read model. Results per published post come from its latest snapshot (metrics are
// cumulative), always for one origin at a time: measured, mock and demo numbers are never added up.
// Costs come from the cost ledger (mock generation costs nothing and is not booked).

import type { ContentFormat, DataOrigin, Platform } from "@prisma/client";
import { COMPARE_AT_HOURS, dayPart, engagementRate, WEEKDAYS } from "@/lib/analytics";
import { zonedParts } from "@/lib/time";
import { db } from "../db";

export interface AnalyticsFilter {
  origin: DataOrigin;
  /** Posts published since. */
  since?: Date | null;
  creatorId?: string;
  campaignId?: string;
  platform?: Platform;
}

export interface PostResult {
  publishingJobId: string;
  contentItemId: string;
  title: string;
  format: ContentFormat;
  pillar: string | null;
  creatorId: string;
  creatorName: string;
  campaignId: string | null;
  campaignName: string | null;
  platform: Platform;
  handle: string;
  externalUrl: string | null;
  publishedAt: Date;
  /** Local weekday name and part of day in the creator's time zone. */
  weekday: string;
  dayPart: string;
  ageHours: number | null;
  views: number;
  reach: number;
  interactions: number;
  engagement: number | null;
  /** Engagement at a comparable age (latest snapshot up to 72 h), used by insights. */
  comparableEngagement: number | null;
  comparableAgeHours: number | null;
}

const num = (v: bigint | null) => (v === null ? 0 : Number(v));

/** Every published post matching the filter with its latest numbers. */
export async function postResults(f: AnalyticsFilter): Promise<PostResult[]> {
  const jobs = await db.publishingJob.findMany({
    where: {
      status: "PUBLISHED",
      ...(f.since ? { confirmedAt: { gte: f.since } } : {}),
      ...(f.platform ? { platform: f.platform } : {}),
      contentItem: { ...(f.creatorId ? { creatorId: f.creatorId } : {}), ...(f.campaignId ? { campaignId: f.campaignId } : {}) },
      analyticsSnapshots: { some: { origin: f.origin } },
    },
    include: {
      socialAccount: { select: { handle: true } },
      contentItem: { select: { id: true, title: true, format: true, pillar: true, creatorId: true, campaignId: true, creator: { select: { name: true, timezone: true } }, campaign: { select: { name: true } } } },
      analyticsSnapshots: { where: { origin: f.origin }, orderBy: { capturedAt: "desc" }, select: { ageHours: true, views: true, reach: true, likes: true, comments: true, shares: true, saves: true } },
    },
    orderBy: { confirmedAt: "desc" },
    take: 5000,
  });
  return jobs.map((j) => {
    const latest = j.analyticsSnapshots[0]!;
    const comparable = j.analyticsSnapshots.find((s) => s.ageHours !== null && s.ageHours <= COMPARE_AT_HOURS);
    const at = j.confirmedAt ?? j.scheduledFor;
    const local = zonedParts(at, j.contentItem.creator.timezone);
    return {
      publishingJobId: j.id,
      contentItemId: j.contentItem.id,
      title: j.contentItem.title,
      format: j.contentItem.format,
      pillar: j.contentItem.pillar,
      creatorId: j.contentItem.creatorId,
      creatorName: j.contentItem.creator.name,
      campaignId: j.contentItem.campaignId,
      campaignName: j.contentItem.campaign?.name ?? null,
      platform: j.platform,
      handle: j.socialAccount.handle,
      externalUrl: j.externalUrl,
      publishedAt: at,
      weekday: WEEKDAYS[local.weekday] ?? "",
      dayPart: dayPart(local.hour),
      ageHours: latest.ageHours,
      views: num(latest.views),
      reach: num(latest.reach),
      interactions: num(latest.likes) + num(latest.comments) + num(latest.shares) + num(latest.saves),
      engagement: engagementRate(latest),
      comparableEngagement: comparable ? engagementRate(comparable) : null,
      comparableAgeHours: comparable?.ageHours ?? null,
    };
  });
}

export interface GroupRow {
  key: string;
  label: string;
  posts: number;
  views: number;
  reach: number;
  /** Interactions ÷ reach over all posts of the group. */
  engagement: number | null;
  /** Content cost of these posts (EUR micros); null when nothing was booked (mock or demo). */
  costMicros: bigint | null;
  costPerPostMicros: bigint | null;
  costPer1kViewsMicros: bigint | null;
}

async function costByItem(itemIds: string[]) {
  if (itemIds.length === 0) return new Map<string, bigint>();
  const rows = await db.costLedger.groupBy({ by: ["contentItemId"], where: { contentItemId: { in: itemIds }, isMock: false }, _sum: { amountMicros: true } });
  return new Map(rows.map((r) => [r.contentItemId!, r._sum.amountMicros ?? 0n]));
}

function group(posts: PostResult[], costs: Map<string, bigint>, keyOf: (p: PostResult) => string | null, labelOf: (p: PostResult) => string): GroupRow[] {
  const groups = new Map<string, PostResult[]>();
  for (const p of posts) {
    const k = keyOf(p);
    if (k === null) continue;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.entries()]
    .map(([key, ps]) => {
      const views = ps.reduce((s, p) => s + p.views, 0);
      const reach = ps.reduce((s, p) => s + p.reach, 0);
      const interactions = ps.reduce((s, p) => s + p.interactions, 0);
      // An item published on two accounts is paid once: count its cost once per group.
      const items = new Set(ps.map((p) => p.contentItemId));
      const booked = [...items].filter((i) => costs.has(i));
      const cost = booked.length ? booked.reduce((s, i) => s + costs.get(i)!, 0n) : null;
      return {
        key,
        label: labelOf(ps[0]!),
        posts: ps.length,
        views,
        reach,
        engagement: (reach || views) > 0 ? interactions / (reach || views) : null,
        costMicros: cost,
        costPerPostMicros: cost === null ? null : cost / BigInt(ps.length),
        costPer1kViewsMicros: cost === null || views === 0 ? null : (cost * 1000n) / BigInt(views),
      };
    })
    .sort((a, b) => b.views - a.views);
}

export interface AnalyticsOverview {
  origin: DataOrigin;
  total: GroupRow;
  followers: number | null;
  byCreator: GroupRow[];
  byCampaign: GroupRow[];
  byFormat: GroupRow[];
  byPlatform: GroupRow[];
  top: PostResult[];
}

export async function analyticsOverview(f: AnalyticsFilter): Promise<AnalyticsOverview> {
  const posts = await postResults(f);
  const costs = await costByItem([...new Set(posts.map((p) => p.contentItemId))]);
  const [total] = group(posts, costs, () => "all", () => "All posts");
  const followerRows = await db.analyticsSnapshot.findMany({
    where: { origin: f.origin, publishingJobId: null, followers: { not: null }, socialAccount: { ...(f.creatorId ? { creatorId: f.creatorId } : {}), ...(f.platform ? { platform: f.platform } : {}) } },
    orderBy: { capturedAt: "desc" },
    distinct: ["socialAccountId"],
    select: { followers: true },
  });
  return {
    origin: f.origin,
    total: total ?? { key: "all", label: "All posts", posts: 0, views: 0, reach: 0, engagement: null, costMicros: null, costPerPostMicros: null, costPer1kViewsMicros: null },
    followers: followerRows.length ? followerRows.reduce((s, r) => s + num(r.followers), 0) : null,
    byCreator: group(posts, costs, (p) => p.creatorId, (p) => p.creatorName),
    byCampaign: group(posts, costs, (p) => p.campaignId, (p) => p.campaignName ?? "—"),
    byFormat: group(posts, costs, (p) => p.format, (p) => p.format),
    byPlatform: group(posts, costs, (p) => p.platform, (p) => p.platform),
    top: [...posts].sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1) || b.views - a.views).slice(0, 10),
  };
}

/** How many snapshots exist per origin (to show which views have data). */
export async function originCounts() {
  const rows = await db.analyticsSnapshot.groupBy({ by: ["origin"], _count: true });
  return Object.fromEntries(rows.map((r) => [r.origin, r._count])) as Partial<Record<DataOrigin, number>>;
}
