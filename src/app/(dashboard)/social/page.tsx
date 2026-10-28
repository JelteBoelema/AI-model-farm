import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, CircleCheck, Share2 } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AccountActions, ApprovalButtons, ConnectDialog } from "@/components/social/account-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { parseFilters } from "@/lib/filters";
import { can } from "@/lib/rbac";
import { formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Social Accounts" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const FORMAT_LABELS: Record<string, string> = { IMAGE_POST: "Image post", CAROUSEL: "Carousel", STORY: "Story", SHORT_VIDEO: "Short video" };

export default async function SocialPage({ searchParams }: Props) {
  const raw = await searchParams;
  const f = parseFilters(raw);
  const user = await requireUser();
  const [accounts, creators] = await Promise.all([
    db.socialAccount.findMany({
      where: { ...(f.creator ? { creatorId: f.creator } : {}), ...(f.platform ? { platform: f.platform } : {}) },
      orderBy: [{ status: "asc" }, { handle: "asc" }],
      include: { creator: { select: { name: true, timezone: true } }, _count: { select: { mockPosts: true } } },
    }),
    db.creator.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const canConnect = can(user.role, "social:connect");
  const canApprove = can(user.role, "social:approve");
  const mockMode = env().MOCK_MODE;
  const error = typeof raw.error === "string" ? raw.error : null;
  const connected = typeof raw.connected === "string" ? accounts.find((a) => a.id === raw.connected) : undefined;

  return (
    <>
      <PageHeader
        title="Social Accounts"
        description="Only official platform APIs. Tokens live in the secrets manager; this table keeps only a reference. New links need the owner's approval."
        actions={canConnect ? <ConnectDialog creators={creators} mockMode={mockMode} /> : undefined}
      />
      {mockMode ? <p className="-mt-3 text-xs text-primary">Mock mode is on: accounts connect to the mock platform and posts go to a mock feed, never to Instagram.</p> : null}
      {error ? (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm">
          <CircleAlert className="size-4 text-destructive" aria-hidden /> {error}
        </p>
      ) : null}
      {connected ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-2 text-sm">
          <CircleCheck className="size-4 text-success" aria-hidden /> @{connected.handle} connected
          {connected.status === "PENDING_APPROVAL" ? " — waiting for the owner's approval" : ""}
        </p>
      ) : null}

      {accounts.length === 0 ? (
        <Card>
          <EmptyState icon={Share2} title="No social accounts linked" description={canConnect ? "Connect a creator's Instagram account to start publishing." : undefined} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {accounts.map((a) => {
            const caps = (a.capabilities ?? {}) as Record<string, { ok?: boolean; reason?: string }>;
            return (
              <Card key={a.id} aria-label={`@${a.handle}`}>
                <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      @{a.handle} <StatusBadge status={a.status} />
                      {a.isMock ? <OriginBadge kind="mock" /> : null}
                      {a.isDemo ? <OriginBadge kind="demo" /> : null}
                    </CardTitle>
                    <CardDescription>
                      {humanize(a.platform)} · {a.creator.name} · {a.creator.timezone}
                    </CardDescription>
                  </div>
                  {canApprove && a.status === "PENDING_APPROVAL" ? <ApprovalButtons accountId={a.id} handle={a.handle} /> : null}
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  {a.status === "PENDING_APPROVAL" && !canApprove ? <p className="text-xs text-muted-foreground">Waiting for the owner to approve this link.</p> : null}
                  {Object.keys(caps).length ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label={`@${a.handle} capabilities`}>
                      {Object.entries(caps).map(([fmt, c]) => (
                        <li key={fmt}>
                          <Badge tone={c.ok ? "success" : "warning"} title={c.reason}>
                            {FORMAT_LABELS[fmt] ?? fmt}
                            {c.ok ? "" : " — not allowed"}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <dt>Permissions</dt>
                    <dd className="truncate text-foreground">{a.grantedScopes.join(", ") || "—"}</dd>
                    <dt>Limits</dt>
                    <dd className="text-foreground">
                      {a.maxPostsPerDay} / day · {a.minGapMinutes} min apart
                    </dd>
                    <dt>Token expires</dt>
                    <dd className="text-foreground">{formatDateTime(a.tokenExpiresAt)}</dd>
                    <dt>Last verified</dt>
                    <dd className="text-foreground">{formatDateTime(a.lastVerifiedAt)}</dd>
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {canConnect ? <AccountActions accountId={a.id} handle={a.handle} connected={!!a.credentialRef} limits={{ maxPostsPerDay: a.maxPostsPerDay, minGapMinutes: a.minGapMinutes }} /> : <span />}
                    {a.isMock ? (
                      <Link href={`/social/mock-feed/${a.id}`} className="text-xs underline-offset-2 hover:underline">
                        Mock feed ({a._count.mockPosts})
                      </Link>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
