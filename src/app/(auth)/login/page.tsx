import type { Metadata } from "next";
import { Brand } from "@/components/layout/brand";
import { Card } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[radial-gradient(ellipse_at_top,var(--accent),transparent_60%)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">Use the account an owner created for you.</p>
          <LoginForm />
        </Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">All sign-in attempts are recorded in the audit log.</p>
      </div>
    </main>
  );
}
