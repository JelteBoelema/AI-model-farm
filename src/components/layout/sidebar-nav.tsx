"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { NAVIGATION } from "@/config/navigation";
import { cn } from "@/lib/utils";

const CARRIED_FILTERS = ["creator", "campaign", "platform", "period", "status"] as const;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Keep global filters (but not page-specific status) when moving between sections.
  const carried = new URLSearchParams();
  for (const key of CARRIED_FILTERS) {
    const v = searchParams.get(key);
    if (v && key !== "status") carried.set(key, v);
  }
  const suffix = carried.toString() ? `?${carried}` : "";

  return (
    <nav className="flex flex-col gap-5" aria-label="Main">
      {NAVIGATION.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">{group.label}</p>
          {group.items.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={`${item.href}${suffix}`}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  active ? "bg-card font-medium text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "")} aria-hidden />
                <span className="truncate">{item.label}</span>
                <PendingDot />
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function PendingDot() {
  const { pending } = useLinkStatus();
  return pending ? <span className="ml-auto size-1.5 animate-pulse rounded-full bg-primary" role="status" aria-label="Loading" /> : null;
}
