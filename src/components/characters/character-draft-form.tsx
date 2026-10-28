"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormSection } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CharacterDraftInput } from "@/lib/schemas/creator";
import { updateDraftAction } from "@/app/(dashboard)/characters/actions";

const APPEARANCE_FIELDS: { key: keyof CharacterDraftInput["appearance"]; label: string; wide?: boolean }[] = [
  { key: "ageRange", label: "Age range (adult)" },
  { key: "build", label: "Build" },
  { key: "skinTone", label: "Skin tone" },
  { key: "hair", label: "Hair" },
  { key: "eyes", label: "Eyes" },
  { key: "face", label: "Face", wide: true },
  { key: "distinguishingFeatures", label: "Distinguishing features", wide: true },
  { key: "wardrobe", label: "Wardrobe & style", wide: true },
];

export function CharacterDraftForm({ profileId, initial, readOnly }: { profileId: string; initial: CharacterDraftInput; readOnly: boolean }) {
  const [d, setD] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await updateDraftAction({ profileId, draft: d });
      if (res.ok) toast.success("Draft saved");
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-6" aria-label="Character draft">
      <FormSection title="Appearance" description="Structured description used to build every image and video prompt.">
        <div className="grid gap-4 md:grid-cols-2">
          {APPEARANCE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`ap-${f.key}`} className={f.wide ? "md:col-span-2" : undefined}>
              <Input
                id={`ap-${f.key}`}
                value={d.appearance[f.key]}
                disabled={readOnly}
                onChange={(e) => setD({ ...d, appearance: { ...d.appearance, [f.key]: e.target.value } })}
              />
            </Field>
          ))}
        </div>
      </FormSection>
      <FormSection title="Prompts">
        <Field label="Identity prompt" htmlFor="identity" hint="Prepended to every visual prompt of this creator.">
          <Textarea id="identity" value={d.identityPrompt} disabled={readOnly} onChange={(e) => setD({ ...d, identityPrompt: e.target.value })} className="min-h-24" />
        </Field>
        <Field label="Negative prompt" htmlFor="negative">
          <Textarea id="negative" value={d.negativePrompt} disabled={readOnly} onChange={(e) => setD({ ...d, negativePrompt: e.target.value })} />
        </Field>
      </FormSection>
      <FormSection title="Consistency" description="How strongly generations are conditioned on the canonical references (used from phase 4).">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Reference weight (0–1)" htmlFor="weight">
            <Input
              id="weight"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={d.consistencyStrategy.referenceWeight}
              disabled={readOnly}
              onChange={(e) => setD({ ...d, consistencyStrategy: { ...d.consistencyStrategy, referenceWeight: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Fixed seed (optional)" htmlFor="seed">
            <Input
              id="seed"
              type="number"
              min={0}
              value={d.consistencyStrategy.seed ?? ""}
              disabled={readOnly}
              onChange={(e) => setD({ ...d, consistencyStrategy: { ...d.consistencyStrategy, seed: e.target.value === "" ? null : Number(e.target.value) } })}
            />
          </Field>
          <Field label="Notes" htmlFor="cnotes">
            <Input id="cnotes" value={d.consistencyStrategy.notes} disabled={readOnly} onChange={(e) => setD({ ...d, consistencyStrategy: { ...d.consistencyStrategy, notes: e.target.value } })} />
          </Field>
        </div>
      </FormSection>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!readOnly ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            Save draft
          </Button>
        </div>
      ) : null}
    </form>
  );
}
