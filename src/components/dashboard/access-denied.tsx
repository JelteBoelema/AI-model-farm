import { ShieldAlert } from "lucide-react";
import { EmptyState } from "./empty-state";

export function AccessDenied({ what }: { what: string }) {
  return <EmptyState icon={ShieldAlert} title="Access denied" description={`Your role does not allow you to ${what}.`} />;
}
