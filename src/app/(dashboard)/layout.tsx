import { Suspense } from "react";
import Link from "next/link";
import { Beaker, OctagonPause } from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { FilterBar } from "@/components/layout/filter-bar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getFilterOptions } from "@/server/services/dashboard";
import { listPausedSwitches } from "@/server/controls";
import { signOutAction } from "./actions";

export const dynamic = "force-dynamic";

// Deliberately no route-group loading.tsx: in Next 15.5 it intermittently stalls same-route
// search-param navigations, which is how every global filter change works. Pending feedback comes
// from the filter bar's transition and the sidebar links' useLinkStatus instead.

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [options, paused] = await Promise.all([getFilterOptions(), listPausedSwitches()]);
  const globalPauses = paused.filter((p) => p.scope === "ALL_GENERATION" || p.scope === "ALL_PUBLISHING");

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r bg-sidebar px-3 py-5 lg:flex">
        <Brand />
        <Suspense>
          <SidebarNav />
        </Suspense>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {env().MOCK_MODE ? (
          <div className="flex items-center justify-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-1.5 text-xs text-primary">
            <Beaker className="size-3.5" aria-hidden />
            Mock mode — AI providers and social platforms are simulated. Nothing is billed or published.
          </div>
        ) : null}
        {globalPauses.length > 0 ? (
          <div className="flex items-center justify-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
            <OctagonPause className="size-3.5" aria-hidden />
            {globalPauses.map((p) => humanize(p.scope)).join(" and ")} paused: {globalPauses[0]!.reason}
            <Link href="/settings" className="underline underline-offset-2">
              Manage
            </Link>
          </div>
        ) : null}
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b bg-background/85 px-4 py-2.5 backdrop-blur md:px-6">
          <MobileNav />
          <Suspense>
            <FilterBar creators={options.creators} campaigns={options.campaigns} />
          </Suspense>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu name={user.name} email={user.email} role={user.role} signOutAction={signOutAction} />
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
