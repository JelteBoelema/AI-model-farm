import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        primary: "border-primary/20 bg-primary/10 text-primary",
        success: "border-success/25 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/15 text-[color-mix(in_oklch,var(--warning)_60%,var(--foreground))]",
        danger: "border-destructive/25 bg-destructive/10 text-destructive",
        info: "border-info/25 bg-info/10 text-info",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
