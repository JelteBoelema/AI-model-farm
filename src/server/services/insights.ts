// Insights: patterns in published results and experiment proposals. Everything here is a prediction
// from a sample, stored in `insights` (never next to measurements) with its sample size, p-value
// and whether the human-set minimum sample is met. Computed per origin: mock and demo data produce
// labelled illustrations, never guidance.

import type { DataOrigin, Insight, Prisma } from "@prisma/client";
import { z } from "zod";
import { describe, MIN_COMPARE_AGE_HOURS, postsPerVariant, welchPValue, type GroupStats } from "@/lib/analytics";
import { can } from "@/lib/rbac";
import { recordAudit } from "../audit";
import { db } from "../db";
import { DomainError } from "../errors";
import { postResults, type PostResult } from "./analytics";
import { assertHuman, effectivePolicy } from "./policy";
import type { ActingUser } from "./users";

export const DIMENSIONS = ["format", "pillar", "weekday", "dayPart"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** Dimensions the autopilot can act on (what it plans); timing is informational. */
export const PLANNABLE: readonly Dimension[] = ["format", "pillar"];
export const SIGNIFICANCE = 0.05;
/** Lift an experiment should be able to detect when the observed one is smaller. */
const MIN_DETECTABLE_LIFT = 0.15;
const REPROPOSE_AFTER_MS = 30 * 86_400_000;

const LABEL: Record<Dimension, string> = { format: "format", pillar: "content pillar", weekday: "weekday", dayPart: "time of day" };
const pretty = (dim: Dimension, key: string) => (dim === "format" ? key.toLowerCase().replaceAll("_", " ") : key);

export interface ExperimentProposal {
  variants: string[];
  perVariant: number;
  progress: Record<string, number>;
  [key: string]: unknown;
}

interface Comparison {
  dimension: Dimension;
  leader: GroupStats;
  rest: GroupStats;
  runnerUp: GroupStats;
  groups: GroupStats[];
  lift: number | null;
  pValue: number | null;
  sample: number;
}

/** Leader of a dimension against all other posts (null with fewer than two groups of two posts). */
export function compare(posts: PostResult[], dimension: Dimension): Comparison | null {
  const byKey = new Map<string, number[]>();
  for (const p of posts) {
    const key = p[dimension];
    if (!key || p.comparableEngagement === null) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), p.comparableEngagement]);
  }
  const groups = [...byKey.entries()].map(([k, v]) => describe(k, v)).filter((g) => g.n >= 2).sort((a, b) => b.mean - a.mean);
  if (groups.length < 2) return null;
  const leader = groups[0]!;
  const restValues = [...byKey.entries()].filter(([k]) => k !== leader.key && groups.some((g) => g.key === k)).flatMap(([, v]) => v);
  const rest = describe("rest", restValues);
  return {
    dimension,
    leader,
    rest,
    runnerUp: groups[1]!,
    groups,
    lift: rest.mean > 0 ? (leader.mean - rest.mean) / rest.mean : null,
    pValue: welchPValue(leader, rest),
    sample: leader.n + rest.n,
  };
}

const meets = (c: Comparison, minSample: number | null) => minSample !== null && c.leader.n >= minSample && c.rest.n >= minSample;

function patternText(c: Comparison, scopeName: string) {
  const lift = c.lift === null ? "" : ` ${Math.abs(Math.round(c.lift * 100))}% ${c.lift >= 0 ? "higher" : "lower"} engagement than`;
  return `${scopeName}: ${pretty(c.dimension, c.leader.key)} posts had${lift || " the highest engagement of"} the other ${LABEL[c.dimension]}s (${c.leader.n} vs ${c.rest.n} posts${c.pValue === null ? "" : `, p = ${c.pValue.toFixed(2)}`}).`;
}

async function upsertActive(fingerprint: string, data: Omit<Prisma.InsightUncheckedCreateInput, "fingerprint">) {
  const active = await db.insight.findFirst({ where: { fingerprint, status: { in: ["OPEN", "ACCEPTED"] } } });
  if (active) return db.insight.update({ where: { id: active.id }, data: active.status === "ACCEPTED" ? { computedAt: data.computedAt, proposal: data.proposal, sampleSize: data.sampleSize, groups: data.groups } : data });
  return db.insight.create({ data: { ...data, fingerprint } });
}

/** Recomputes patterns and experiment proposals for the farm and every creator, per origin. */
export async function computeInsights(now = new Date()) {
  const cutoff = new Date(now.getTime() - MIN_COMPARE_AGE_HOURS * 3_600_000);
  let patterns = 0;
  let experiments = 0;
  for (const origin of ["MEASURED", "MOCK", "DEMO"] as DataOrigin[]) {
    const posts = (await postResults({ origin })).filter((p) => p.publishedAt <= cutoff && p.comparableEngagement !== null);
    if (posts.length === 0) continue;
    const creators = [...new Set(posts.map((p) => p.creatorId))];
    const scopes: { creatorId: string | null; name: string; posts: PostResult[] }[] = [
      { creatorId: null, name: "Farm-wide", posts },
      ...creators.map((id) => ({ creatorId: id, name: posts.find((p) => p.creatorId === id)!.creatorName, posts: posts.filter((p) => p.creatorId === id) })),
    ];
    for (const scope of scopes) {
      const minSample = (await effectivePolicy({ creatorId: scope.creatorId })).analyticsMinSample;
      for (const dimension of DIMENSIONS) {
        const c = compare(scope.posts, dimension);
        if (!c) continue;
        const base = {
          creatorId: scope.creatorId,
          origin,
          dimension,
          metric: "engagement_rate",
          leader: c.leader.key,
          baseline: "other " + LABEL[dimension] + "s",
          liftPercent: c.lift === null ? null : c.lift * 100,
          pValue: c.pValue,
          sampleSize: c.sample,
          groups: c.groups as unknown as Prisma.InputJsonValue,
          minSample,
          meetsMinSample: meets(c, minSample),
          computedAt: now,
        };
        await upsertActive(`pattern:${scope.creatorId ?? "farm"}:${origin}:${dimension}`, { ...base, kind: "PATTERN", finding: patternText(c, scope.name) });
        patterns++;

        // Not settled yet: propose a controlled comparison of the two best variants.
        const settled = meets(c, minSample) && c.pValue !== null && c.pValue <= SIGNIFICANCE;
        if (!scope.creatorId || settled || !PLANNABLE.includes(dimension)) continue;
        const fingerprint = `experiment:${scope.creatorId}:${origin}:${dimension}`;
        const dismissed = await db.insight.findFirst({ where: { fingerprint, status: "DISMISSED", decidedAt: { gt: new Date(now.getTime() - REPROPOSE_AFTER_MS) } } });
        if (dismissed) continue;
        const active = await db.insight.findFirst({ where: { fingerprint, status: { in: ["OPEN", "ACCEPTED"] } } });
        const old = active?.proposal as ExperimentProposal | undefined;
        const variants = active?.status === "ACCEPTED" && old ? old.variants : [c.leader.key, c.runnerUp.key];
        const pooledSd = Math.sqrt((c.leader.sd ** 2 + c.rest.sd ** 2) / 2);
        const perVariant = active?.status === "ACCEPTED" && old ? old.perVariant : postsPerVariant(c.rest.mean, pooledSd, Math.max(Math.abs(c.lift ?? 0), MIN_DETECTABLE_LIFT), minSample ?? 10);
        const since = active?.status === "ACCEPTED" ? active.decidedAt! : now;
        const progress = Object.fromEntries(variants.map((v) => [v, scope.posts.filter((p) => p[dimension] === v && p.publishedAt >= since).length]));
        const proposal: ExperimentProposal = { variants, perVariant, progress };
        const finding = `Experiment for ${scope.name}: alternate ${variants.map((v) => pretty(dimension, v)).join(" and ")} for the next ${perVariant} posts each, then compare engagement at the same age.`;
        const row = await upsertActive(fingerprint, { ...base, kind: "EXPERIMENT", finding, proposal: proposal as unknown as Prisma.InputJsonValue });
        if (row.status === "ACCEPTED" && variants.every((v) => (progress[v] ?? 0) >= perVariant)) {
          await db.insight.update({ where: { id: row.id }, data: { status: "COMPLETED" } });
          await db.notification.create({ data: { severity: "INFO", type: "analytics.experiment_completed", title: `Experiment completed for ${scope.name}`, body: `${pretty(dimension, variants[0]!)} vs ${pretty(dimension, variants[1]!)}: enough posts to compare. See Analytics.`, link: "/analytics" } });
        }
        experiments++;
      }
    }
  }
  return { patterns, experiments };
}

/** A person accepts (the autopilot then alternates the variants) or dismisses an experiment. */
export async function decideExperiment(by: ActingUser, insightId: string, accept: boolean, reasonRaw = "") {
  assertHuman(by.actor);
  if (!can(by.role, "autonomy:raise")) throw new DomainError("Only admins and the owner steer the autopilot's planning.");
  const reason = z.string().trim().max(500).parse(reasonRaw);
  const row = await db.insight.findUnique({ where: { id: insightId } });
  if (!row || row.kind !== "EXPERIMENT" || row.status !== "OPEN") throw new DomainError("This experiment is not open");
  if (accept && row.origin !== "MEASURED") throw new DomainError("This proposal is based on mock or demo data; it can only be dismissed");
  const { count } = await db.insight.updateMany({ where: { id: row.id, status: "OPEN" }, data: { status: accept ? "ACCEPTED" : "DISMISSED", decidedById: by.id, decidedAt: new Date(), decisionReason: reason || null } });
  if (count !== 1) throw new DomainError("This experiment was decided meanwhile");
  await recordAudit(by.actor, { action: accept ? "experiment.accepted" : "experiment.dismissed", entityType: "insight", entityId: row.id, metadata: { creatorId: row.creatorId, dimension: row.dimension, proposal: row.proposal, reason } });
}

export async function listInsights(f: { origin: DataOrigin; creatorId?: string }): Promise<Insight[]> {
  return db.insight.findMany({
    where: { origin: f.origin, status: { in: ["OPEN", "ACCEPTED", "COMPLETED"] }, ...(f.creatorId ? { creatorId: f.creatorId } : {}) },
    orderBy: [{ kind: "asc" }, { meetsMinSample: "desc" }, { computedAt: "desc" }],
    take: 60,
  });
}
