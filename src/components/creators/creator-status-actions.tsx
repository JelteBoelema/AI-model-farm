"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, Copy, Pause, Play, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { changeCreatorStatusAction, duplicateCreatorAction } from "@/app/(dashboard)/creators/actions";

export interface StatusPermissions {
  edit: boolean;
  pause: boolean;
  resume: boolean;
}

export function CreatorStatusActions({ creatorId, status, perms }: { creatorId: string; status: string; perms: StatusPermissions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);

  function run(action: "activate" | "pause" | "resume" | "archive", done: string) {
    start(async () => {
      const res = await changeCreatorStatusAction({ creatorId, action, reason: reason || undefined });
      if (res.ok) {
        toast.success(done);
        setArchiveOpen(false);
      } else toast.error(res.error);
    });
  }

  function duplicate() {
    start(async () => {
      const res = await duplicateCreatorAction({ creatorId });
      if (res.ok) {
        toast.success("Duplicated as a new draft");
        router.push(`/creators/${res.data!.id}`);
      } else toast.error(res.error);
    });
  }

  if (status === "ARCHIVED") return perms.edit ? <Button variant="outline" size="sm" disabled={pending} onClick={duplicate}><Copy /> Duplicate</Button> : null;

  return (
    <div className="flex flex-wrap gap-2">
      {status === "DRAFT" && perms.edit ? (
        <Button size="sm" disabled={pending} onClick={() => run("activate", "Creator activated")}>
          <Rocket /> Activate
        </Button>
      ) : null}
      {status === "ACTIVE" && perms.pause ? (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => run("pause", "Creator paused")}>
          <Pause /> Pause
        </Button>
      ) : null}
      {status === "PAUSED" && perms.resume ? (
        <Button size="sm" disabled={pending} onClick={() => run("resume", "Creator resumed")}>
          <Play /> Resume
        </Button>
      ) : null}
      {perms.edit ? (
        <Button variant="outline" size="sm" disabled={pending} onClick={duplicate}>
          <Copy /> Duplicate
        </Button>
      ) : null}
      {perms.edit ? (
        <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              <Archive /> Archive
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Archive creator?</DialogTitle>
              <DialogDescription>
                Archived creators stop all generation and cannot be edited or reactivated. History, media and costs are kept. This is refused while publications are still scheduled.
              </DialogDescription>
            </DialogHeader>
            <Input aria-label="Reason for archiving" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => run("archive", "Creator archived")}>
                Archive creator
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
