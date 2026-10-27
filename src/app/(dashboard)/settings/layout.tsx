import { PageHeader } from "@/components/dashboard/page-header";
import { SettingsNav } from "./settings-nav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Settings & Audit" description="Kill switches, user access and the immutable audit trail." />
      <SettingsNav />
      {children}
    </>
  );
}
