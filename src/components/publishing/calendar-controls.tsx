"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { bulkScheduleAction } from "@/app/(dashboard)/calendar/actions";

export function TimeZoneSelect({ zones, value }: { zones: string[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  return (
    <NativeSelect
      aria-label="Time zone"
      value={value}
      disabled={pending}
      className="w-48"
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        next.set("tz", e.target.value);
        start(() => router.replace(`${pathname}?${next}`, { scroll: false }));
      }}
    >
      {zones.map((z) => <option key={z} value={z}>{z}</option>)}
    </NativeSelect>
  );
}

export interface PlanAccount {
  id: string;
  label: string;
  items: { id: string; title: string }[];
}

/** Picks approved items for an account and spreads them over the creator's next free slots. */
export function BulkPlanDialog({ accounts }: { accounts: PlanAccount[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const account = accounts.find((a) => a.id === accountId);
  const submit = () =>
    start(async () => {
      setError(null);
      const res = await bulkScheduleAction({ socialAccountId: accountId, contentItemIds: picked });
      if (!res.ok) return setError(res.error);
      const failed = res.data!.filter((r) => r.error);
      toast.success(`${res.data!.length - failed.length} scheduled${failed.length ? `, ${failed.length} skipped` : ""}`);
      if (failed.length) toast.message(failed.map((f) => f.error).join("; "));
      setOpen(false);
      setPicked([]);
      router.refresh();
    });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Layers /> Plan in bulk
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plan approved content</DialogTitle>
          <DialogDescription>Items go into the creator&apos;s next free publishing slots, respecting the account&apos;s daily limit and minimum gap.</DialogDescription>
        </DialogHeader>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connected accounts.</p>
        ) : (
          <>
            <Field label="Account" htmlFor="bulk-account">
              <NativeSelect
                id="bulk-account"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setPicked([]);
                }}
              >
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </NativeSelect>
            </Field>
            <fieldset className="grid max-h-64 gap-1.5 overflow-y-auto rounded-md border p-2 text-sm">
              <legend className="px-1 text-xs text-muted-foreground">Approved, not yet scheduled</legend>
              {account?.items.length ? (
                account.items.map((i) => (
                  <label key={i.id} className="flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(i.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i.id] : p.filter((x) => x !== i.id)))} />
                    {i.title}
                  </label>
                ))
              ) : (
                <p className="text-muted-foreground">Nothing approved for this creator.</p>
              )}
            </fieldset>
          </>
        )}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button disabled={pending || picked.length === 0} onClick={submit}>
          Schedule {picked.length || ""} item(s)
        </Button>
      </DialogContent>
    </Dialog>
  );
}
