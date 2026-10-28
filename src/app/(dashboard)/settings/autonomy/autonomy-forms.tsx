"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionResult } from "@/server/actions";
import { changeBudgetAction, changePolicyAction, runAutopilotAction } from "../actions";

type Scope = "GLOBAL" | "CREATOR" | "CAMPAIGN" | "PROVIDER";

export interface ScopeTarget {
  scope: Exclude<Scope, "GLOBAL">;
  id: string;
  label: string;
}

export interface PolicyValues {
  maxCostPerJobEur: string | null;
  maxGenerationsPerItem: number | null;
  maxConcurrentJobs: number | null;
  maxPostsPerDay: number | null;
  maxWorkflowMinutes: number | null;
  maxRetries: number | null;
  maxNewItemsPerDay: number | null;
  autoApproveMinScore: number | null;
  requireHumanApproval: boolean;
}

export interface PolicyRow {
  scope: "GLOBAL" | "CREATOR" | "CAMPAIGN";
  targetId: string | null;
  values: PolicyValues;
}

export interface BudgetRow {
  scope: Scope;
  targetId: string | null;
  targetLabel: string;
  period: "DAY" | "MONTH";
  limitEur: string;
  limitText: string;
  autoPause: boolean;
  warnAtPercent: number;
}

export interface RunSummary {
  at: string;
  paused: string | null;
  created: number;
  approved: number;
  scheduled: number;
  notes: string[];
}

const FIELDS: { key: Exclude<keyof PolicyValues, "requireHumanApproval">; label: string; hint: string }[] = [
  { key: "maxCostPerJobEur", label: "Max cost per job (EUR)", hint: "A step estimated above this is refused" },
  { key: "maxGenerationsPerItem", label: "Generations per item", hint: "Takes, regenerations and retries together" },
  { key: "maxConcurrentJobs", label: "Concurrent jobs", hint: "Further steps wait their turn" },
  { key: "maxPostsPerDay", label: "Posts per account per day", hint: "Also capped per account" },
  { key: "maxWorkflowMinutes", label: "Workflow duration (minutes)", hint: "Production stops when it runs longer" },
  { key: "maxRetries", label: "Retries per step", hint: "0–10" },
  { key: "maxNewItemsPerDay", label: "Autopilot: new items per creator per day", hint: "Empty or 0: the autopilot starts nothing" },
  { key: "autoApproveMinScore", label: "Autopilot: self-approve from QC score", hint: "Empty: never. Scoped: only raises the bar" },
];

const EMPTY: PolicyValues = {
  maxCostPerJobEur: null,
  maxGenerationsPerItem: null,
  maxConcurrentJobs: null,
  maxPostsPerDay: null,
  maxWorkflowMinutes: null,
  maxRetries: null,
  maxNewItemsPerDay: null,
  autoApproveMinScore: null,
  requireHumanApproval: false,
};

type Draft = Record<Exclude<keyof PolicyValues, "requireHumanApproval">, string> & { requireHumanApproval: boolean };

const toDraft = (v: PolicyValues): Draft => ({
  ...(Object.fromEntries(FIELDS.map((f) => [f.key, v[f.key] === null ? "" : String(v[f.key])])) as Record<Exclude<keyof PolicyValues, "requireHumanApproval">, string>),
  requireHumanApproval: v.requireHumanApproval,
});

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(fn: () => Promise<ActionResult<T>>, onOk: (data: T | undefined) => string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      toast.success(onOk(res.data));
      router.refresh();
    });
  return { pending, run };
}

const appliedText = (r: { applied: boolean } | undefined, done: string) => (r?.applied === false ? "This loosens a limit: request sent to the owner (Approvals)" : done);

export function PolicyEditor({ policies, targets, canEdit, isOwner }: { policies: PolicyRow[]; targets: ScopeTarget[]; canEdit: boolean; isOwner: boolean }) {
  const [selected, setSelected] = useState("GLOBAL:");
  const [scope, targetId] = selected.split(":") as ["GLOBAL" | "CREATOR" | "CAMPAIGN", string];
  const current = useMemo(() => policies.find((p) => p.scope === scope && (p.targetId ?? "") === targetId), [policies, scope, targetId]);
  const [draft, setDraft] = useState<Draft>(toDraft(current?.values ?? EMPTY));
  const [reason, setReason] = useState("");
  const { pending, run } = useRun();
  const names = new Map(targets.map((t) => [t.id, t.label]));

  function select(value: string) {
    setSelected(value);
    const [s, t] = value.split(":");
    setDraft(toDraft(policies.find((p) => p.scope === s && (p.targetId ?? "") === t)?.values ?? EMPTY));
  }

  function save() {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const values = {
      maxCostPerJobEur: draft.maxCostPerJobEur.trim() === "" ? null : draft.maxCostPerJobEur.trim(),
      maxGenerationsPerItem: num(draft.maxGenerationsPerItem),
      maxConcurrentJobs: num(draft.maxConcurrentJobs),
      maxPostsPerDay: num(draft.maxPostsPerDay),
      maxWorkflowMinutes: num(draft.maxWorkflowMinutes),
      maxRetries: num(draft.maxRetries),
      maxNewItemsPerDay: num(draft.maxNewItemsPerDay),
      autoApproveMinScore: num(draft.autoApproveMinScore),
      requireHumanApproval: draft.requireHumanApproval,
    };
    run(() => changePolicyAction({ scope, targetId: scope === "GLOBAL" ? null : targetId, values, reason }), (r) => appliedText(r, "Limits saved"));
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Policy" htmlFor="policy-scope" className="min-w-64">
          <NativeSelect id="policy-scope" value={selected} onChange={(e) => select(e.target.value)}>
            <option value="GLOBAL:">Farm-wide</option>
            {(["CREATOR", "CAMPAIGN"] as const).map((s) => (
              <optgroup key={s} label={s === "CREATOR" ? "Creator" : "Campaign"}>
                {targets
                  .filter((t) => t.scope === s)
                  .map((t) => (
                    <option key={t.id} value={`${s}:${t.id}`}>
                      {t.label}
                      {policies.some((p) => p.targetId === t.id) ? " (own policy)" : ""}
                    </option>
                  ))}
              </optgroup>
            ))}
          </NativeSelect>
        </Field>
        <p className="pb-2 text-xs text-muted-foreground">
          {scope === "GLOBAL" ? "Applies to everything." : current ? `Own policy for ${names.get(targetId)}.` : `No own policy for ${names.get(targetId)} yet; the farm-wide limits apply.`}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`pol-${f.key}`} hint={f.hint}>
            <Input
              id={`pol-${f.key}`}
              inputMode={f.key === "maxCostPerJobEur" ? "decimal" : "numeric"}
              placeholder="no limit"
              value={draft[f.key]}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.requireHumanApproval} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, requireHumanApproval: e.target.checked }))} />
        A person must approve all content (the autopilot never approves)
      </label>
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Reason (shown to the owner)" htmlFor="policy-reason" className="min-w-64 flex-1">
            <Input id="policy-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change?" />
          </Field>
          <Button disabled={pending} onClick={save}>
            {isOwner ? "Save limits" : "Save or request"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only admins and the owner change limits.</p>
      )}
    </div>
  );
}

export function BudgetEditor({ budgets, targets, canEdit, isOwner }: { budgets: BudgetRow[]; targets: ScopeTarget[]; canEdit: boolean; isOwner: boolean }) {
  const [target, setTarget] = useState("GLOBAL:");
  const [period, setPeriod] = useState<"DAY" | "MONTH">("MONTH");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const { pending, run } = useRun();
  const [scope, targetId] = target.split(":") as [Scope, string];
  const current = budgets.find((b) => b.scope === scope && (b.targetId ?? "") === targetId && b.period === period);

  return (
    <div className="grid gap-4">
      {budgets.length ? (
        <ul className="divide-y rounded-lg border text-sm">
          {budgets.map((b) => (
            <li key={`${b.scope}:${b.targetId}:${b.period}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                {b.targetLabel} <span className="text-muted-foreground">· {b.scope.toLowerCase()} · {b.period === "DAY" ? "daily" : "monthly"}</span>
              </span>
              <span className="tabular-nums">
                {b.limitText} <span className="text-xs text-muted-foreground">(warn {b.warnAtPercent}%{b.autoPause ? ", pauses at limit" : ""})</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No budgets yet.</p>
      )}
      {canEdit ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Scope" htmlFor="budget-target">
            <NativeSelect
              id="budget-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setAmount("");
              }}
            >
              <option value="GLOBAL:">Farm-wide</option>
              {(["CREATOR", "CAMPAIGN", "PROVIDER"] as const).map((s) => (
                <optgroup key={s} label={s.charAt(0) + s.slice(1).toLowerCase()}>
                  {targets
                    .filter((t) => t.scope === s)
                    .map((t) => (
                      <option key={t.id} value={`${s}:${t.id}`}>
                        {t.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Period" htmlFor="budget-period">
            <NativeSelect id="budget-period" value={period} onChange={(e) => setPeriod(e.target.value as "DAY" | "MONTH")}>
              <option value="MONTH">Month</option>
              <option value="DAY">Day</option>
            </NativeSelect>
          </Field>
          <Field label="Limit (EUR)" htmlFor="budget-amount" hint={current ? `Now ${current.limitText}. Empty removes the cap.` : "No cap yet for this scope and period."}>
            <Input id="budget-amount" inputMode="decimal" value={amount} placeholder={current?.limitEur ?? "no cap"} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Reason" htmlFor="budget-reason">
            <Input id="budget-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change?" />
          </Field>
          <div className="sm:col-span-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => changeBudgetAction({ scope, targetId: scope === "GLOBAL" ? null : targetId, period, limitEur: amount.trim() === "" ? null : amount.trim(), reason }),
                  (r) => appliedText(r, "Budget saved"),
                )
              }
            >
              {isOwner ? "Save budget" : "Save or request"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AutopilotCard({
  runs,
  modes,
  pendingApprovals,
  defaultQuota,
  canRun,
}: {
  runs: RunSummary[];
  modes: Record<"MANUAL" | "ASSISTED" | "CONTROLLED_AUTONOMY", number>;
  pendingApprovals: number;
  defaultQuota: number;
  canRun: boolean;
}) {
  const { pending, run } = useRun();
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" /> Autopilot
        </CardTitle>
        <CardDescription>
          Plans every 30 minutes within these limits. Assisted creators get new ideas produced up to review; controlled-autonomy creators also get their own items
          approved (only if QC passed above the farm-wide bar) and scheduled into free slots. {defaultQuota === 0 ? "It starts nothing until a daily quota is set." : `Without a quota it starts ${defaultQuota} item(s) per creator per day.`} It
          cannot change limits, budgets, pauses or account links.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Manual</dt>
          <dd className="text-right tabular-nums">{modes.MANUAL}</dd>
          <dt className="text-muted-foreground">Assisted</dt>
          <dd className="text-right tabular-nums">{modes.ASSISTED}</dd>
          <dt className="text-muted-foreground">Controlled autonomy</dt>
          <dd className="text-right tabular-nums">{modes.CONTROLLED_AUTONOMY}</dd>
        </dl>
        {pendingApprovals > 0 ? (
          <Link href="/settings/approvals" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            {pendingApprovals} request(s) wait for the owner →
          </Link>
        ) : null}
        <div>
          <p className="mb-1 font-medium">Recent runs</p>
          {runs.length === 0 ? <p className="text-xs text-muted-foreground">No runs yet.</p> : null}
          <ul className="grid gap-2">
            {runs.map((r) => (
              <li key={r.at} className="rounded-md border px-3 py-2 text-xs">
                <p className="font-medium">{new Date(r.at).toLocaleString("nl-NL")}</p>
                <p className="text-muted-foreground">
                  {r.paused ? `Skipped: generation paused (${r.paused})` : `${r.created} started · ${r.approved} approved · ${r.scheduled} scheduled`}
                </p>
                {r.notes.map((n) => (
                  <p key={n} className="text-muted-foreground">
                    – {n}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
        {canRun ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(
                () => runAutopilotAction({}),
                (r) => (r?.paused ? `Not run: generation is paused (${r.paused})` : `Autopilot: ${r?.created ?? 0} started, ${r?.approved ?? 0} approved, ${r?.scheduled ?? 0} scheduled`),
              )
            }
          >
            Run planning now
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
