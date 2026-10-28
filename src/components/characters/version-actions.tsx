"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BadgeCheck, FilePlus2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { approveVersionAction, createDraftAction } from "@/app/(dashboard)/characters/actions";

export function NewDraftButton({ creatorId }: { creatorId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await createDraftAction({ creatorId });
          if (!res.ok) return void toast.error(res.error);
          toast.success(`Draft version ${res.data!.version} created`);
          router.push(`/characters/${creatorId}?v=${res.data!.version}`);
        })
      }
    >
      <FilePlus2 /> New draft version
    </Button>
  );
}

export function ApproveVersionDialog({ profileId, version }: { profileId: string; version: number }) {
  const [open, setOpen] = useState(false);
  const [attestation, setAttestation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function approve() {
    setError(null);
    start(async () => {
      const res = await approveVersionAction({ profileId, attestation });
      if (res.ok) {
        toast.success(`Version ${version} approved`);
        setOpen(false);
      } else setError(res.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <BadgeCheck /> Approve version {version}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve version {version}</DialogTitle>
          <DialogDescription>
            The approved version becomes the identity every generation uses and can no longer be edited. The previous approved version is superseded.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="attestation" className="text-sm font-medium">
          Likeness attestation
        </label>
        <Textarea
          id="attestation"
          value={attestation}
          onChange={(e) => setAttestation(e.target.value)}
          placeholder="E.g. Synthetic identity designed for this creator; references were generated, not photographs of a real person."
          className="min-h-24"
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={approve}>
            Approve
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
