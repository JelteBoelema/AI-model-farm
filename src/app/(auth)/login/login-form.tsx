"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, ssoSignInAction, type LoginState } from "./actions";

export function LoginForm({ sso }: { sso: { name: string } | null }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, {});
  // Controlled fields keep their values when the second step (code) is asked for.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} readOnly={state.mfa} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} readOnly={state.mfa} />
        </div>
        {state.mfa ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="otp">Authentication code</Label>
            <Input id="otp" name="otp" inputMode="numeric" autoComplete="one-time-code" required autoFocus placeholder="123456 or a recovery code" />
          </div>
        ) : null}
        {state.error ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? <Loader2 className="animate-spin" /> : null}
          {state.mfa ? "Verify" : "Sign in"}
        </Button>
      </form>
      {sso ? (
        <form action={ssoSignInAction}>
          <Button type="submit" variant="outline" className="w-full">
            Sign in with {sso.name}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
