"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Eye, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { VariableDef } from "@/lib/schemas/prompt";
import { cn } from "@/lib/utils";
import { previewPromptAction, runPromptTestAction } from "@/app/(dashboard)/prompts/actions";

export interface TestRunView {
  id: string;
  version: number;
  createdAt: string;
  status: string;
  isMock: boolean;
  providerKey: string | null;
  creatorName: string | null;
  variables: Record<string, unknown>;
  renderedPrompt: string;
  safetyRules: string | null;
  output: string | null;
  outputUrl: string | null;
  error: string | null;
  cost: string;
}

/** Re-renders the page every 2 s while test runs are queued or running. */
function useAutoRefresh(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [active, router]);
}

interface Option {
  id: string;
  name: string;
}

export function TestPanel({ versionId, variables, creators, campaigns, runs, generates }: { versionId: string; variables: VariableDef[]; creators: Option[]; campaigns: Option[]; runs: TestRunView[]; generates: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(variables.map((v) => [v.name, v.default ?? ""])));
  const [creatorId, setCreatorId] = useState(creators[0]?.id ?? "");
  const [campaignId, setCampaignId] = useState("");
  const [preview, setPreview] = useState<{ text: string; safetyRules: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, start] = useTransition();

  useAutoRefresh(runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING"));
  const payload = () => ({ versionId, values, creatorId: creatorId || null, campaignId: campaignId || null });

  function doPreview() {
    setError(null);
    start(async () => {
      const res = await previewPromptAction(payload());
      if (res.ok) setPreview(res.data!);
      else setError(res.error);
    });
  }

  function doRun() {
    setError(null);
    start(async () => {
      const res = await runPromptTestAction(payload());
      if (res.ok) {
        toast.success(generates ? "Test run queued" : "Rendered and recorded");
        setSelected((s) => [res.data!.id, ...s].slice(0, 2));
      } else setError(res.error);
    });
  }

  const compare = runs.filter((r) => selected.includes(r.id));

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Creator context" htmlFor="test-creator">
          <NativeSelect id="test-creator" value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
            <option value="">None</option>
            {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Campaign context" htmlFor="test-campaign">
          <NativeSelect id="test-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">None</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
        {variables.map((v) => (
          <Field key={v.name} label={`${v.label || v.name}${v.required ? "" : " (optional)"}`} htmlFor={`val-${v.name}`} hint={v.description || undefined} className={v.type === "longtext" ? "md:col-span-2" : undefined}>
            {v.type === "enum" ? (
              <NativeSelect id={`val-${v.name}`} value={values[v.name]} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}>
                {!v.default ? <option value="">Choose…</option> : null}
                {v.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </NativeSelect>
            ) : v.type === "boolean" ? (
              <NativeSelect id={`val-${v.name}`} value={values[v.name] || "false"} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}>
                <option value="false">No</option>
                <option value="true">Yes</option>
              </NativeSelect>
            ) : v.type === "longtext" ? (
              <Textarea id={`val-${v.name}`} value={values[v.name]} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />
            ) : (
              <Input id={`val-${v.name}`} type={v.type === "number" ? "number" : "text"} value={values[v.name]} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />
            )}
          </Field>
        ))}
      </div>
      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending} onClick={doPreview}>
          <Eye /> Preview
        </Button>
        <Button disabled={pending} onClick={doRun}>
          <FlaskConical /> {generates ? "Run test" : "Render & record"}
        </Button>
        <p className="self-center text-xs text-muted-foreground">
          {generates
            ? "Queued on the generation workers with the selected provider (the labelled mock in mock mode). Cost is recorded per run."
            : "Video and rule prompts are rendered only; video generation ships in phase 6."}
        </p>
      </div>
      {preview ? (
        <div className="grid gap-2">
          <p className="text-xs font-medium">Rendered prompt</p>
          <pre className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs" aria-label="Rendered prompt">{preview.text}</pre>
          {preview.safetyRules ? (
            <>
              <p className="text-xs font-medium">Appended safety rules</p>
              <pre className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">{preview.safetyRules}</pre>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        <p className="text-sm font-medium">Test runs <span className="font-normal text-muted-foreground">· select two to compare</span></p>
        {runs.length === 0 ? <p className="text-xs text-muted-foreground">No test runs yet.</p> : null}
        <ul className="divide-y rounded-lg border">
          {runs.map((r) => (
            <li key={r.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-2 text-xs", selected.includes(r.id) && "bg-accent/50")}>
              <input
                type="checkbox"
                aria-label={`Select run ${r.createdAt}`}
                className="size-4 accent-[var(--primary)]"
                checked={selected.includes(r.id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [r.id, ...s].slice(0, 2) : s.filter((x) => x !== r.id)))}
              />
              <span className="tabular-nums text-muted-foreground">{r.createdAt}</span>
              <span>v{r.version}</span>
              <StatusBadge status={r.status} />
              {r.isMock ? <OriginBadge kind="mock" /> : null}
              <span className="text-muted-foreground">{r.creatorName ?? "no creator"}</span>
              {r.error ? <span className="max-w-xs truncate text-destructive" title={r.error}>{r.error}</span> : null}
              <span className="ml-auto text-muted-foreground">cost {r.cost}</span>
            </li>
          ))}
        </ul>
      </div>

      {compare.length > 0 ? (
        <div className={cn("grid gap-3", compare.length === 2 && "md:grid-cols-2")} aria-label="Comparison">
          {compare.map((r) => (
            <div key={r.id} className="grid content-start gap-2 rounded-lg border p-3 text-xs">
              <p className="flex items-center gap-2 font-medium">
                v{r.version} · {r.createdAt} {r.isMock ? <OriginBadge kind="mock" /> : null}
              </p>
              <p className="text-muted-foreground">Variables: <code className="font-mono">{JSON.stringify(r.variables)}</code></p>
              <p className="font-medium">Prompt</p>
              <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono">{r.renderedPrompt}</pre>
              <p className="font-medium">Output</p>
              {r.outputUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated/signed media URL
                <img src={r.outputUrl} alt={`Generated image of run ${r.createdAt}`} className="max-h-96 w-auto rounded border object-contain" />
              ) : (
                <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono">
                  {r.output ?? (r.status === "QUEUED" || r.status === "RUNNING" ? "— running —" : r.status === "FAILED" ? `— failed: ${r.error ?? "unknown error"} —` : "— rendered only —")}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
