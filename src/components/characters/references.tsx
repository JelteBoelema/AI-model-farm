"use client";

import { useRef, useState, useTransition } from "react";
import { Star, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { removeReferenceAction, setCanonicalAction, uploadReferenceAction } from "@/app/(dashboard)/characters/actions";

export interface ReferenceView {
  id: string;
  label: string;
  isCanonical: boolean;
  url: string;
  width: number | null;
  height: number | null;
  rightsNote: string | null;
}

export function ReferenceGrid({ references, editable }: { references: ReferenceView[]; editable: boolean }) {
  const [pending, start] = useTransition();
  const call = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) =>
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(msg);
      else toast.error(res.error ?? "Failed");
    });

  if (references.length === 0) return <p className="text-sm text-muted-foreground">No reference images yet.</p>;
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="Reference images">
      {references.map((r) => (
        <li key={r.id} className="overflow-hidden rounded-lg border bg-card">
          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated/signed URLs, no optimizer */}
          <img src={r.url} alt={r.label} className="aspect-square w-full bg-muted object-cover" loading="lazy" />
          <div className="grid gap-1 p-2.5 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <span className="truncate">{r.label}</span>
              {r.isCanonical ? <Badge tone="primary">Canonical</Badge> : null}
            </p>
            <p className="text-muted-foreground">
              {r.width}×{r.height}
            </p>
            {r.rightsNote ? <p className="line-clamp-2 text-muted-foreground" title={r.rightsNote}>{r.rightsNote}</p> : null}
            {editable ? (
              <div className="mt-1 flex gap-1">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => call(() => setCanonicalAction({ referenceId: r.id, canonical: !r.isCanonical }), "Reference updated")}>
                  <Star /> {r.isCanonical ? "Unmark" : "Canonical"}
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Remove ${r.label}`} disabled={pending} onClick={() => call(() => removeReferenceAction({ referenceId: r.id }), "Reference removed")}>
                  <Trash2 />
                </Button>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ReferenceUploader({ profileId }: { profileId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(form: FormData) {
    setError(null);
    form.set("profileId", profileId);
    start(async () => {
      const res = await uploadReferenceAction(form);
      if (res.ok) {
        toast.success("Reference added");
        formRef.current?.reset();
      } else setError(res.error);
    });
  }

  return (
    <form ref={formRef} action={submit} className="grid gap-3 rounded-lg border border-dashed p-4" aria-label="Upload reference">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Image" htmlFor="ref-file" hint="PNG, JPEG or WebP · min 512 px · max 15 MB">
          <Input id="ref-file" name="file" type="file" accept="image/png,image/jpeg,image/webp" required />
        </Field>
        <Field label="Label" htmlFor="ref-label">
          <Input id="ref-label" name="label" placeholder="front, neutral light" required maxLength={60} />
        </Field>
        <Field label="Source & rights" htmlFor="ref-rights" className="md:col-span-2" hint="Required. Licence, consent record, or the generator that produced it. Real people only with written consent.">
          <Input id="ref-rights" name="rightsNote" required minLength={10} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="canonical" defaultChecked className="size-4 accent-[var(--primary)]" /> Canonical reference (used for identity conditioning)
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" size="sm" className="w-fit" disabled={pending}>
        <Upload /> Upload reference
      </Button>
    </form>
  );
}
