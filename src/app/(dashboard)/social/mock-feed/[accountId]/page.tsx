import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Rss } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { storage } from "@/server/storage";

export const metadata: Metadata = { title: "Mock feed" };
type Props = { params: Promise<{ accountId: string }> };

// What the mock platform "published" for a mock account: proof that the chain ran, never a real post.
export default async function MockFeedPage({ params }: Props) {
  await requireUser();
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(accountId)) notFound();
  const account = await db.socialAccount.findUnique({ where: { id: accountId }, include: { creator: { select: { name: true } } } });
  if (!account || !account.isMock) notFound();
  const posts = await db.mockPlatformPost.findMany({ where: { socialAccountId: accountId }, orderBy: { publishedAt: "desc" }, take: 50 });
  const jobs = await db.publishingJob.findMany({ where: { externalPostId: { in: posts.map((p) => p.externalPostId) } }, include: { contentItem: { select: { id: true, title: true } } } });
  const assets = await db.mediaAsset.findMany({ where: { id: { in: jobs.flatMap((j) => j.mediaAssetIds) } } });
  const urls = new Map(await Promise.all(assets.map(async (a) => [a.id, await storage().previewUrl(a.storageKey)] as const)));

  return (
    <>
      <PageHeader title={`Mock feed · @${account.handle}`} description={`What the mock platform received for ${account.creator.name}. Nothing here was posted to a real platform.`} actions={<Link href="/social" className="text-sm underline-offset-2 hover:underline">Back to accounts</Link>} />
      {posts.length === 0 ? (
        <Card>
          <EmptyState icon={Rss} title="Nothing published yet" />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {posts.map((p) => {
            const job = jobs.find((j) => j.externalPostId === p.externalPostId);
            const media = (job?.mediaAssetIds ?? []).map((id) => assets.find((a) => a.id === id)).filter((a) => !!a);
            return (
              <Card key={p.id} id={p.externalPostId} aria-label="Mock post">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {job ? <Link href={`/content/${job.contentItem.id}`} className="hover:underline">{job.contentItem.title}</Link> : "Post"} <OriginBadge kind="mock" />
                  </CardTitle>
                  <CardDescription>{formatDateTime(p.publishedAt)} · {p.mediaKinds.join(", ")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {media[0] ? (
                    media[0].kind === "VIDEO" ? (
                      <video controls muted preload="metadata" src={`${urls.get(media[0].id)}#t=0.5`} className="aspect-[9/16] max-h-80 w-full rounded-md bg-black" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                      <img src={urls.get(media[0].id)} alt="" className="max-h-80 w-full rounded-md bg-muted object-contain" />
                    )
                  ) : null}
                  {media.length > 1 ? <p className="text-xs text-muted-foreground">+{media.length - 1} more slide(s)</p> : null}
                  <p className="whitespace-pre-wrap text-sm">{p.caption}</p>
                  <p className="font-mono text-xs text-muted-foreground">{p.externalPostId}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
