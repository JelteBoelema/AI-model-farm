import { Beaker, CircleCheck, FlaskConical, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type DataKind = "measured" | "estimated" | "demo" | "mock";

const CONFIG: Record<DataKind, { label: string; tone: "success" | "warning" | "info" | "primary"; icon: typeof Gauge; title: string }> = {
  measured: { label: "Measured", tone: "success", icon: CircleCheck, title: "Recorded from a real provider or platform response" },
  estimated: { label: "Estimated", tone: "warning", icon: Gauge, title: "Conservative estimate; actual value may differ" },
  demo: { label: "Demo", tone: "info", icon: FlaskConical, title: "Seeded demonstration data, not real activity" },
  mock: { label: "Mock", tone: "primary", icon: Beaker, title: "Produced by a mock provider; not real generated content" },
};

export function OriginBadge({ kind }: { kind: DataKind }) {
  const c = CONFIG[kind];
  const Icon = c.icon;
  return (
    <Badge tone={c.tone} title={c.title}>
      <Icon aria-hidden />
      {c.label}
    </Badge>
  );
}
