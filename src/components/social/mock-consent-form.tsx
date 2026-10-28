"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { mockConsentAction } from "@/app/(dashboard)/social/actions";

export function MockConsentForm({ state, callback }: { state: string; callback: string }) {
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (approve: boolean) =>
    start(async () => {
      if (!approve) {
        window.location.assign(`${callback}?${new URLSearchParams({ state, error: "access_denied" })}`);
        return;
      }
      const res = await mockConsentAction({ handle });
      if (!res.ok) return setError(res.error);
      window.location.assign(`${callback}?${new URLSearchParams({ state, code: res.data!.code })}`);
    });
  return (
    <div className="grid gap-3">
      <Field label="Mock account handle" htmlFor="mock-handle" hint="Lowercase letters, digits, . and _">
        <Input id="mock-handle" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} placeholder="lena.studio" />
      </Field>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button disabled={pending || handle.length < 2} onClick={() => go(true)}>
          Allow
        </Button>
        <Button variant="outline" disabled={pending} onClick={() => go(false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}
