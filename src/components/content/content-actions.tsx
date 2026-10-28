"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, Check, Play, RefreshCw, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/actions";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import {
  approveContentAction,
  approveMediaAction,
  archiveContentAction,
  produceBatchAction,
  regenerateShotAction,
  rejectContentAction,
  rejectMediaAction,
  resumeProductionAction,
  startProductionAction,
} from "@/app/(dashboard)/content/actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, success: string, onDone?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success);
      onDone?.();
      router.refresh();
    });
  return { pending, run };
}

/** Keeps a page live while production jobs are queued or running. */
export function LiveRefresh({ active }: { active: boolean }) {
  useAutoRefresh(active);
  return null;
}

function ReasonDialog({
  trigger,
  title,
  description,
  label,
  confirm,
  destructive,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  label: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: (reason: string, close: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label={label} htmlFor="reason">
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
        </Field>
        <Button variant={destructive ? "destructive" : "default"} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason, () => setOpen(false))}>
          {confirm}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export interface ItemActionsProps {
  itemId: string;
  status: string;
  failedStep: string | null;
  busy: boolean;
  producible: boolean;
  canRun: boolean;
  canApprove: boolean;
  canEdit: boolean;
}

const STARTABLE = ["IDEA", "BRIEFED", "SCRIPTED", "PROMPTED"];
const REJECTABLE = ["IDEA", "BRIEFED", "SCRIPTED", "QC_REVIEW", "READY"];
const ARCHIVABLE = ["IDEA", "BRIEFED", "SCRIPTED", "PROMPTED", "APPROVED", "PUBLISHED", "FAILED", "REJECTED"];

export function ItemActions(p: ItemActionsProps) {
  const { pending, run } = useRun();
  const disabled = pending || p.busy;
  return (
    <div className="flex flex-wrap gap-2">
      {p.canRun && p.producible && STARTABLE.includes(p.status) && !p.failedStep ? (
        <Button size="sm" disabled={disabled} onClick={() => run(() => startProductionAction({ itemId: p.itemId }), "Production started")}>
          <Play /> {p.status === "IDEA" ? "Start production" : "Continue production"}
        </Button>
      ) : null}
      {p.canRun && p.failedStep ? (
        <Button size="sm" disabled={disabled} onClick={() => run(() => resumeProductionAction({ itemId: p.itemId }), "Resumed")}>
          <RotateCcw /> Resume
        </Button>
      ) : null}
      {p.canApprove && p.status === "READY" ? (
        <Button size="sm" disabled={disabled} onClick={() => run(() => approveContentAction({ itemId: p.itemId }), "Content approved")}>
          <Check /> Approve content
        </Button>
      ) : null}
      {p.canApprove && p.status === "QC_REVIEW" && !p.busy ? (
        <ReasonDialog
          trigger={
            <Button size="sm" variant="outline" disabled={disabled}>
              <Check /> Approve despite QC
            </Button>
          }
          title="Approve despite quality control"
          description="Quality control did not pass. Your reason is stored with the approval."
          label="Why is this fine?"
          confirm="Approve"
          onConfirm={(reason, close) => run(() => approveContentAction({ itemId: p.itemId, overrideReason: reason }), "Content approved", close)}
        />
      ) : null}
      {p.canApprove && REJECTABLE.includes(p.status) && !p.busy ? (
        <ReasonDialog
          trigger={
            <Button size="sm" variant="outline" disabled={disabled}>
              <X /> Reject
            </Button>
          }
          title="Reject content item"
          description="The item stops here. Generated media stays in the library for reference."
          label="Reason"
          confirm="Reject"
          destructive
          onConfirm={(reason, close) => run(() => rejectContentAction({ itemId: p.itemId, reason }), "Content rejected", close)}
        />
      ) : null}
      {p.canEdit && ARCHIVABLE.includes(p.status) && !p.busy ? (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => run(() => archiveContentAction({ itemId: p.itemId }), "Archived")}>
          <Archive /> Archive
        </Button>
      ) : null}
    </div>
  );
}

export function RegenerateShotButton({ itemId, shot, disabled }: { itemId: string; shot: number; disabled: boolean }) {
  const { pending, run } = useRun();
  return (
    <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => run(() => regenerateShotAction({ itemId, shot }), `New take for shot ${shot + 1} queued`)}>
      <RefreshCw /> New take
    </Button>
  );
}

export function MediaReviewButtons({ assetId, status, label }: { assetId: string; status: string; label: string }) {
  const { pending, run } = useRun();
  return (
    <div className="flex flex-wrap gap-1.5">
      {status !== "APPROVED" ? (
        <Button size="sm" variant="outline" aria-label={`Approve ${label}`} disabled={pending} onClick={() => run(() => approveMediaAction({ assetId }), "Take approved")}>
          <Check /> Approve
        </Button>
      ) : null}
      {status !== "REJECTED" ? (
        <Button size="sm" variant="ghost" aria-label={`Reject ${label}`} disabled={pending} onClick={() => run(() => rejectMediaAction({ assetId, reason: "" }), "Take rejected")}>
          <X /> Reject
        </Button>
      ) : null}
    </div>
  );
}

export function ProduceBatchButton({ batchId }: { batchId: string }) {
  const { pending, run } = useRun();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(async () => {
          const res = await produceBatchAction({ batchId });
          if (res.ok) toast.message(`${res.data!.started} started, ${res.data!.skipped} skipped`);
          return res;
        }, "Batch production started")
      }
    >
      <Play /> Produce batch
    </Button>
  );
}
