import type { Metadata } from "next";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { PageHeader } from "@/components/dashboard/page-header";
import { CreatorWizard } from "@/components/creators/creator-wizard";
import { can } from "@/lib/rbac";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "New creator" };

export default async function NewCreatorPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="New creator" description="Start from a creative brief, review the proposal, then save the creator as a draft." />
      {can(user.role, "creators:edit") ? <CreatorWizard /> : <AccessDenied what="create creators" />}
    </>
  );
}
