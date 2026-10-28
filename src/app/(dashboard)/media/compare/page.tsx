import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TechnicalCheck } from "@/lib/content-pipeline";
import { formatDateTime, formatNumber } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { storage } from "@/server/storage";

export const metadata: Metadata = { title: "Compare media" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const UUID = /^[0-9a-f-]{36}$/;

export default async function CompareMediaPage({ searchParams }: Props) {
  await requireUser();
  const raw = await searchParams;
  const ids = [raw.a, raw.b].filter((v): v is string => typeof v === "string" && UUID.test(v));
  if (ids.length !== 2) notFound();
  const assets = await db.mediaAsset.findMany({ where: { id: { in: ids } }, include: { creator: { select: { name: true } }, contentItem: { select: { id: true, title: true } } } });
  if (assets.length !== 2) notFound();
  const ordered = ids.map((id) => assets.find((a) => a.id === id)!);
  const urls = await Promise.all(ordered.map((a) => storage().previewUrl(a.storageKey)));

  return (
    <>
      <PageHeader title="Compare media" description="Side by side with provenance and quality reports." actions={<Link href="/media" className="text-sm underline-offset-2 hover:underline">Back to library</Link>} />
      <div className="grid gap-4 md:grid-cols-2">
        {ordered.map((a, i) => {
          const report = a.qualityReport as { technical?: TechnicalCheck[]; issues?: { severity: string; message: string }[] } | null;
          return (
            <Card key={a.id} aria-label={`Asset ${i + 1}`}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {a.contentItem ? <Link href={`/content/${a.contentItem.id}`} className="hover:underline">{a.contentItem.title}{a.shotIndex !== null ? ` · shot ${a.shotIndex + 1}` : ""}</Link> : a.source === "UPLOADED" ? "Reference upload" : "Prompt test output"}
                  <StatusBadge status={a.status} />
                  {a.isMock ? <OriginBadge kind="mock" /> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {a.kind === "VIDEO" ? (
                  <video controls preload="metadata" src={urls[i]} className="max-h-[60vh] w-full rounded-md bg-black object-contain" aria-label={`Asset ${i + 1} player`} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                  <img src={urls[i]} alt={`Asset ${i + 1}`} className="max-h-[60vh] w-full rounded-md bg-muted object-contain" />
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Creator</dt>
                  <dd>{a.creator?.name ?? "Shared"}</dd>
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd>{a.providerKey ?? "—"} {a.modelVersion ? <span className="font-mono">({a.modelVersion})</span> : null}</dd>
                  <dt className="text-muted-foreground">Size</dt>
                  <dd>
                    {a.width}×{a.height}
                    {a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)} s` : ""} · {formatNumber(Number(a.sizeBytes))} B · {a.mimeType}
                  </dd>
                  <dt className="text-muted-foreground">Quality score</dt>
                  <dd>{a.qualityScore ?? "—"}</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{formatDateTime(a.createdAt)}</dd>
                  <dt className="text-muted-foreground">Checksum</dt>
                  <dd className="truncate font-mono">{a.checksumSha256}</dd>
                </dl>
                {a.promptSnapshot ? <p className="whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">{a.promptSnapshot}</p> : null}
                {report?.technical ? (
                  <ul className="grid gap-0.5 text-xs">
                    {report.technical.map((c) => (
                      <li key={c.check} className={c.ok ? "text-muted-foreground" : c.severity === "error" ? "text-destructive" : "text-warning"}>
                        {c.ok ? "✓" : "✗"} {c.check}: {c.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {report?.issues?.length ? <p className="text-xs">{report.issues.map((x) => `${x.severity}: ${x.message}`).join(" · ")}</p> : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
