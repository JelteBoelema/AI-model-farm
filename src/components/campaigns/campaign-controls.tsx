"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pause, Pencil, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/actions";
import { campaignBudgetAction, campaignStatusAction, createCampaignAction, updateCampaignAction } from "@/app/(dashboard)/campaigns/actions";

export interface CampaignFormValues {
  name: string;
  objective: string;
  brief: string;
  startsAt: string; // YYYY-MM-DD or ""
  endsAt: string;
  creatorIds: string[];
}

const EMPTY: CampaignFormValues = { name: "", objective: "", brief: "", startsAt: "", endsAt: "", creatorIds: [] };

export function CampaignDialog({ creators, campaignId, initial }: { creators: { id: string; name: string }[]; campaignId?: string; initial?: CampaignFormValues }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<CampaignFormValues>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      setError(null);
      const campaign = { ...v, startsAt: v.startsAt || null, endsAt: v.endsAt || null };
      const res = campaignId ? await updateCampaignAction({ campaignId, campaign }) : await createCampaignAction(campaign);
      if (!res.ok) return setError(res.error);
      toast.success(campaignId ? "Campaign saved" : "Campaign created");
      setOpen(false);
      if (!campaignId && res.data) router.push(`/campaigns/${(res.data as { id: string }).id}`);
      else router.refresh();
    });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {campaignId ? (
          <Button size="sm" variant="outline">
            <Pencil /> Edit
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> New campaign
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{campaignId ? "Edit campaign" : "New campaign"}</DialogTitle>
          <DialogDescription>Content made for a campaign uses its brief and pinned prompts and counts against its budget.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="cmp-name">
            <Input id="cmp-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} />
          </Field>
          <Field label="Objective" htmlFor="cmp-objective">
            <Input id="cmp-objective" value={v.objective} onChange={(e) => setV({ ...v, objective: e.target.value })} maxLength={300} />
          </Field>
          <Field label="Brief" htmlFor="cmp-brief">
            <Textarea id="cmp-brief" rows={3} value={v.brief} onChange={(e) => setV({ ...v, brief: e.target.value })} maxLength={4000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts" htmlFor="cmp-start">
              <Input id="cmp-start" type="date" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />
            </Field>
            <Field label="Ends" htmlFor="cmp-end">
              <Input id="cmp-end" type="date" value={v.endsAt} onChange={(e) => setV({ ...v, endsAt: e.target.value })} />
            </Field>
          </div>
          <fieldset className="grid max-h-40 gap-1.5 overflow-y-auto rounded-md border p-2 text-sm">
            <legend className="px-1 text-xs text-muted-foreground">Creators</legend>
            {creators.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={v.creatorIds.includes(c.id)}
                  onChange={(e) => setV({ ...v, creatorIds: e.target.checked ? [...v.creatorIds, c.id] : v.creatorIds.filter((x) => x !== c.id) })}
                />
                {c.name}
              </label>
            ))}
          </fieldset>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button disabled={pending} onClick={submit}>
            {campaignId ? "Save" : "Create campaign"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      const filed = (res.data as { applied?: boolean } | undefined)?.applied === false;
      toast.success(filed ? "Raising a limit needs the owner: request sent for approval" : success);
      router.refresh();
    });
  return { pending, run };
}

export function CampaignStatusButtons({ campaignId, status, canPause, canResume, canEdit }: { campaignId: string; status: string; canPause: boolean; canResume: boolean; canEdit: boolean }) {
  const { pending, run } = useRun();
  const act = (action: "activate" | "pause" | "resume" | "complete" | "archive", label: string) => run(() => campaignStatusAction({ campaignId, action }), label);
  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && status === "DRAFT" ? (
        <Button size="sm" disabled={pending} onClick={() => act("activate", "Campaign activated")}>
          <Play /> Activate
        </Button>
      ) : null}
      {canPause && status === "ACTIVE" ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("pause", "Campaign paused: its generation and publishing stop")}>
          <Pause /> Pause
        </Button>
      ) : null}
      {canResume && status === "PAUSED" ? (
        <Button size="sm" disabled={pending} onClick={() => act("resume", "Campaign resumed")}>
          <Play /> Resume
        </Button>
      ) : null}
      {canEdit && (status === "ACTIVE" || status === "PAUSED") ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("complete", "Campaign completed")}>
          Complete
        </Button>
      ) : null}
      {canEdit && (status === "COMPLETED" || status === "DRAFT" || status === "PAUSED") ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("archive", "Campaign archived")}>
          Archive
        </Button>
      ) : null}
    </div>
  );
}

export function CampaignBudgetForm({ campaignId, current }: { campaignId: string; current: { MONTH: string; DAY: string } }) {
  const { pending, run } = useRun();
  const [period, setPeriod] = useState<"MONTH" | "DAY">("MONTH");
  const [amount, setAmount] = useState(current.MONTH);
  return (
    <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
      <Field label="Period" htmlFor="cb-period">
        <NativeSelect
          id="cb-period"
          value={period}
          onChange={(e) => {
            const p = e.target.value as "MONTH" | "DAY";
            setPeriod(p);
            setAmount(current[p]);
          }}
        >
          <option value="MONTH">Month</option>
          <option value="DAY">Day</option>
        </NativeSelect>
      </Field>
      <Field label="Limit (EUR)" htmlFor="cb-amount" hint="Empty removes the cap. Raising or removing needs the owner; admins send a request.">
        <Input id="cb-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="no cap" />
      </Field>
      <Button size="sm" disabled={pending} onClick={() => run(() => campaignBudgetAction({ campaignId, period, limitEur: amount.trim() === "" ? null : amount.trim() }), "Budget saved")}>
        Save budget
      </Button>
    </div>
  );
}
