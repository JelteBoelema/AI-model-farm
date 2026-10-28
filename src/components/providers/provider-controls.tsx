"use client";

import { useState, useTransition } from "react";
import { PlugZap, Plus, Power, Settings2, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { setProviderEnabledAction, setProviderPricingAction, updateProviderConfigAction, verifyProviderAction } from "@/app/(dashboard)/providers/actions";

export interface ProviderConfigView {
  model?: string;
  bulkModel?: string;
  effort?: string;
  imageSize?: string;
  imageQuality?: string;
  voiceId?: string;
  maxRequestsPerMinute: number;
  timeoutMs: number;
}

export function TestConnectionButton({ providerId }: { providerId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await verifyProviderAction({ providerId });
          if (!res.ok) return void toast.error(res.error);
          if (res.data?.ok) toast.success("Connection verified");
          else toast.error(res.data?.error ?? "Connection test failed");
        })
      }
    >
      <PlugZap /> {pending ? "Testing…" : "Test connection"}
    </Button>
  );
}

export function EnableToggle({ providerId, disabled }: { providerId: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setProviderEnabledAction({ providerId, enabled: disabled });
          if (res.ok) toast.success(disabled ? "Provider enabled" : "Provider disabled");
          else toast.error(res.error);
        })
      }
    >
      <Power /> {disabled ? "Enable" : "Disable"}
    </Button>
  );
}

export function ConfigDialog({ providerId, name, capability, config }: { providerId: string; name: string; capability: "TEXT" | "IMAGE" | "SPEECH" | "OTHER"; config: ProviderConfigView }) {
  const [open, setOpen] = useState(false);
  const [c, setC] = useState(config);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function save() {
    setError(null);
    start(async () => {
      const res = await updateProviderConfigAction({
        providerId,
        config: {
          model: c.model || undefined,
          bulkModel: capability === "TEXT" ? c.bulkModel || undefined : undefined,
          effort: capability === "TEXT" ? (c.effort as never) || undefined : undefined,
          imageSize: capability === "IMAGE" ? (c.imageSize as never) || undefined : undefined,
          imageQuality: capability === "IMAGE" ? (c.imageQuality as never) || undefined : undefined,
          voiceId: capability === "SPEECH" ? c.voiceId?.trim() || undefined : undefined,
          maxRequestsPerMinute: Number(c.maxRequestsPerMinute),
          timeoutMs: Number(c.timeoutMs),
        },
      });
      if (!res.ok) return setError(res.error);
      toast.success("Configuration saved");
      setOpen(false);
    });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2 /> Configure
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {name}</DialogTitle>
          <DialogDescription>Changing the model requires a new connection test before the provider is used.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Model" htmlFor="cfg-model">
            <Input id="cfg-model" value={c.model ?? ""} onChange={(e) => setC({ ...c, model: e.target.value })} className="font-mono" />
          </Field>
          {capability === "TEXT" ? (
            <>
              <Field label="Bulk model (cheap, high-volume tasks)" htmlFor="cfg-bulk">
                <Input id="cfg-bulk" value={c.bulkModel ?? ""} onChange={(e) => setC({ ...c, bulkModel: e.target.value })} className="font-mono" />
              </Field>
              <Field label="Effort" htmlFor="cfg-effort">
                <NativeSelect id="cfg-effort" value={c.effort ?? "medium"} onChange={(e) => setC({ ...c, effort: e.target.value })}>
                  {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{x}</option>)}
                </NativeSelect>
              </Field>
            </>
          ) : null}
          {capability === "IMAGE" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Default size" htmlFor="cfg-size">
                <NativeSelect id="cfg-size" value={c.imageSize ?? "1024x1536"} onChange={(e) => setC({ ...c, imageSize: e.target.value })}>
                  {["1024x1024", "1024x1536", "1536x1024"].map((x) => <option key={x} value={x}>{x}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Default quality" htmlFor="cfg-quality">
                <NativeSelect id="cfg-quality" value={c.imageQuality ?? "medium"} onChange={(e) => setC({ ...c, imageQuality: e.target.value })}>
                  {["low", "medium", "high"].map((x) => <option key={x} value={x}>{x}</option>)}
                </NativeSelect>
              </Field>
            </div>
          ) : null}
          {capability === "SPEECH" ? (
            <Field label="Default voice id" htmlFor="cfg-voice" hint="A designed (synthetic) voice from your voice library. Never a cloned voice without written consent.">
              <Input id="cfg-voice" value={c.voiceId ?? ""} onChange={(e) => setC({ ...c, voiceId: e.target.value })} className="font-mono" />
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Max requests / minute" htmlFor="cfg-rpm">
              <Input id="cfg-rpm" type="number" min={1} value={c.maxRequestsPerMinute} onChange={(e) => setC({ ...c, maxRequestsPerMinute: Number(e.target.value) })} />
            </Field>
            <Field label="Timeout (ms)" htmlFor="cfg-timeout">
              <Input id="cfg-timeout" type="number" min={5000} step={1000} value={c.timeoutMs} onChange={(e) => setC({ ...c, timeoutMs: Number(e.target.value) })} />
            </Field>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button disabled={pending} onClick={save}>Save configuration</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface PriceRow {
  model: string;
  unit: string;
  price: string;
}

export interface PricingView {
  currency: "USD" | "EUR";
  fxToEur: string;
  source: string;
  rows: PriceRow[];
}

export interface PricingPreset {
  label: string;
  source: string;
  currency: "USD" | "EUR";
  rows: PriceRow[];
}

export function PricingDialog({ providerId, name, units, initial, preset }: { providerId: string; name: string; units: Record<string, string>; initial: PricingView; preset?: PricingPreset }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const updateRow = (i: number, patch: Partial<PriceRow>) => setP({ ...p, rows: p.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  function save() {
    setError(null);
    const models: Record<string, Record<string, string>> = {};
    for (const r of p.rows) {
      if (!r.model.trim() || !r.price.trim()) continue;
      (models[r.model.trim()] ??= {})[r.unit] = r.price.trim();
    }
    start(async () => {
      const res = await setProviderPricingAction({
        providerId,
        pricing: { currency: p.currency, fxToEur: p.currency === "USD" ? p.fxToEur : undefined, source: p.source, updatedAt: new Date().toISOString(), models },
      });
      if (!res.ok) return setError(res.error);
      toast.success("Price list saved");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Tags /> Prices
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Price list · {name}</DialogTitle>
          <DialogDescription>
            Used for estimates, budget checks and the cost ledger. Copy prices from the provider&apos;s official price page; a missing price blocks paid use, it is never treated as zero.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {preset ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-xs">
              <span className="text-muted-foreground">{preset.label}</span>
              <Button size="sm" variant="ghost" onClick={() => setP({ ...p, currency: preset.currency, source: preset.source, rows: preset.rows })}>
                Use preset
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Currency" htmlFor="pr-currency">
              <NativeSelect id="pr-currency" value={p.currency} onChange={(e) => setP({ ...p, currency: e.target.value as "USD" | "EUR" })}>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </NativeSelect>
            </Field>
            {p.currency === "USD" ? (
              <Field label="EUR per USD" htmlFor="pr-fx" hint="Include a safety margin">
                <Input id="pr-fx" value={p.fxToEur} onChange={(e) => setP({ ...p, fxToEur: e.target.value })} placeholder="0.95" />
              </Field>
            ) : null}
            <Field label="Source (official price page)" htmlFor="pr-source" className={p.currency === "USD" ? "" : "sm:col-span-2"}>
              <Input id="pr-source" value={p.source} onChange={(e) => setP({ ...p, source: e.target.value })} placeholder="https://…" />
            </Field>
          </div>
          <div className="grid gap-2">
            {p.rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_12rem_7rem_auto] gap-2">
                <Input aria-label={`Price ${i + 1} model`} value={r.model} onChange={(e) => updateRow(i, { model: e.target.value })} className="font-mono text-xs" placeholder="model id" />
                <NativeSelect aria-label={`Price ${i + 1} unit`} value={r.unit} onChange={(e) => updateRow(i, { unit: e.target.value })}>
                  {Object.entries(units).map(([u, label]) => <option key={u} value={u}>{label}</option>)}
                </NativeSelect>
                <Input aria-label={`Price ${i + 1} amount`} value={r.price} onChange={(e) => updateRow(i, { price: e.target.value })} placeholder="0.00" inputMode="decimal" />
                <Button variant="ghost" size="icon" aria-label={`Remove price ${i + 1}`} onClick={() => setP({ ...p, rows: p.rows.filter((_, j) => j !== i) })}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => setP({ ...p, rows: [...p.rows, { model: p.rows.at(-1)?.model ?? "", unit: Object.keys(units)[0]!, price: "" }] })}>
              <Plus /> Add price
            </Button>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button disabled={pending} onClick={save}>Save price list</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
