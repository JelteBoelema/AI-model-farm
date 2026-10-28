// What analytics may tell the autopilot when it plans a new item. Read-only.
//   1. An experiment a person accepted: alternate its variants.
//   2. A measured pattern that meets the human-set minimum sample (both the leader and the rest of
//      the posts) and is significant: use the leader for every other item, keep exploring otherwise.
//   3. Otherwise nothing: below the minimum sample, or from mock/demo data, planning never adapts.

import type { GroupStats } from "@/lib/analytics";
import { db } from "../db";
import type { ExperimentProposal } from "./insights";

export interface PlanningHint {
  pillar?: string;
  format?: string;
  reason: string;
}

const SIGNIFICANCE = 0.05;

export async function planningHint(creatorId: string, n: number, opts: { minSample: number | null; pillars: string[]; formats: string[] }): Promise<PlanningHint | null> {
  const allowed = (dimension: string, value: string) => (dimension === "pillar" ? opts.pillars.includes(value) : opts.formats.includes(value));

  const experiment = await db.insight.findFirst({ where: { creatorId, kind: "EXPERIMENT", status: "ACCEPTED", origin: "MEASURED", dimension: { in: ["pillar", "format"] } }, orderBy: { decidedAt: "asc" } });
  if (experiment) {
    const p = experiment.proposal as unknown as ExperimentProposal;
    const variant = p.variants[n % p.variants.length];
    if (variant && allowed(experiment.dimension, variant)) return { [experiment.dimension]: variant, reason: `accepted experiment ${experiment.id.slice(0, 8)} (${p.variants.join(" vs ")})` };
  }

  if (opts.minSample === null || n % 2 === 1) return null; // odd items keep exploring
  const patterns = await db.insight.findMany({
    where: { creatorId, kind: "PATTERN", status: "OPEN", origin: "MEASURED", meetsMinSample: true, pValue: { lte: SIGNIFICANCE }, liftPercent: { gt: 0 }, dimension: { in: ["pillar", "format"] } },
    orderBy: { pValue: "asc" },
  });
  for (const p of patterns) {
    // The policy may have been raised since the pattern was computed: check the groups again.
    const groups = p.groups as unknown as GroupStats[];
    const leader = groups.find((g) => g.key === p.leader);
    const rest = groups.filter((g) => g.key !== p.leader).reduce((s, g) => s + g.n, 0);
    if (!leader || leader.n < opts.minSample || rest < opts.minSample || !allowed(p.dimension, p.leader!)) continue;
    return { [p.dimension]: p.leader!, reason: `measured pattern ${p.id.slice(0, 8)}: ${p.leader} +${Math.round(p.liftPercent!)}% engagement (${leader.n} vs ${rest} posts, p = ${p.pValue!.toFixed(3)})` };
  }
  return null;
}
