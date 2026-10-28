"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { collectNowAction, decideExperimentAction } from "./actions";

export function CollectNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await collectNowAction({});
          if (!res.ok) return void toast.error(res.error);
          const d = res.data!;
          toast.success(`Collected ${d.posts} snapshot(s) from ${d.accounts} account(s)${d.problems.length ? `; ${d.problems.join("; ")}` : ""}`);
          router.refresh();
        })
      }
    >
      <RefreshCw /> Collect statistics now
    </Button>
  );
}

export function ExperimentDecision({ insightId, canAccept }: { insightId: string; canAccept: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const decide = (accept: boolean) =>
    start(async () => {
      const res = await decideExperimentAction({ insightId, accept, reason });
      if (!res.ok) return void toast.error(res.error);
      toast.success(accept ? "Experiment accepted: the autopilot alternates the variants" : "Experiment dismissed");
      router.refresh();
    });
  return (
    <div className="flex gap-2">
      <Input aria-label="Reason" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-40" />
      {canAccept ? (
        <Button size="sm" className="h-9" disabled={pending} onClick={() => decide(true)}>
          <Check /> Accept
        </Button>
      ) : null}
      <Button size="sm" variant="outline" className="h-9" disabled={pending} onClick={() => decide(false)}>
        <X /> Dismiss
      </Button>
    </div>
  );
}
