"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { FilterX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { PERIODS, PERIOD_LABELS, PLATFORMS } from "@/lib/filters";
import { cn, humanize } from "@/lib/utils";

export interface FilterOption {
  id: string;
  name: string;
  isDemo?: boolean;
}

export function FilterBar({ creators, campaigns }: { creators: FilterOption[]; campaigns: FilterOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  }

  const active = ["creator", "campaign", "platform", "period"].some((k) => params.get(k));

  return (
    <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", pending && "opacity-60")} role="group" aria-label="Filters">
      <NativeSelect aria-label="Creator" value={params.get("creator") ?? ""} onChange={(e) => update("creator", e.target.value)} className="w-40">
        <option value="">All creators</option>
        {creators.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.isDemo ? " (demo)" : ""}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label="Campaign" value={params.get("campaign") ?? ""} onChange={(e) => update("campaign", e.target.value)} className="w-40">
        <option value="">All campaigns</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label="Platform" value={params.get("platform") ?? ""} onChange={(e) => update("platform", e.target.value)} className="w-36">
        <option value="">All platforms</option>
        {PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {humanize(p)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label="Period" value={params.get("period") ?? "30d"} onChange={(e) => update("period", e.target.value)} className="w-36">
        {PERIODS.map((p) => (
          <option key={p} value={p}>
            {PERIOD_LABELS[p]}
          </option>
        ))}
      </NativeSelect>
      {active ? (
        <Button variant="ghost" size="sm" onClick={() => startTransition(() => router.replace(pathname, { scroll: false }))}>
          <FilterX /> Reset
        </Button>
      ) : null}
    </div>
  );
}
