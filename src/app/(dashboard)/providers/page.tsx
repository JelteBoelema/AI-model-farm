import type { Metadata } from "next";
import { CircleCheck, CircleX } from "lucide-react";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import {
  ConfigDialog,
  EnableToggle,
  PricingDialog,
  TestConnectionButton,
  type PriceRow,
  type PricingPreset,
} from "@/components/providers/provider-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/rbac";
import { humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { findActivePause } from "@/server/controls";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { PROVIDER_CATALOG } from "@/server/providers/catalog";
import { parsePricing, PRICE_UNITS } from "@/server/providers/pricing";
import { evaluateReadiness, parseConfig } from "@/server/providers/registry";
import { RefreshProvidersButton } from "./refresh-button";

export const metadata: Metadata = { title: "AI Providers" };

// Anthropic first-party list prices per million tokens (USD). Admins confirm and set the FX rate.
const ANTHROPIC_PRESET: PricingPreset = {
  label: "Anthropic list prices (USD per million tokens, as of 2026-10-06) for Claude Opus 5.5 and Claude Haiku 5.5 — verify on the source page",
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  currency: "USD",
  rows: [
    { model: "claude-opus-5-5", unit: "input_mtok", price: "4.00" },
    { model: "claude-opus-5-5", unit: "output_mtok", price: "20.00" },
    { model: "claude-opus-5-5", unit: "cache_read_mtok", price: "0.20" },
    { model: "claude-haiku-5-5", unit: "input_mtok", price: "0.10" },
    { model: "claude-haiku-5-5", unit: "output_mtok", price: "0.50" },
    { model: "claude-haiku-5-5", unit: "long_input_mtok", price: "0.50" },
    { model: "claude-haiku-5-5", unit: "long_output_mtok", price: "2.50" },
  ],
};

const UNITS_FOR: Record<string, (keyof typeof PRICE_UNITS)[]> = {
  anthropic: ["input_mtok", "output_mtok", "cache_write_mtok", "cache_read_mtok", "long_input_mtok", "long_output_mtok"],
  "openai-images": ["per_image", "text_input_mtok", "image_input_mtok", "image_output_mtok"],
};

export default async function ProvidersPage() {
  const user = await requireUser();
  const admin = can(user.role, "providers:manage");
  const rows = await db.aiProvider.findMany({ orderBy: [{ isMock: "asc" }, { priority: "asc" }] });
  const items = await Promise.all(
    rows.map(async (row) => ({
      row,
      entry: PROVIDER_CATALOG.find((c) => c.key === row.key),
      readiness: await evaluateReadiness(row),
      config: parseConfig(row.config),
      pricing: parsePricing(row.pricing),
      pause: await findActivePause({ chain: "generation", providerId: row.id }),
    })),
  );
  const mockMode = env().MOCK_MODE;

  return (
    <>
      <PageHeader
        title="AI Providers"
        description="A provider is used only when its adapter exists, the key resolves, a model and price list are set, and a live connection test passed."
        actions={admin ? <RefreshProvidersButton /> : undefined}
      />
      {mockMode ? (
        <p className="-mt-3 text-xs text-primary">Mock mode is on: every generation uses the mock providers, whatever is configured below.</p>
      ) : null}

      <div className="grid gap-4">
        {items.map(({ row, entry, readiness, config, pricing, pause }) => {
          const capability = row.capabilities.includes("TEXT") ? "TEXT" : row.capabilities.includes("IMAGE") ? "IMAGE" : "OTHER";
          const priceRows: PriceRow[] = Object.entries(pricing?.models ?? {}).flatMap(([model, units]) => Object.entries(units).map(([unit, price]) => ({ model, unit, price })));
          const unitLabels = Object.fromEntries((UNITS_FOR[row.key] ?? (Object.keys(PRICE_UNITS) as (keyof typeof PRICE_UNITS)[])).map((u) => [u, PRICE_UNITS[u]]));
          return (
            <Card key={row.id} aria-label={row.displayName}>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {row.displayName} <StatusBadge status={row.status} /> {row.isMock ? <OriginBadge kind="mock" /> : null}
                    {pause ? <StatusBadge status="PAUSED" /> : null}
                  </CardTitle>
                  <CardDescription>{entry?.rationale}</CardDescription>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {row.capabilities.map((c) => <Badge key={c} tone="outline">{humanize(c)}</Badge>)}
                    {config.model ? <Badge tone="neutral" className="font-mono">{config.model}</Badge> : null}
                    {config.bulkModel ? <Badge tone="neutral" className="font-mono">bulk: {config.bulkModel}</Badge> : null}
                  </div>
                  {pause ? <p className="mt-2 text-xs text-destructive">Paused: {pause.reason} — resume under Settings → Controls.</p> : null}
                </div>
                {admin && !row.isMock && entry?.adapterPhase === null ? (
                  <div className="flex flex-wrap gap-2">
                    <ConfigDialog
                      providerId={row.id}
                      name={row.displayName}
                      capability={capability}
                      config={{ ...config, maxRequestsPerMinute: config.maxRequestsPerMinute, timeoutMs: config.timeoutMs }}
                    />
                    <PricingDialog
                      providerId={row.id}
                      name={row.displayName}
                      units={unitLabels}
                      initial={{ currency: pricing?.currency ?? "USD", fxToEur: pricing?.fxToEur ?? "", source: pricing?.source ?? "", rows: priceRows }}
                      preset={row.key === "anthropic" ? ANTHROPIC_PRESET : undefined}
                    />
                    <TestConnectionButton providerId={row.id} />
                    <EnableToggle providerId={row.id} disabled={row.status === "DISABLED"} />
                  </div>
                ) : null}
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs" aria-label={`${row.displayName} readiness`}>
                  {readiness.checks.map((c) => (
                    <li key={c.label} className="flex items-center gap-1.5" title={c.detail}>
                      {c.ok ? <CircleCheck className="size-3.5 text-success" aria-hidden /> : <CircleX className="size-3.5 text-muted-foreground" aria-hidden />}
                      <span className={c.ok ? "" : "text-muted-foreground"}>{c.label}</span>
                      {!c.ok && c.detail ? <span className="text-muted-foreground">· {c.detail}</span> : null}
                    </li>
                  ))}
                </ul>
                {priceRows.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Prices ({pricing!.currency}{pricing!.fxToEur ? `, €${pricing!.fxToEur}/USD` : ""}): {priceRows.map((r) => `${r.model} ${r.unit} ${r.price}`).join(" · ")}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
