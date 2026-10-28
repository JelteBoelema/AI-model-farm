import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MockConsentForm } from "@/components/social/mock-consent-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { callbackPath } from "@/server/services/social";

export const metadata: Metadata = { title: "Mock platform consent" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// Stand-in for the platform's consent screen in mock mode. Only redirects back to our own callback.
export default async function MockAuthorizePage({ searchParams }: Props) {
  await requireUser();
  if (!env().MOCK_MODE) notFound();
  const q = await searchParams;
  const state = typeof q.state === "string" ? q.state : "";
  const redirect = typeof q.redirect_uri === "string" ? q.redirect_uri : "";
  let path = "";
  try {
    path = new URL(redirect).pathname;
  } catch {
    notFound();
  }
  if (!state || path !== callbackPath("INSTAGRAM")) notFound();
  return (
    <>
      <PageHeader title="Mock platform" description="This screen stands in for Instagram's consent page in mock mode. Nothing is connected to a real account." />
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Allow Creator Farm to publish?</CardTitle>
          <CardDescription>
            The mock account receives posts in a mock feed only. A handle ending in <code>_limited</code> connects without the publishing permission.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockConsentForm state={state} callback={callbackPath("INSTAGRAM")} />
        </CardContent>
      </Card>
    </>
  );
}
