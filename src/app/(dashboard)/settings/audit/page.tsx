import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { ScrollText } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseFilters, periodStart } from "@/lib/filters";
import { formatDateTime, humanize } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AuditPage({ searchParams }: Props) {
  const raw = await searchParams;
  const filters = parseFilters(raw);
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 100) : "";
  const page = Math.max(1, Number.parseInt(typeof raw.page === "string" ? raw.page : "1", 10) || 1);
  const since = periodStart(filters.period);

  const where: Prisma.AuditLogWhereInput = {
    ...(since ? { occurredAt: { gte: since } } : {}),
    ...(q
      ? { OR: [{ action: { contains: q, mode: "insensitive" } }, { actorLabel: { contains: q, mode: "insensitive" } }, { entityId: { equals: q } }] }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    db.auditLog.count({ where }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const sp = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    sp.set("page", String(p));
    return `/settings/audit?${sp}`;
  };

  return (
    <Card>
      <form className="flex flex-wrap items-center gap-2 border-b p-4" role="search">
        {Object.entries(raw).map(([k, v]) => (typeof v === "string" && k !== "q" && k !== "page" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <Input name="q" defaultValue={q} placeholder="Search action, actor or entity id…" className="max-w-sm" aria-label="Search audit log" />
        <Button type="submit" variant="outline" size="sm" className="h-9">
          Search
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">
          {total} entries · append-only (updates and deletes are rejected by the database)
        </p>
      </form>
      <CardContent className="px-0 pb-0">
        {rows.length === 0 ? (
          <EmptyState icon={ScrollText} title="No audit entries" description="Nothing matches these filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time (UTC)</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDateTime(r.occurredAt)}</TableCell>
                  <TableCell className="text-xs">
                    <Badge tone={r.actorType === "USER" ? "outline" : r.actorType === "AGENT" ? "primary" : "neutral"} className="mr-1.5">
                      {humanize(r.actorType)}
                    </Badge>
                    {r.actorLabel}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{r.action}</code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.entityType ? `${r.entityType}` : "—"}
                    {r.entityId ? <span className="block font-mono text-[11px]">{r.entityId.slice(0, 18)}</span> : null}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <code className="line-clamp-2 break-all font-mono text-[11px] text-muted-foreground">
                      {JSON.stringify(r.metadata) === "{}" ? "" : JSON.stringify(r.metadata)}
                      {r.ipAddress ? ` ip=${r.ipAddress}` : ""}
                    </code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {pages > 1 ? (
        <div className="flex items-center justify-between border-t px-5 py-3 text-xs">
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm" className={page <= 1 ? "pointer-events-none opacity-50" : ""}>
              <Link href={link(page - 1)} aria-disabled={page <= 1}>
                Previous
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className={page >= pages ? "pointer-events-none opacity-50" : ""}>
              <Link href={link(page + 1)} aria-disabled={page >= pages}>
                Next
              </Link>
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
