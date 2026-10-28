"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { AUTONOMY_MODES } from "@/lib/schemas/creator";
import { humanize } from "@/lib/utils";
import { setAutonomyAction, setCreatorBudgetAction } from "@/app/(dashboard)/creators/actions";

export interface BudgetAutonomyProps {
  creatorId: string;
  autonomyMode: (typeof AUTONOMY_MODES)[number];
  /** Current limits as EUR decimal strings, null when not set. */
  budgets: { MONTH: string | null; DAY: string | null };
  perms: { edit: boolean; raiseAutonomy: boolean; lowerBudget: boolean; raiseBudget: boolean };
  disabled: boolean;
}

export function BudgetAutonomyCard({ creatorId, autonomyMode, budgets, perms, disabled }: BudgetAutonomyProps) {
  const [pending, start] = useTransition();
  const [amounts, setAmounts] = useState({ MONTH: budgets.MONTH ?? "", DAY: budgets.DAY ?? "" });

  function saveBudget(period: "MONTH" | "DAY") {
    const value = amounts[period].trim();
    start(async () => {
      const res = await setCreatorBudgetAction({ creatorId, period, amountEur: value === "" ? null : value });
      if (res.ok) toast.success(value === "" ? "Budget removed" : "Budget saved");
      else toast.error(res.error);
    });
  }

  function saveMode(mode: string) {
    start(async () => {
      const res = await setAutonomyAction({ creatorId, mode });
      if (res.ok) toast.success("Autonomy mode updated");
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget & autonomy</CardTitle>
        <CardDescription>
          Hard limits enforced server-side on top of the farm-wide budget. Adding or lowering a limit: admin. Raising or removing one: owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {(["MONTH", "DAY"] as const).map((period) => (
          <Field key={period} label={period === "MONTH" ? "Monthly limit (EUR)" : "Daily limit (EUR)"} htmlFor={`budget-${period}`} hint={budgets[period] === null ? "No creator-specific limit" : undefined}>
            <div className="flex gap-2">
              <Input
                id={`budget-${period}`}
                inputMode="decimal"
                placeholder="none"
                value={amounts[period]}
                disabled={disabled || !perms.lowerBudget}
                onChange={(e) => setAmounts((a) => ({ ...a, [period]: e.target.value }))}
              />
              <Button variant="outline" aria-label={period === "MONTH" ? "Save monthly limit" : "Save daily limit"} disabled={disabled || pending || !perms.lowerBudget || amounts[period] === (budgets[period] ?? "")} onClick={() => saveBudget(period)}>
                Save
              </Button>
            </div>
          </Field>
        ))}
        <Field label="Autonomy mode" htmlFor="autonomy" hint="Manual: every step needs a human. Assisted: generation runs, publishing needs approval. Controlled autonomy: everything within policy.">
          <NativeSelect id="autonomy" value={autonomyMode} disabled={disabled || pending || !perms.edit} onChange={(e) => saveMode(e.target.value)}>
            {AUTONOMY_MODES.map((m) => (
              <option key={m} value={m}>
                {humanize(m)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </CardContent>
    </Card>
  );
}
