import type { Metadata } from "next";
import { can } from "@/lib/rbac";
import { formatMoney, microsToDecimalString } from "@/lib/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { DEFAULT_NEW_ITEMS_PER_DAY, recentAutopilotRuns } from "@/server/services/autopilot";
import { AutopilotCard, BudgetEditor, PolicyEditor, type BudgetRow, type PolicyRow, type RunSummary, type ScopeTarget } from "./autonomy-forms";

export const metadata: Metadata = { title: "Autonomy" };

export default async function AutonomyPage() {
  const user = await requireUser();
  const [policies, budgets, creators, campaigns, providers, runs, pending] = await Promise.all([
    db.autonomyPolicy.findMany(),
    db.budgetPolicy.findMany({ orderBy: [{ scope: "asc" }, { period: "asc" }] }),
    db.creator.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true, autonomyMode: true, status: true, isDemo: true }, orderBy: { name: "asc" } }),
    db.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.aiProvider.findMany({ select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    recentAutopilotRuns(5),
    db.approval.count({ where: { decision: "PENDING", subjectType: { in: ["BUDGET_INCREASE", "POLICY_CHANGE", "SOCIAL_ACCOUNT_LINK"] } } }),
  ]);

  const targets: ScopeTarget[] = [
    ...creators.map((c) => ({ scope: "CREATOR" as const, id: c.id, label: c.name })),
    ...campaigns.map((c) => ({ scope: "CAMPAIGN" as const, id: c.id, label: c.name })),
    ...providers.map((p) => ({ scope: "PROVIDER" as const, id: p.id, label: p.displayName })),
  ];
  const names = new Map(targets.map((t) => [t.id, t.label]));

  const policyRows: PolicyRow[] = policies.map((p) => ({
    scope: p.scope,
    targetId: p.targetId,
    values: {
      maxCostPerJobEur: p.maxCostPerJobMicros === null ? null : microsToDecimalString(p.maxCostPerJobMicros),
      maxGenerationsPerItem: p.maxGenerationsPerItem,
      maxConcurrentJobs: p.maxConcurrentJobs,
      maxPostsPerDay: p.maxPostsPerDay,
      maxWorkflowMinutes: p.maxWorkflowMinutes,
      maxRetries: p.maxRetries,
      maxNewItemsPerDay: p.maxNewItemsPerDay,
      autoApproveMinScore: p.autoApproveMinScore,
      analyticsMinSample: p.analyticsMinSample,
      requireHumanApproval: p.requireHumanApproval,
    },
  }));
  const budgetRows: BudgetRow[] = budgets.map((b) => ({
    scope: b.scope,
    targetId: b.targetId,
    targetLabel: b.targetId ? (names.get(b.targetId) ?? b.targetId) : "Farm-wide",
    period: b.period,
    limitEur: microsToDecimalString(b.limitMicros),
    limitText: formatMoney(b.limitMicros),
    autoPause: b.autoPause,
    warnAtPercent: b.warnAtPercent,
  }));
  const runRows: RunSummary[] = runs.map((r) => {
    const m = (r.metadata ?? {}) as { paused?: string | null; created?: number; approved?: number; scheduled?: number; creators?: { name: string; skipped?: string[] }[] };
    return {
      at: r.occurredAt.toISOString(),
      paused: m.paused ?? null,
      created: m.created ?? 0,
      approved: m.approved ?? 0,
      scheduled: m.scheduled ?? 0,
      notes: (m.creators ?? []).flatMap((c) => (c.skipped ?? []).map((s) => `${c.name}: ${s}`)).slice(0, 6),
    };
  });
  const modes = { MANUAL: 0, ASSISTED: 0, CONTROLLED_AUTONOMY: 0 };
  for (const c of creators.filter((c) => c.status === "ACTIVE" && !c.isDemo)) modes[c.autonomyMode]++;

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="flex flex-col gap-6 xl:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Autonomy limits</CardTitle>
            <CardDescription>
              Hard limits checked before every step. The effective limit is the strictest of the farm-wide, creator and campaign policy, so a scoped policy can only
              tighten. Tightening applies at once (admin); loosening needs the owner — an admin&apos;s change becomes a request under Approvals. Only people can change
              limits; the autopilot cannot.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PolicyEditor policies={policyRows} targets={targets.filter((t) => t.scope !== "PROVIDER")} canEdit={can(user.role, "autonomy:raise")} isOwner={can(user.role, "policies:manage")} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Budgets</CardTitle>
            <CardDescription>
              Spending caps per day or month. At the warning threshold the farm notifies you; at the limit the matching scope pauses itself (farm-wide budget: all
              generation). Lowering: admin. Raising or removing: owner (admins send a request).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BudgetEditor budgets={budgetRows} targets={targets} canEdit={can(user.role, "budgets:lower")} isOwner={can(user.role, "budgets:raise")} />
          </CardContent>
        </Card>
      </div>
      <AutopilotCard
        runs={runRows}
        modes={modes}
        pendingApprovals={pending}
        defaultQuota={DEFAULT_NEW_ITEMS_PER_DAY}
        canRun={can(user.role, "generation:run")}
      />
    </div>
  );
}
