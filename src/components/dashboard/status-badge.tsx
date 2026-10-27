import { Badge, type BadgeProps } from "@/components/ui/badge";
import { humanize } from "@/lib/utils";

type Tone = NonNullable<BadgeProps["tone"]>;

const TONES: Record<string, Tone> = {
  ACTIVE: "success",
  APPROVED: "success",
  PUBLISHED: "success",
  SUCCEEDED: "success",
  CONNECTED: "success",
  COMPLETED: "success",
  READY: "success",
  CONSUMED: "neutral",
  DRAFT: "neutral",
  IDEA: "neutral",
  ARCHIVED: "neutral",
  CANCELLED: "neutral",
  SUPERSEDED: "neutral",
  DEPRECATED: "neutral",
  RELEASED: "neutral",
  PAUSED: "warning",
  DEGRADED: "warning",
  PENDING: "warning",
  PENDING_REVIEW: "warning",
  QC_REVIEW: "warning",
  AWAITING_CONFIRMATION: "warning",
  NEEDS_MANUAL_ACTION: "warning",
  TOKEN_EXPIRED: "warning",
  INSUFFICIENT_SCOPE: "warning",
  NOT_CONFIGURED: "warning",
  NOT_CONNECTED: "neutral",
  HELD: "info",
  SCHEDULED: "info",
  QUEUED: "info",
  RUNNING: "info",
  GENERATING: "info",
  PUBLISHING: "info",
  BRIEFED: "info",
  SCRIPTED: "info",
  PROMPTED: "info",
  FAILED: "danger",
  REJECTED: "danger",
  DEAD_LETTER: "danger",
  BLOCKED_BUDGET: "danger",
  BLOCKED_POLICY: "danger",
  REVOKED: "danger",
  ERROR: "danger",
  DISABLED: "danger",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={TONES[status] ?? "neutral"} className={className}>
      {humanize(status)}
    </Badge>
  );
}
