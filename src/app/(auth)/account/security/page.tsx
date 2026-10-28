import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { Card } from "@/components/ui/card";
import { requireUser } from "@/server/auth/session";
import { mfaRequiredFor } from "@/server/auth/mfa";
import { db } from "@/server/db";
import { MfaPanel } from "./mfa-panel";

export const metadata: Metadata = { title: "Account security" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const user = await requireUser({ allowMfaSetup: true });
  const row = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaEnabledAt: true, mfaRecoveryCodes: true } });
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <Card className="p-6">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-5" aria-hidden /> Two-factor authentication
          </h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">
            {user.mfaSetupRequired
              ? "Your role requires a second factor. Set it up to continue."
              : "A code from an authenticator app is asked for at every sign-in, after your password."}
          </p>
          <MfaPanel
            email={user.email}
            enabled={!!row.mfaEnabledAt}
            recoveryLeft={row.mfaRecoveryCodes.length}
            required={mfaRequiredFor(user.role)}
          />
        </Card>
        {!user.mfaSetupRequired ? (
          <p className="mt-4 text-center text-sm">
            <Link href="/" className="underline underline-offset-2">
              Back to the dashboard
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
