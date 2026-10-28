"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Link2, RefreshCw, Unlink, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionResult } from "@/server/actions";
import { decideConnectionAction, disconnectAction, startConnectAction, updateLimitsAction, verifyAccountAction } from "@/app/(dashboard)/social/actions";

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

export function ConnectDialog({ creators, mockMode }: { creators: { id: string; name: string }[]; mockMode: boolean }) {
  const [open, setOpen] = useState(false);
  const [creatorId, setCreatorId] = useState(creators[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = () =>
    start(async () => {
      setError(null);
      const res = await startConnectAction({ creatorId, platform: "INSTAGRAM" });
      if (!res.ok) return setError(res.error);
      window.location.assign(res.data!.url);
    });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Link2 /> Connect Instagram
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect an Instagram account</DialogTitle>
          <DialogDescription>
            {mockMode
              ? "Mock mode: you will see a stand-in consent screen and the account publishes to a mock feed only."
              : "You will be sent to Instagram to sign in to the creator's professional account and grant access."}{" "}
            A link made by an admin waits for the owner&apos;s approval.
          </DialogDescription>
        </DialogHeader>
        <Field label="Creator" htmlFor="connect-creator">
          <NativeSelect id="connect-creator" value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
            {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button disabled={pending || !creatorId} onClick={go}>
          Continue
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function ApprovalButtons({ accountId, handle }: { accountId: string; handle: string }) {
  const { pending, run } = useRun();
  return (
    <div className="flex gap-1.5">
      <Button size="sm" disabled={pending} onClick={() => run(() => decideConnectionAction({ accountId, approve: true }), `@${handle} approved`)}>
        <Check /> Approve link
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => decideConnectionAction({ accountId, approve: false, reason: "Rejected by the owner" }), `@${handle} rejected`)}>
        <X /> Reject
      </Button>
    </div>
  );
}

export function AccountActions({ accountId, handle, connected, limits }: { accountId: string; handle: string; connected: boolean; limits: { maxPostsPerDay: number; minGapMinutes: number } }) {
  const { pending, run } = useRun();
  const [open, setOpen] = useState(false);
  const [l, setL] = useState(limits);
  return (
    <div className="flex flex-wrap gap-1.5">
      {connected ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => verifyAccountAction({ accountId }), `Permissions of @${handle} checked`)}>
          <RefreshCw /> Verify
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            Limits
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Posting limits for @{handle}</DialogTitle>
            <DialogDescription>Used for conflict detection in the calendar, in the creator&apos;s time zone. The farm-wide autonomy limit still applies.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Posts per day" htmlFor="lim-day">
              <Input id="lim-day" type="number" min={1} max={50} value={l.maxPostsPerDay} onChange={(e) => setL({ ...l, maxPostsPerDay: Number(e.target.value) })} />
            </Field>
            <Field label="Minutes between posts" htmlFor="lim-gap">
              <Input id="lim-gap" type="number" min={0} max={1440} value={l.minGapMinutes} onChange={(e) => setL({ ...l, minGapMinutes: Number(e.target.value) })} />
            </Field>
          </div>
          <Button disabled={pending} onClick={() => run(() => updateLimitsAction({ accountId, ...l }), "Limits saved", () => setOpen(false))}>
            Save limits
          </Button>
        </DialogContent>
      </Dialog>
      {connected ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => disconnectAction({ accountId }), `@${handle} disconnected`)}>
          <Unlink /> Disconnect
        </Button>
      ) : null}
    </div>
  );
}
