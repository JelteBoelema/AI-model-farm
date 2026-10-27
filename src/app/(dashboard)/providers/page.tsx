import type { Metadata } from "next";
import { CircleCheck, CircleDashed, KeyRound } from "lucide-react";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/rbac";
import { humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { evaluateProvider, PROVIDER_CATALOG } from "@/server/providers/catalog";
import { RefreshProvidersButton } from "./refresh-button";

export const metadata: Metadata = { title: "AI Providers" };

export default async function ProvidersPage() {
  const user = await requireUser();
  const rows = await db.aiProvider.findMany({ orderBy: [{ isMock: "asc" }, { priority: "asc" }] });
  const details = await Promise.all(
    rows.map(async (r) => {
      const entry = PROVIDER_CATALOG.find((c) => c.key === r.key);
      return { row: r, entry, detail: entry ? await evaluateProvider(entry) : null };
    }),
  );

  return (
    <>
      <PageHeader
        title="AI Providers"
        description="Provider-independent registry. A provider is only used when its adapter exists and its credential resolves from the secrets store."
        actions={can(user.role, "providers:manage") ? <RefreshProvidersButton /> : undefined}
      />
      <PhaseNotice
        phase={4}
        title="Provider adapters"
        items={[
          "Capability discovery and input validation per adapter",
          "Async generation with status polling, timeouts and retries",
          "Usage units and cost reporting into the cost ledger",
          "Quality-gated fallbacks between providers",
          "Per-provider rate limits and pause switches",
          "Explicit mock adapters for the full test chain",
        ]}
      />
      <Card>
        <CardContent className="px-0 pt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Credential</TableHead>
                <TableHead>Adapter</TableHead>
                <TableHead>Pricing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {details.map(({ row, entry, detail }) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-sm">
                    <p className="flex items-center gap-2 font-medium">
                      {row.displayName} {row.isMock ? <OriginBadge kind="mock" /> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{entry?.rationale}</p>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.capabilities.map((c) => (
                        <Badge key={c} tone="outline">
                          {humanize(c)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                    {detail ? <p className="mt-1 text-[11px] text-muted-foreground">{detail.reason}</p> : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.credentialRef ? (
                      <span className="flex items-center gap-1.5">
                        <KeyRound className={`size-3.5 ${detail?.credentialPresent ? "text-success" : "text-muted-foreground"}`} aria-hidden />
                        <code className="font-mono">{row.credentialRef}</code>
                        <span className="text-muted-foreground">{detail?.credentialPresent ? "present" : "missing"}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">none needed</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {detail?.adapterReady ? (
                      <span className="flex items-center gap-1.5 text-success">
                        <CircleCheck className="size-3.5" /> Ready
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <CircleDashed className="size-3.5" /> Phase {entry?.adapterPhase}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {Object.keys(row.pricing as object).length > 0 ? "Configured" : "Not set — paid use blocked"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
