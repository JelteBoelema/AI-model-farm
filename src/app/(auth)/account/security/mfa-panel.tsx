"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmEnrollmentAction, disableMfaAction, regenerateRecoveryAction, startEnrollmentAction } from "./actions";

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium">Recovery codes</p>
      <p className="text-xs text-muted-foreground">Each code works once if you lose your phone. Store them somewhere safe now: they are not shown again.</p>
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button onClick={onDone}>I have saved them</Button>
    </div>
  );
}

export function MfaPanel({ email, enabled, recoveryLeft, required }: { email: string; enabled: boolean; recoveryLeft: number; required: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const finish = () => {
    setCodes(null);
    router.push("/");
    router.refresh();
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={finish} />;

  if (!enabled && !setup)
    return (
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await startEnrollmentAction();
            if (!res.ok) return void toast.error(res.error);
            setSetup(res.data);
          })
        }
      >
        Set up two-factor authentication
      </Button>
    );

  if (!enabled && setup)
    return (
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await confirmEnrollmentAction(code);
            if (!res.ok) return void toast.error(res.error);
            setCodes(res.data.codes);
          });
        }}
      >
        <ol className="grid list-decimal gap-2 pl-5 text-sm">
          <li>
            Open an authenticator app and add an account for <span className="font-medium">{email}</span> with this key (or{" "}
            <a href={setup.uri} className="underline underline-offset-2">
              open it on this phone
            </a>
            ):
            <code aria-label="Setup key" className="mt-1 block break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
              {setup.secret.match(/.{1,4}/g)!.join(" ")}
            </code>
          </li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <div className="grid gap-2">
          <Label htmlFor="mfa-code">Code</Label>
          <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <Button type="submit" disabled={pending}>
          Turn on
        </Button>
      </form>
    );

  return (
    <div className="grid gap-4">
      <p className="text-sm">
        <span className="font-medium text-success">On.</span> {recoveryLeft} unused recovery code(s) left.
      </p>
      <div className="grid gap-2">
        <Label htmlFor="mfa-manage">Current code</Label>
        <Input id="mfa-manage" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await regenerateRecoveryAction(code);
              if (!res.ok) return void toast.error(res.error);
              setCode("");
              setCodes(res.data.codes);
            })
          }
        >
          New recovery codes
        </Button>
        {!required ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await disableMfaAction(code);
                if (!res.ok) return void toast.error(res.error);
                toast.success("Two-factor authentication turned off");
                setCode("");
                router.refresh();
              })
            }
          >
            Turn off
          </Button>
        ) : null}
      </div>
    </div>
  );
}
