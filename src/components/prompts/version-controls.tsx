"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, FilePlus2, Pin, Send, Ban } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  archiveTemplateAction,
  createPromptDraftAction,
  deprecatePromptAction,
  pinPromptAction,
  publishPromptAction,
} from "@/app/(dashboard)/prompts/actions";

type Result = { ok: boolean; error?: string };

function useRun() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>, success: string, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(success);
        after?.();
      } else toast.error(res.error ?? "Failed");
    });
  return { pending, run };
}

export function NewPromptDraftButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await createPromptDraftAction({ templateId });
          if (!res.ok) return void toast.error(res.error);
          router.push(`/prompts/${templateId}?v=${res.data!.version}`);
        })
      }
    >
      <FilePlus2 /> New draft version
    </Button>
  );
}

export function PublishDialog({ versionId, version, needsAdmin }: { versionId: string; version: number; needsAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [changelog, setChangelog] = useState("");
  const { pending, run } = useRun();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Send /> Publish v{version}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish version {version}</DialogTitle>
          <DialogDescription>
            Published versions are immutable. New content uses the latest published version; campaigns that pinned an older version keep it.
            {needsAdmin ? " Global and rule templates need an admin to publish." : ""}
          </DialogDescription>
        </DialogHeader>
        <Input aria-label="Changelog" placeholder="What changed and why" value={changelog} onChange={(e) => setChangelog(e.target.value)} maxLength={500} />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={pending} onClick={() => run(() => publishPromptAction({ versionId, changelog }), `Version ${version} published`, () => setOpen(false))}>
            Publish
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DeprecateButton({ versionId }: { versionId: string }) {
  const { pending, run } = useRun();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => deprecatePromptAction({ versionId }), "Version deprecated")}>
      <Ban /> Deprecate
    </Button>
  );
}

export function PinControl({ templateId, versionId, campaigns }: { templateId: string; versionId: string; campaigns: { id: string; name: string; pinnedVersion: number | null }[] }) {
  const [campaignId, setCampaignId] = useState("");
  const { pending, run } = useRun();
  if (campaigns.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect aria-label="Campaign to pin" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className="w-64">
        <option value="">Pin to campaign…</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.pinnedVersion ? ` (pinned v${c.pinnedVersion})` : ""}
          </option>
        ))}
      </NativeSelect>
      <Button size="sm" variant="outline" disabled={!campaignId || pending} onClick={() => run(() => pinPromptAction({ campaignId, templateId, versionId }), "Pinned to campaign")}>
        <Pin /> Pin this version
      </Button>
    </div>
  );
}

export function UnpinButton({ templateId, campaignId }: { templateId: string; campaignId: string }) {
  const { pending, run } = useRun();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => pinPromptAction({ campaignId, templateId, versionId: null }), "Pin removed")}>
      Unpin
    </Button>
  );
}

export function ArchiveTemplateButton({ templateId, archived }: { templateId: string; archived: boolean }) {
  const { pending, run } = useRun();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => archiveTemplateAction({ templateId, archived: !archived }), archived ? "Template restored" : "Template archived")}>
      {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Restore" : "Archive"}
    </Button>
  );
}
