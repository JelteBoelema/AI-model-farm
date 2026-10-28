"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decideApprovalAction } from "../actions";

export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");

  function decide(approve: boolean) {
    start(async () => {
      const res = await decideApprovalAction({ approvalId, approve, reason });
      if (!res.ok) return void toast.error(res.error);
      toast.success(approve ? "Approved and applied" : "Rejected");
      router.refresh();
    });
  }

  return (
    <div className="flex gap-2">
      <Input aria-label="Reason for the decision" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-48" />
      <Button size="sm" className="h-9" disabled={pending} onClick={() => decide(true)}>
        <Check /> Approve
      </Button>
      <Button size="sm" variant="outline" className="h-9" disabled={pending} onClick={() => decide(false)}>
        <X /> Reject
      </Button>
    </div>
  );
}
