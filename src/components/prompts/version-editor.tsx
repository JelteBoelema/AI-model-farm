"use client";

import { useRef, useState, useTransition } from "react";
import { CircleAlert, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormSection } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CONTEXT_VARIABLES, VARIABLE_TYPES, type VariableDef } from "@/lib/schemas/prompt";
import { saveDraftAction } from "@/app/(dashboard)/prompts/actions";

export interface Issue {
  severity: "error" | "warning";
  message: string;
  line?: number;
}

const EMPTY_VAR: VariableDef = { name: "", label: "", type: "text", required: true, description: "", options: [] };

export function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return <p className="text-xs text-success">No problems found. This version can be published.</p>;
  return (
    <ul className="grid gap-1 text-xs" aria-label="Template problems">
      {issues.map((i, k) => (
        <li key={k} className={i.severity === "error" ? "flex gap-1.5 text-destructive" : "flex gap-1.5 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]"}>
          {i.severity === "error" ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : <TriangleAlert className="mt-px size-3.5 shrink-0" />}
          {i.line ? `Line ${i.line}: ` : ""}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function VersionEditor({ versionId, initialBody, initialVariables, initialIssues }: { versionId: string; initialBody: string; initialVariables: VariableDef[]; initialIssues: Issue[] }) {
  const [body, setBody] = useState(initialBody);
  const [vars, setVars] = useState<VariableDef[]>(initialVariables);
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const update = (i: number, patch: Partial<VariableDef>) => setVars((v) => v.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  function insert(name: string) {
    const el = textarea.current;
    const token = `{{${name}}}`;
    if (!el) return setBody((b) => b + token);
    const { selectionStart: s, selectionEnd: e } = el;
    const next = body.slice(0, s) + token + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  }

  function save() {
    setError(null);
    const variables = vars.map((v) => ({
      ...v,
      default: v.default === "" ? undefined : v.default,
      maxLength: v.maxLength || undefined,
    }));
    start(async () => {
      const res = await saveDraftAction({ versionId, draft: { body, variables } });
      if (!res.ok) return setError(res.error);
      setIssues(res.data ?? []);
      toast.success("Draft saved");
    });
  }

  return (
    <div className="grid gap-6">
      <FormSection title="Template" description="Use {{variable}} and {{#if variable}}…{{else}}…{{/if}}. No other helpers are available.">
        <Textarea
          ref={textarea}
          aria-label="Template body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-56 font-mono text-[13px] leading-relaxed"
          spellCheck={false}
        />
        <div className="grid gap-2 text-xs">
          <p className="text-muted-foreground">Insert variable:</p>
          <div className="flex flex-wrap gap-1.5">
            {vars.filter((v) => v.name).map((v) => (
              <button key={v.name} type="button" onClick={() => insert(v.name)} className="rounded-md border bg-primary/10 px-1.5 py-0.5 font-mono text-primary hover:bg-primary/20">
                {v.name}
              </button>
            ))}
            {Object.entries(CONTEXT_VARIABLES).map(([name, help]) => (
              <button key={name} type="button" title={help} onClick={() => insert(name)} className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-muted-foreground hover:bg-accent">
                {name}
              </button>
            ))}
          </div>
        </div>
        <IssueList issues={issues} />
      </FormSection>

      <FormSection title="Variables" description="Values supplied per generation. Context variables (grey) are filled from the selected creator and campaign.">
        <div className="grid gap-3">
          {vars.map((v, i) => (
            <div key={i} className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_8rem_1fr_auto]">
              <Input aria-label={`Variable ${i + 1} name`} placeholder="name" className="font-mono" value={v.name} onChange={(e) => update(i, { name: e.target.value })} />
              <NativeSelect aria-label={`Variable ${i + 1} type`} value={v.type} onChange={(e) => update(i, { type: e.target.value as VariableDef["type"] })}>
                {VARIABLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </NativeSelect>
              <Input aria-label={`Variable ${i + 1} label`} placeholder="Label shown in forms" value={v.label} onChange={(e) => update(i, { label: e.target.value })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${i + 1}`} onClick={() => setVars((x) => x.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
              <div className="flex flex-wrap items-center gap-3 md:col-span-4">
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={v.required} onChange={(e) => update(i, { required: e.target.checked })} /> Required
                </label>
                <Input aria-label={`Variable ${i + 1} default`} placeholder="Default (optional)" className="h-8 w-48 text-xs" value={v.default ?? ""} onChange={(e) => update(i, { default: e.target.value })} />
                {v.type === "enum" ? (
                  <Input
                    aria-label={`Variable ${i + 1} options`}
                    placeholder="Options, comma separated"
                    className="h-8 min-w-56 flex-1 text-xs"
                    value={v.options.join(", ")}
                    onChange={(e) => update(i, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
                  />
                ) : null}
                {v.type === "number" ? (
                  <>
                    <Input aria-label={`Variable ${i + 1} min`} type="number" placeholder="min" className="h-8 w-24 text-xs" value={v.min ?? ""} onChange={(e) => update(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <Input aria-label={`Variable ${i + 1} max`} type="number" placeholder="max" className="h-8 w-24 text-xs" value={v.max ?? ""} onChange={(e) => update(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </>
                ) : null}
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setVars((x) => [...x, { ...EMPTY_VAR }])}>
            <Plus /> Add variable
          </Button>
        </div>
      </FormSection>

      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <Button onClick={save} disabled={pending}>
          Save draft
        </Button>
      </div>
    </div>
  );
}
