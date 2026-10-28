"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarClock, CheckCheck, RotateCcw, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionResult } from "@/server/actions";
import { cancelPublicationAction, markPublishedAction, publishNowAction, rescheduleAction, retryPublicationAction, scheduleAction } from "@/app/(dashboard)/calendar/actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, success: string, done?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      toast.success(success);
      done?.();
      router.refresh();
    });
  return { pending, run };
}

/** Local "YYYY-MM-DDTHH:MM" for a datetime-local input, an hour from now in the zone. */
function defaultLocal(timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(Date.now() + 3_600_000))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

export interface AccountOption {
  id: string;
  handle: string;
  status: string;
  isMock: boolean;
}

export function ScheduleForm({ itemId, accounts, timeZone }: { itemId: string; accounts: AccountOption[]; timeZone: string }) {
  const usable = accounts.filter((a) => a.status === "CONNECTED" || a.status === "INSUFFICIENT_SCOPE");
  const [accountId, setAccountId] = useState(usable[0]?.id ?? "");
  const [when, setWhen] = useState(() => defaultLocal(timeZone));
  const { pending, run } = useRun();
  if (usable.length === 0) return <p className="text-sm text-muted-foreground">No connected account for this creator. Connect one under Social Accounts.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
      <Field label="Account" htmlFor="pub-account">
        <NativeSelect id="pub-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.handle}
              {a.isMock ? " (mock)" : ""}
              {a.status === "INSUFFICIENT_SCOPE" ? " — needs manual publishing" : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={`When (${timeZone})`} htmlFor="pub-when">
        <Input id="pub-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
      <Button disabled={pending || !accountId || !when} onClick={() => run(() => scheduleAction({ contentItemId: itemId, socialAccountId: accountId, at: { when, timeZone } }), "Publication scheduled")}>
        <CalendarClock /> Schedule
      </Button>
      <Button variant="outline" disabled={pending || !accountId} onClick={() => run(() => publishNowAction({ contentItemId: itemId, socialAccountId: accountId }), "Publishing now")}>
        <Send /> Publish now
      </Button>
    </div>
  );
}

export function JobActions({ jobId, status, timeZone, label }: { jobId: string; status: string; timeZone: string; label: string }) {
  const { pending, run } = useRun();
  const [moveOpen, setMoveOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [when, setWhen] = useState(() => defaultLocal(timeZone));
  const [url, setUrl] = useState("");
  return (
    <div className="flex flex-wrap gap-1">
      {status === "SCHEDULED" ? (
        <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="ghost" aria-label={`Reschedule ${label}`}>
              <CalendarClock /> Move
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reschedule</DialogTitle>
              <DialogDescription>{label}</DialogDescription>
            </DialogHeader>
            <Field label={`New time (${timeZone})`} htmlFor={`move-${jobId}`}>
              <Input id={`move-${jobId}`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
            <Button disabled={pending} onClick={() => run(() => rescheduleAction({ jobId, at: { when, timeZone } }), "Rescheduled", () => setMoveOpen(false))}>
              Save
            </Button>
          </DialogContent>
        </Dialog>
      ) : null}
      {status === "FAILED" || status === "NEEDS_MANUAL_ACTION" ? (
        <Button size="sm" variant="ghost" disabled={pending} aria-label={`Retry ${label}`} onClick={() => run(() => retryPublicationAction({ jobId }), "Publishing again")}>
          <RotateCcw /> Retry
        </Button>
      ) : null}
      {status === "NEEDS_MANUAL_ACTION" ? (
        <Dialog open={manualOpen} onOpenChange={setManualOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="ghost" aria-label={`Mark ${label} as published`}>
              <CheckCheck /> Mark as published
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Published by hand</DialogTitle>
              <DialogDescription>Paste the link of the post you published with the export package.</DialogDescription>
            </DialogHeader>
            <Field label="Post link" htmlFor={`url-${jobId}`}>
              <Input id={`url-${jobId}`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.instagram.com/p/…" />
            </Field>
            <Button disabled={pending || !url} onClick={() => run(() => markPublishedAction({ jobId, url }), "Marked as published", () => setManualOpen(false))}>
              <Send /> Save
            </Button>
          </DialogContent>
        </Dialog>
      ) : null}
      {["SCHEDULED", "QUEUED", "FAILED", "NEEDS_MANUAL_ACTION"].includes(status) ? (
        <Button size="sm" variant="ghost" disabled={pending} aria-label={`Cancel ${label}`} onClick={() => run(() => cancelPublicationAction({ jobId }), "Publication cancelled")}>
          <X /> Cancel
        </Button>
      ) : null}
    </div>
  );
}
