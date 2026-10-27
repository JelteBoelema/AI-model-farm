import type { Metadata } from "next";
import { UserRound } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { PhaseNotice } from "@/components/dashboard/phase-notice";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { parseFilters } from "@/lib/filters";
import { formatDateTime } from "@/lib/utils";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Character Studio" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CharactersPage({ searchParams }: Props) {
  const f = parseFilters(await searchParams);
  const profiles = await db.characterProfile.findMany({
    where: f.creator ? { creatorId: f.creator } : {},
    orderBy: [{ creatorId: "asc" }, { version: "desc" }],
    include: { creator: { select: { name: true, isDemo: true } }, _count: { select: { references: true } } },
  });

  return (
    <>
      <PageHeader title="Character Studio" description="Versioned visual identities. Generations pin a profile version so approved content never changes silently." />
      <PhaseNotice
        phase={2}
        title="Character Engine"
        items={["Structured appearance editor and identity prompt", "Canonical reference image upload and approval", "Reference-conditioned consistency tests", "Likeness attestation (synthetic, no real person)"]}
      />
      {profiles.length === 0 ? (
        <Card>
          <EmptyState icon={UserRound} title="No character profiles" />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((p) => (
            <Card key={p.id}>
              <CardHeader className="flex-row items-start justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {p.creator.name} · v{p.version} {p.creator.isDemo ? <OriginBadge kind="demo" /> : null}
                  </CardTitle>
                  <CardDescription>{p.approvedAt ? `Approved ${formatDateTime(p.approvedAt)}` : `Created ${formatDateTime(p.createdAt)}`}</CardDescription>
                </div>
                <StatusBadge status={p.status} />
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <p className="line-clamp-3 text-muted-foreground">{p.identityPrompt}</p>
                <p className="text-xs text-muted-foreground">
                  {p._count.references} reference image(s) · {p.likenessAttestation ? "likeness attested" : "no likeness attestation"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
