"use client";

import { useState, useTransition } from "react";
import { OctagonPause, Play } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { humanize } from "@/lib/utils";
import { pauseAction, resumeAction } from "./actions";

type Scope = "ALL_GENERATION" | "ALL_PUBLISHING" | "CREATOR" | "CAMPAIGN" | "PROVIDER";

export interface SwitchRow {
  scope: Scope;
  targetId: string | null;
  targetLabel: string;
  paused: boolean;
  reason: string | null;
}

export interface TargetOption {
  scope: "CREATOR" | "CAMPAIGN" | "PROVIDER";
  id: string;
  label: string;
}

export function ControlPanel({ rows, targets, canPause, canResume }: { rows: SwitchRow[]; targets: TargetOption[]; canPause: boolean; canResume: boolean }) {
  const [pending, start] = useTransition();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");

  function run(paused: boolean, scope: Scope, targetId: string | null, key: string) {
    start(async () => {
      const action = paused ? pauseAction : resumeAction;
      const res = await action({ scope, targetId, reason: reasons[key] ?? (paused ? "" : "Resumed by operator") });
      if (res.ok) {
        toast.success(paused ? "Paused" : "Resumed");
        setReasons((r) => ({ ...r, [key]: "" }));
      } else toast.error(res.error);
    });
  }

  const [scopedScope, scopedId] = target.split(":") as ["CREATOR" | "CAMPAIGN" | "PROVIDER" | undefined, string | undefined];

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y rounded-xl border bg-card">
        {rows.map((row) => {
          const key = `${row.scope}:${row.targetId ?? ""}`;
          return (
            <li key={key} className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {row.targetLabel} <StatusBadge status={row.paused ? "PAUSED" : "ACTIVE"} />
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.paused ? `Reason: ${row.reason}` : `${humanize(row.scope)} is running normally.`}
                </p>
              </div>
              {row.paused ? (
                <Button variant="outline" size="sm" disabled={!canResume || pending} onClick={() => run(false, row.scope, row.targetId, key)}>
                  <Play /> Resume
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Input
                    placeholder="Reason for pausing"
                    aria-label={`Reason for pausing ${row.targetLabel}`}
                    value={reasons[key] ?? ""}
                    onChange={(e) => setReasons((r) => ({ ...r, [key]: e.target.value }))}
                    className="w-56"
                    disabled={!canPause}
                  />
                  <Button variant="destructive" size="sm" className="h-9" disabled={!canPause || pending} onClick={() => run(true, row.scope, row.targetId, key)}>
                    <OctagonPause /> Pause
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canPause && targets.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 md:flex-row md:items-center">
          <p className="text-sm font-medium md:w-48">Pause a single target</p>
          <NativeSelect aria-label="Target to pause" value={target} onChange={(e) => setTarget(e.target.value)} className="md:w-64">
            <option value="">Choose creator, campaign or provider…</option>
            {(["CREATOR", "CAMPAIGN", "PROVIDER"] as const).map((scope) => (
              <optgroup key={scope} label={humanize(scope)}>
                {targets
                  .filter((t) => t.scope === scope)
                  .map((t) => (
                    <option key={t.id} value={`${scope}:${t.id}`}>
                      {t.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </NativeSelect>
          <Input
            placeholder="Reason"
            aria-label="Reason for pausing target"
            value={reasons.scoped ?? ""}
            onChange={(e) => setReasons((r) => ({ ...r, scoped: e.target.value }))}
            className="md:w-56"
          />
          <Button
            variant="destructive"
            size="sm"
            className="h-9"
            disabled={!scopedScope || !scopedId || pending}
            onClick={() => scopedScope && scopedId && run(true, scopedScope, scopedId, "scoped")}
          >
            <OctagonPause /> Pause target
          </Button>
        </div>
      ) : null}
    </div>
  );
}
