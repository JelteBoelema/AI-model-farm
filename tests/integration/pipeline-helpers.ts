// Shared helpers for tests that run the content pipeline in-process.

import { db } from "@/server/db";
import { runContentStepJob } from "@/server/services/content-pipeline";
import { STARTER_PROMPTS } from "../../prisma/starter-prompts";
import { makeCreator, uid } from "./helpers";

/** Creator with an approved character and creator-scoped copies of the starter templates. */
export async function readyCreator() {
  const creator = await makeCreator();
  await db.characterProfile.create({ data: { creatorId: creator.id, version: 1, status: "APPROVED", identityPrompt: "Synthetic adult character, short dark hair", approvedAt: new Date() } });
  for (const p of STARTER_PROMPTS.filter((t) => t.kind !== "SAFETY_RULES")) {
    await db.promptTemplate.create({
      data: {
        key: `${p.key}.${uid()}`,
        name: p.name,
        kind: p.kind,
        scope: "CREATOR",
        creatorId: creator.id,
        versions: {
          create: {
            version: 1,
            status: "PUBLISHED",
            publishedAt: new Date(),
            body: p.body,
            variablesSchema: { version: 1, variables: p.variables.map((v) => ({ label: "", required: true, description: "", options: [], ...v })) },
          },
        },
      },
    });
  }
  return creator;
}

export const signal = () => new AbortController().signal;

/** Runs queued jobs of an item in-process (as the worker would) until nothing is queued. */
export async function drain(itemId: string, attempts = 1) {
  for (let round = 0; round < 40; round++) {
    const queued = await db.generationJob.findMany({ where: { contentItemId: itemId, status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    if (queued.length === 0) return;
    for (const j of queued) {
      for (let a = 0; a < attempts; a++) {
        const res = await runContentStepJob({ data: { jobId: j.id }, attemptsMade: a, opts: { attempts } }, signal()).catch((e: unknown) => e);
        const now = await db.generationJob.findUniqueOrThrow({ where: { id: j.id } });
        if (now.status !== "QUEUED" || !(res instanceof Error)) break;
      }
    }
  }
  throw new Error("pipeline did not settle");
}

