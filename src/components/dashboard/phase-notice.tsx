import { Construction } from "lucide-react";
import { Card } from "@/components/ui/card";

/**
 * Honest module status: shows what this section will do and in which implementation phase,
 * instead of rendering controls that do nothing.
 */
export function PhaseNotice({ phase, title, items }: { phase: number; title: string; items: string[] }) {
  return (
    <Card className="border-dashed bg-muted/30 p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-md border bg-card p-2">
          <Construction className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {title} <span className="font-normal text-muted-foreground">— ships in phase {phase}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            This view already shows live database records. Editing and automation for this module are not built yet:
          </p>
          <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            {items.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden>•</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
