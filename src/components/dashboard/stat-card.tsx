import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  badge,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex flex-col gap-3 p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {Icon ? <Icon className="size-4" aria-hidden /> : null}
          {label}
        </span>
        {badge}
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </Card>
  );
}
