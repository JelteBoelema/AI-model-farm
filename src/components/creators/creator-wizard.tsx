"use client";

import { useState, useTransition } from "react";
import { Beaker, Sparkles } from "lucide-react";
import { OriginBadge } from "@/components/dashboard/origin-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CharacterDraftInput, CreatorProfileInput } from "@/lib/schemas/creator";
import { proposeCreatorAction } from "@/app/(dashboard)/creators/actions";
import { CreatorProfileForm } from "./creator-profile-form";

interface Proposal {
  profile: CreatorProfileInput;
  character: CharacterDraftInput;
  source: { generator: string; isMock: boolean };
}

export function CreatorWizard() {
  const [brief, setBrief] = useState("");
  const [language, setLanguage] = useState("nl-NL");
  const [regions, setRegions] = useState("NL");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function propose(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await proposeCreatorAction({ brief, language, regions: regions.split(/[,\s]+/).filter(Boolean) });
      if (res.ok) setProposal(res.data as Proposal);
      else setError(res.error);
    });
  }

  if (proposal || manual) {
    return (
      <div className="grid gap-4">
        {proposal ? (
          <Card className={proposal.source.isMock ? "border-primary/30 bg-primary/5" : ""}>
            <CardContent className="flex flex-wrap items-start gap-3 p-4 text-sm">
              {proposal.source.isMock ? <Beaker className="mt-0.5 size-4 text-primary" aria-hidden /> : <Sparkles className="mt-0.5 size-4 text-primary" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  Proposal from {proposal.source.generator} {proposal.source.isMock ? <OriginBadge kind="mock" /> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {proposal.source.isMock
                    ? "This is template text from the mock generator, marked [Mock]. Real proposals use Claude once the text provider is connected (phase 4). Review every field before saving."
                    : "Review and adjust every field before saving."}{" "}
                  A draft character version 1 is created together with the creator.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setProposal(null)}>
                Back to brief
              </Button>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardContent className="p-5">
            <CreatorProfileForm
              mode="create"
              initial={proposal?.profile}
              character={proposal?.character}
              proposalSource={proposal ? `${proposal.source.generator}${proposal.source.isMock ? ":mock" : ""}` : "manual"}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Creative brief</CardTitle>
        <CardDescription>Describe the creator you want: niche, audience, style, platforms. The wizard proposes a complete, editable profile.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={propose} className="grid gap-4">
          <Field label="Brief" htmlFor="brief" hint="At least 20 characters. Do not describe or name real people.">
            <Textarea id="brief" value={brief} onChange={(e) => setBrief(e.target.value)} className="min-h-36" maxLength={4000} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Language" htmlFor="brief-language">
              <Input id="brief-language" value={language} onChange={(e) => setLanguage(e.target.value)} />
            </Field>
            <Field label="Regions" htmlFor="brief-regions">
              <Input id="brief-regions" value={regions} onChange={(e) => setRegions(e.target.value)} />
            </Field>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setManual(true)}>
              Fill in manually
            </Button>
            <Button type="submit" disabled={pending}>
              <Sparkles /> Propose profile
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
