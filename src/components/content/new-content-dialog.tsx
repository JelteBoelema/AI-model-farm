"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Layers, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { FORMAT_SPECS } from "@/lib/content-pipeline";
import { createBatchAction, createContentAction } from "@/app/(dashboard)/content/actions";

export interface CreatorOption {
  id: string;
  name: string;
  campaigns: { id: string; name: string }[];
}

const FORMATS = [
  ...Object.entries(FORMAT_SPECS).map(([value, spec]) => ({ value, label: spec!.label, producible: true })),
  { value: "TALKING_HEAD", label: "Talking head (needs a lip-sync provider)", producible: false },
];

export function NewContentDialog({ creators, mode }: { creators: CreatorOption[]; mode: "single" | "batch" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creatorId, setCreatorId] = useState(creators[0]?.id ?? "");
  const [format, setFormat] = useState("IMAGE_POST");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const creator = creators.find((c) => c.id === creatorId);
  const spec = FORMAT_SPECS[format as keyof typeof FORMAT_SPECS];
  const producible = FORMATS.find((f) => f.value === format)?.producible ?? false;
  const batch = mode === "batch";

  function submit(form: FormData) {
    setError(null);
    const common = {
      creatorId,
      campaignId: form.get("campaignId") || null,
      format,
      shots: spec && spec.maxShots > 1 ? Number(form.get("shots")) : undefined,
      produce: producible && form.get("produce") === "on",
    };
    start(async () => {
      if (batch) {
        const ideas = String(form.get("ideas") ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const res = await createBatchAction({ ...common, name: String(form.get("name") ?? ""), ideas });
        if (!res.ok) return setError(res.error);
        toast.success(`Batch created with ${ideas.length} item(s)${common.produce ? "; production started" : ""}`);
        setOpen(false);
        router.push(`/content?batch=${res.data!.id}`);
      } else {
        const res = await createContentAction({ ...common, title: String(form.get("title") ?? ""), idea: String(form.get("idea") ?? "") });
        if (!res.ok) return setError(res.error);
        toast.success(common.produce ? "Production started" : "Content item created");
        setOpen(false);
        router.push(`/content/${res.data!.id}`);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {batch ? (
          <Button size="sm" variant="outline">
            <Layers /> New batch
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> New content
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{batch ? "New batch" : "New content item"}</DialogTitle>
          <DialogDescription>
            {batch ? "One item per idea, same creator and format." : "Production runs brief → shot list → caption → images → quality control, then waits for your approval."}
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Creator" htmlFor="nc-creator">
              <NativeSelect id="nc-creator" value={creatorId} onChange={(e) => setCreatorId(e.target.value)} required>
                {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Campaign" htmlFor="nc-campaign" hint="Optional">
              <NativeSelect id="nc-campaign" name="campaignId" key={creatorId} defaultValue="">
                <option value="">No campaign</option>
                {creator?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Format" htmlFor="nc-format">
              <NativeSelect id="nc-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </NativeSelect>
            </Field>
            {spec && spec.maxShots > 1 ? (
              <Field label={spec.kind === "video" ? "Scenes" : "Slides"} htmlFor="nc-shots">
                <Input id="nc-shots" key={format} name="shots" type="number" min={spec.minShots} max={spec.maxShots} defaultValue={spec.defaultShots} required />
              </Field>
            ) : null}
          </div>
          {batch ? (
            <>
              <Field label="Batch name" htmlFor="nc-name">
                <Input id="nc-name" name="name" required minLength={3} maxLength={80} placeholder="e.g. Week 44" />
              </Field>
              <Field label="Ideas" htmlFor="nc-ideas" hint="One per line, at most 20">
                <Textarea id="nc-ideas" name="ideas" rows={6} required />
              </Field>
            </>
          ) : (
            <>
              <Field label="Title" htmlFor="nc-title">
                <Input id="nc-title" name="title" required minLength={3} maxLength={120} />
              </Field>
              <Field label="Idea" htmlFor="nc-idea" hint="What should the post be about?">
                <Textarea id="nc-idea" name="idea" rows={3} maxLength={2000} />
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="produce" defaultChecked={producible} disabled={!producible} className="size-4 accent-primary" />
            Start production now
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={pending || creators.length === 0} className="mt-1">
            {batch ? "Create batch" : "Create"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
