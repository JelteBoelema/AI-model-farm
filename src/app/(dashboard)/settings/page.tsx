import type { Metadata } from "next";
import { can } from "@/lib/rbac";
import { formatMoney } from "@/lib/money";
import { humanize } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { ControlPanel, type SwitchRow, type TargetOption } from "./control-panel";

export const metadata: Metadata = { title: "Controls" };

export default async function ControlsPage() {
  const user = await requireUser();
  const [switches, creators, campaigns, providers, policies] = await Promise.all([
    db.controlSwitch.findMany(),
    db.creator.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.aiProvider.findMany({ select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    db.autonomyPolicy.findMany({ orderBy: { scope: "asc" } }),
  ]);

  const names = new Map<string, string>([
    ...creators.map((c) => [c.id, `Creator · ${c.name}`] as const),
    ...campaigns.map((c) => [c.id, `Campaign · ${c.name}`] as const),
    ...providers.map((p) => [p.id, `Provider · ${p.displayName}`] as const),
  ]);

  const globalRows: SwitchRow[] = (["ALL_GENERATION", "ALL_PUBLISHING"] as const).map((scope) => {
    const s = switches.find((x) => x.scope === scope);
    return {
      scope,
      targetId: null,
      targetLabel: scope === "ALL_GENERATION" ? "All generation" : "All publishing",
      paused: s?.paused ?? false,
      reason: s?.reason ?? null,
    };
  });
  const scopedRows: SwitchRow[] = switches
    .filter((s) => s.paused && s.targetId)
    .map((s) => ({ scope: s.scope, targetId: s.targetId, targetLabel: names.get(s.targetId!) ?? s.targetId!, paused: true, reason: s.reason }));

  const targets: TargetOption[] = [
    ...creators.map((c) => ({ scope: "CREATOR" as const, id: c.id, label: c.name })),
    ...campaigns.map((c) => ({ scope: "CAMPAIGN" as const, id: c.id, label: c.name })),
    ...providers.map((p) => ({ scope: "PROVIDER" as const, id: p.id, label: p.displayName })),
  ];

  const global = policies.find((p) => p.scope === "GLOBAL");

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <section className="flex flex-col gap-3 xl:col-span-2">
        <div>
          <h2 className="text-sm font-semibold">Kill switches</h2>
          <p className="text-xs text-muted-foreground">
            Pausing takes effect before the next job step. Operators can pause; resuming requires an admin. Every change is audited.
          </p>
        </div>
        <ControlPanel
          rows={[...globalRows, ...scopedRows]}
          targets={targets}
          canPause={can(user.role, "controls:pause")}
          canResume={can(user.role, "controls:resume")}
        />
      </section>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Autonomy limits</CardTitle>
          <CardDescription>Hard limits enforced server-side. Mode: controlled autonomy. Editing ships in phase 8 (owner only).</CardDescription>
        </CardHeader>
        <CardContent>
          {global ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {(
                [
                  ["Max cost per job", formatMoney(global.maxCostPerJobMicros)],
                  ["Generations per item", global.maxGenerationsPerItem],
                  ["Concurrent jobs", global.maxConcurrentJobs],
                  ["Posts per day", global.maxPostsPerDay],
                  ["Workflow duration", global.maxWorkflowMinutes ? `${global.maxWorkflowMinutes} min` : null],
                  ["Max retries", global.maxRetries],
                  ["Human approval", global.requireHumanApproval ? "Required" : "Not required"],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right tabular-nums">{v ?? "—"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No global autonomy policy. Run the seed to install safe defaults.</p>
          )}
          {policies.length > 1 ? (
            <p className="mt-3 text-xs text-muted-foreground">{policies.length - 1} scoped override(s): {policies.filter((p) => p.scope !== "GLOBAL").map((p) => humanize(p.scope)).join(", ")}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
