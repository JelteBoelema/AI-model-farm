"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PROMPT_KINDS, PROMPT_SCOPES } from "@/lib/schemas/prompt";
import { humanize } from "@/lib/utils";
import { createTemplateAction } from "@/app/(dashboard)/prompts/actions";

export interface Option {
  id: string;
  name: string;
}

export function NewTemplateDialog({ creators, campaigns }: { creators: Option[]; campaigns: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<(typeof PROMPT_SCOPES)[number]>("GLOBAL");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(form: FormData) {
    setError(null);
    start(async () => {
      const res = await createTemplateAction({
        key: String(form.get("key") ?? ""),
        name: String(form.get("name") ?? ""),
        kind: form.get("kind"),
        scope,
        creatorId: scope === "CREATOR" ? form.get("creatorId") || null : null,
        campaignId: scope === "CAMPAIGN" ? form.get("campaignId") || null : null,
        description: String(form.get("description") ?? ""),
      });
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.push(`/prompts/${res.data!.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New template
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New prompt template</DialogTitle>
          <DialogDescription>Starts with an empty draft version 1.</DialogDescription>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          <Field label="Key" htmlFor="tpl-key" hint="Stable identifier, e.g. caption.instagram.default">
            <Input id="tpl-key" name="key" required maxLength={80} />
          </Field>
          <Field label="Name" htmlFor="tpl-name">
            <Input id="tpl-name" name="name" required maxLength={80} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" htmlFor="tpl-kind">
              <NativeSelect id="tpl-kind" name="kind" defaultValue="CAPTION">
                {PROMPT_KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Scope" htmlFor="tpl-scope">
              <NativeSelect id="tpl-scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                {PROMPT_SCOPES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </NativeSelect>
            </Field>
          </div>
          {scope === "CREATOR" ? (
            <Field label="Creator" htmlFor="tpl-creator">
              <NativeSelect id="tpl-creator" name="creatorId" required>
                {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {scope === "CAMPAIGN" ? (
            <Field label="Campaign" htmlFor="tpl-campaign">
              <NativeSelect id="tpl-campaign" name="campaignId" required>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="Description" htmlFor="tpl-desc">
            <Input id="tpl-desc" name="description" maxLength={500} />
          </Field>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={pending} className="mt-1">
            Create template
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
