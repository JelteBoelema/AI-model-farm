import type { Metadata } from "next";
import Link from "next/link";
import { UserRound } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { parseFilters } from "@/lib/filters";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Character Studio" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CharactersPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const creators = await db.creator.findMany({
    where: { ...(f.creator ? { id: f.creator } : {}), status: { not: "ARCHIVED" } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      isDemo: true,
      characterProfiles: { orderBy: { version: "desc" }, select: { version: true, status: true, identityPrompt: true, _count: { select: { references: true } } } },
    },
  });

  return (
    <>
      <PageHeader title="Character Studio" description="Versioned visual identities. Generations pin a profile version so approved content never changes silently." />
      {creators.length === 0 ? (
        <Card>
          <EmptyState icon={UserRound} title="No creators" description="Create a creator first." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {creators.map((c) => {
            const approved = c.characterProfiles.find((p) => p.status === "APPROVED");
            const draft = c.characterProfiles.find((p) => p.status === "DRAFT");
            const shown = approved ?? draft;
            return (
              <Link key={c.id} href={`/characters/${c.id}`} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card className="h-full transition-colors hover:bg-accent/40">
                  <CardHeader className="flex-row items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {c.name} {c.isDemo ? <OriginBadge kind="demo" /> : null}
                      </CardTitle>
                      <CardDescription>
                        {approved ? `Version ${approved.version} approved` : "No approved version"}
                        {draft ? ` · draft v${draft.version}` : ""}
                      </CardDescription>
                    </div>
                    {shown ? <StatusBadge status={shown.status} /> : null}
                  </CardHeader>
                  <CardContent className="text-sm">
                    <p className="line-clamp-3 text-muted-foreground">{shown?.identityPrompt || "No identity defined yet."}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{shown?._count.references ?? 0} reference image(s)</p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
