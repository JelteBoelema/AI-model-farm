import type { Metadata } from "next";
import { can } from "@/lib/rbac";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { requireUser } from "@/server/auth/session";
import { listApprovals } from "@/server/services/policy-admin";
import { ApprovalActions } from "./approval-actions";

export const metadata: Metadata = { title: "Approvals" };

const KIND: Record<string, string> = { BUDGET_INCREASE: "Budget increase", POLICY_CHANGE: "Looser limits", SOCIAL_ACCOUNT_LINK: "New account link" };

export default async function ApprovalsPage() {
  const user = await requireUser();
  const [pending, decided] = await Promise.all([listApprovals({ pending: true }), listApprovals({ pending: false, take: 20 })]);
  const isOwner = can(user.role, "policies:manage");

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Waiting for the owner</CardTitle>
          <CardDescription>
            Raising a hard limit, loosening autonomy and linking a new external account need the owner&apos;s explicit decision. A request whose limit changed in the
            meantime cannot be approved; ask for a new one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is waiting.</p> : null}
          <ul className="divide-y">
            {pending.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 py-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    <span className="text-muted-foreground">{KIND[a.subjectType] ?? a.subjectType}:</span> {a.summary}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Requested by {a.requestedByName ?? "the system"} on {a.createdAt.toLocaleString("nl-NL")}
                    {(a.payload as { reason?: string } | null)?.reason ? ` — “${(a.payload as { reason: string }).reason}”` : ""}
                  </p>
                </div>
                {isOwner ? <ApprovalActions approvalId={a.id} /> : <span className="text-xs text-muted-foreground">Only the owner decides</span>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent decisions</CardTitle>
        </CardHeader>
        <CardContent>
          {decided.length === 0 ? <p className="text-sm text-muted-foreground">No decisions yet.</p> : null}
          <ul className="divide-y text-sm">
            {decided.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                <StatusBadge status={a.decision} />
                <span className="text-muted-foreground">{KIND[a.subjectType] ?? a.subjectType}:</span>
                <span className="min-w-0 flex-1">{a.summary}</span>
                <span className="text-xs text-muted-foreground">
                  {a.decidedByName ?? "—"} · {a.decidedAt?.toLocaleString("nl-NL")}
                  {a.reason ? ` · ${a.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
