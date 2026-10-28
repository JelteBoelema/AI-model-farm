"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormSection } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTENT_FORMATS,
  SCHEDULE_PLATFORMS,
  WEEKDAYS,
  type CharacterDraftInput,
  type CreatorProfileInput,
} from "@/lib/schemas/creator";
import { humanize } from "@/lib/utils";
import { createCreatorAction, updateCreatorAction } from "@/app/(dashboard)/creators/actions";

export const EMPTY_PROFILE: CreatorProfileInput = {
  name: "",
  niche: "",
  targetAudience: "",
  language: "nl-NL",
  targetRegions: ["NL"],
  personality: "",
  toneOfVoice: "",
  backstory: "",
  contentPillars: [{ name: "", description: "" }],
  contentFormats: ["IMAGE_POST"],
  timezone: "Europe/Amsterdam",
  publishingSchedule: { slots: [] },
};

type Props =
  | { mode: "create"; initial?: CreatorProfileInput; character?: CharacterDraftInput; proposalSource?: string; readOnly?: false }
  | { mode: "edit"; creatorId: string; initial: CreatorProfileInput; readOnly?: boolean };

export function CreatorProfileForm(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [p, setP] = useState<CreatorProfileInput>(props.initial ?? EMPTY_PROFILE);
  const [regions, setRegions] = useState((props.initial ?? EMPTY_PROFILE).targetRegions.join(", "));
  const [error, setError] = useState<string | null>(null);
  const ro = props.readOnly ?? false;
  // Filled after mount: server and browser ICU data may list different zones (hydration mismatch).
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => setZones(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []), []);

  const set = <K extends keyof CreatorProfileInput>(key: K, value: CreatorProfileInput[K]) => setP((prev) => ({ ...prev, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const profile = { ...p, targetRegions: regions.split(/[,\s]+/).filter(Boolean).map((r) => r.toUpperCase()) };
    start(async () => {
      if (props.mode === "create") {
        const res = await createCreatorAction({ profile, character: props.character, proposalSource: props.proposalSource });
        if (!res.ok) return setError(res.error);
        toast.success("Creator saved as draft");
        router.push(`/creators/${res.data!.id}`);
      } else {
        const res = await updateCreatorAction({ creatorId: props.creatorId, profile });
        if (!res.ok) return setError(res.error);
        toast.success("Profile saved");
      }
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-6" aria-label="Creator profile">
      <FormSection title="Identity" description="Fictional persona. Never model a creator on a real, identifiable person.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" htmlFor="name">
            <Input id="name" value={p.name} onChange={(e) => set("name", e.target.value)} disabled={ro} required maxLength={60} />
          </Field>
          <Field label="Niche" htmlFor="niche">
            <Input id="niche" value={p.niche} onChange={(e) => set("niche", e.target.value)} disabled={ro} required maxLength={160} />
          </Field>
          <Field label="Target audience" htmlFor="audience" className="md:col-span-2">
            <Input id="audience" value={p.targetAudience} onChange={(e) => set("targetAudience", e.target.value)} disabled={ro} required maxLength={280} />
          </Field>
          <Field label="Language" htmlFor="language" hint="Language tag, e.g. nl-NL or en-GB">
            <Input id="language" value={p.language} onChange={(e) => set("language", e.target.value)} disabled={ro} required />
          </Field>
          <Field label="Target regions" htmlFor="regions" hint="ISO country codes, comma separated (NL, BE)">
            <Input id="regions" value={regions} onChange={(e) => setRegions(e.target.value)} disabled={ro} required />
          </Field>
          <Field label="Timezone" htmlFor="timezone" hint="Used for the publishing schedule">
            <Input id="timezone" value={p.timezone} onChange={(e) => set("timezone", e.target.value)} disabled={ro} required list="timezones" />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Personality">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Personality" htmlFor="personality">
            <Textarea id="personality" value={p.personality} onChange={(e) => set("personality", e.target.value)} disabled={ro} maxLength={500} />
          </Field>
          <Field label="Tone of voice" htmlFor="tone">
            <Textarea id="tone" value={p.toneOfVoice} onChange={(e) => set("toneOfVoice", e.target.value)} disabled={ro} maxLength={280} />
          </Field>
          <Field label="Backstory (fictional)" htmlFor="backstory" className="md:col-span-2">
            <Textarea id="backstory" value={p.backstory} onChange={(e) => set("backstory", e.target.value)} disabled={ro} maxLength={2000} className="min-h-28" />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Content" description="Pillars guide ideation; formats limit what the factory produces.">
        <div className="grid gap-2">
          {p.contentPillars.map((pillar, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
              <Input
                aria-label={`Pillar ${i + 1} name`}
                placeholder="Pillar name"
                value={pillar.name}
                disabled={ro}
                onChange={(e) => set("contentPillars", p.contentPillars.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <Input
                aria-label={`Pillar ${i + 1} description`}
                placeholder="What belongs in this pillar"
                value={pillar.description}
                disabled={ro}
                onChange={(e) => set("contentPillars", p.contentPillars.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
              />
              {!ro ? (
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove pillar ${i + 1}`} disabled={p.contentPillars.length <= 1}
                  onClick={() => set("contentPillars", p.contentPillars.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
          {!ro && p.contentPillars.length < 8 ? (
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set("contentPillars", [...p.contentPillars, { name: "", description: "" }])}>
              <Plus /> Add pillar
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Content formats">
          {CONTENT_FORMATS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={p.contentFormats.includes(f)}
                disabled={ro}
                onChange={(e) => set("contentFormats", e.target.checked ? [...p.contentFormats, f] : p.contentFormats.filter((x) => x !== f))}
              />
              {humanize(f)}
            </label>
          ))}
        </div>
      </FormSection>

      <FormSection title="Publishing schedule" description="Preferred slots in the creator's timezone. The scheduler (phase 7) respects platform and account limits.">
        <div className="grid gap-2">
          {p.publishingSchedule.slots.length === 0 ? <p className="text-xs text-muted-foreground">No slots yet.</p> : null}
          {p.publishingSchedule.slots.map((slot, i) => {
            const update = (patch: Partial<typeof slot>) =>
              set("publishingSchedule", { slots: p.publishingSchedule.slots.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="grid grid-cols-[1fr_1fr_7rem_auto] gap-2 sm:w-fit sm:grid-cols-[10rem_8rem_7rem_auto]">
                <NativeSelect aria-label={`Slot ${i + 1} platform`} value={slot.platform} disabled={ro} onChange={(e) => update({ platform: e.target.value as typeof slot.platform })}>
                  {SCHEDULE_PLATFORMS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
                </NativeSelect>
                <NativeSelect aria-label={`Slot ${i + 1} day`} value={slot.weekday} disabled={ro} onChange={(e) => update({ weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, k) => <option key={d} value={k + 1}>{d}</option>)}
                </NativeSelect>
                <Input aria-label={`Slot ${i + 1} time`} type="time" value={slot.time} disabled={ro} onChange={(e) => update({ time: e.target.value })} />
                {!ro ? (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove slot ${i + 1}`}
                    onClick={() => set("publishingSchedule", { slots: p.publishingSchedule.slots.filter((_, j) => j !== i) })}>
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {!ro ? (
            <Button type="button" variant="outline" size="sm" className="w-fit"
              onClick={() => set("publishingSchedule", { slots: [...p.publishingSchedule.slots, { platform: "INSTAGRAM", weekday: 1, time: "18:00" }] })}>
              <Plus /> Add slot
            </Button>
          ) : null}
        </div>
      </FormSection>

      <datalist id="timezones">
        {zones.map((tz) => <option key={tz} value={tz} />)}
      </datalist>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!ro ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {props.mode === "create" ? "Save as draft" : "Save profile"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
