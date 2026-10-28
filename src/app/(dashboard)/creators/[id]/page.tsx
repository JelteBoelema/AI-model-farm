import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UserRound } from "lucide-react";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { BudgetAutonomyCard } from "@/components/creators/budget-autonomy-card";
import { CreatorProfileForm } from "@/components/creators/creator-profile-form";
import { CreatorStatusActions } from "@/components/creators/creator-status-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { microsToDecimalString } from "@/lib/money";
import { can } from "@/lib/rbac";
import { contentPillarSchema, publishingScheduleSchema, type CreatorProfileInput } from "@/lib/schemas/creator";
import { formatDateTime, humanize } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Creator" };

type Props = { params: Promise<{ id: string }> };

export default async function CreatorDetailPage({ params }: Props) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const user = await requireUser();
  const creator = await db.creator.findUnique({
    where: { id },
    include: {
      characterProfiles: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, approvedAt: true, _count: { select: { references: true } } } },
      socialAccounts: { select: { id: true, platform: true, handle: true, status: true } },
      _count: { select: { contentItems: true } },
    },
  });
  if (!creator) notFound();
  const budgets = await db.budgetPolicy.findMany({ where: { scope: "CREATOR", targetId: id } });
  const budgetOf = (period: "MONTH" | "DAY") => {
    const b = budgets.find((x) => x.period === period);
    return b ? microsToDecimalString(b.limitMicros) : null;
  };

  // Stored JSON may predate the current schema (e.g. demo seed data); fall back to safe defaults.
  const pillars = contentPillarSchema.array().safeParse(
    (Array.isArray(creator.contentPillars) ? creator.contentPillars : []).map((x) => (typeof x === "string" ? { name: x, description: "" } : x)),
  );
  const schedule = publishingScheduleSchema.safeParse(creator.publishingSchedule);
  const profile: CreatorProfileInput = {
    name: creator.name,
    niche: creator.niche,
    targetAudience: creator.targetAudience,
    language: creator.language,
    targetRegions: creator.targetRegions,
    personality: creator.personality,
    toneOfVoice: creator.toneOfVoice,
    backstory: creator.backstory,
    contentPillars: pillars.success && pillars.data.length ? pillars.data : [{ name: "", description: "" }],
    contentFormats: creator.contentFormats,
    timezone: creator.timezone,
    publishingSchedule: schedule.success ? schedule.data : { slots: [] },
  };

  const archived = creator.status === "ARCHIVED";
  const canEdit = can(user.role, "creators:edit") && !archived;
  const approved = creator.characterProfiles.find((p) => p.status === "APPROVED");
  const draft = creator.characterProfiles.find((p) => p.status === "DRAFT");

  return (
    <>
      <PageHeader
        title={creator.name}
        description={`@${creator.slug} · ${creator.niche}`}
        actions={
          <CreatorStatusActions
            creatorId={creator.id}
            status={creator.status}
            perms={{ edit: can(user.role, "creators:edit"), pause: can(user.role, "controls:pause"), resume: can(user.role, "controls:resume") }}
          />
        }
      />
      <div className="-mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={creator.status} />
        {creator.isDemo ? <OriginBadge kind="demo" /> : null}
        <span>Created {formatDateTime(creator.createdAt)}</span>
        <span>· {creator._count.contentItems} content item(s)</span>
        {creator.status === "DRAFT" && !approved ? <span className="text-warning">· Approve a character profile to activate</span> : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>{archived ? "Archived creators are read-only." : "Changes apply to future content only; existing items keep their snapshot."}</CardDescription>
          </CardHeader>
          <CardContent>
            <CreatorProfileForm mode="edit" creatorId={creator.id} initial={profile} readOnly={!canEdit} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Visual identity</CardTitle>
              <CardDescription>Versioned in the Character Studio.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p className="flex items-center gap-2">
                <UserRound className="size-4 text-muted-foreground" aria-hidden />
                {approved ? `Version ${approved.version} approved · ${approved._count.references} reference(s)` : "No approved version yet"}
              </p>
              {draft ? <p className="text-xs text-muted-foreground">Draft version {draft.version} in progress</p> : null}
              <Button asChild variant="outline" size="sm" className="w-fit">
                <Link href={`/characters/${creator.id}`}>Open Character Studio</Link>
              </Button>
            </CardContent>
          </Card>

          <BudgetAutonomyCard
            creatorId={creator.id}
            autonomyMode={creator.autonomyMode}
            budgets={{ MONTH: budgetOf("MONTH"), DAY: budgetOf("DAY") }}
            disabled={archived}
            perms={{
              edit: can(user.role, "creators:edit"),
              raiseAutonomy: can(user.role, "autonomy:raise"),
              lowerBudget: can(user.role, "budgets:lower"),
              raiseBudget: can(user.role, "budgets:raise"),
            }}
          />

          <Card>
            <CardHeader>
              <CardTitle>Social accounts</CardTitle>
              <CardDescription>Connected through official APIs in phase 7 (Instagram first).</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {creator.socialAccounts.length === 0 ? <p className="text-xs text-muted-foreground">None linked.</p> : null}
              {creator.socialAccounts.map((a) => (
                <p key={a.id} className="flex items-center gap-2">
                  <Badge tone="outline">{humanize(a.platform)}</Badge> @{a.handle} <StatusBadge status={a.status} />
                </p>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
