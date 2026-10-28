// Executes queued prompt test runs on the generation workers.

import { UnrecoverableError, type Job } from "bullmq";
import type { CostBasis } from "@prisma/client";
import { PausedError } from "@/server/controls";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { logger } from "@/server/logger";
import { parseConfig } from "@/server/providers/registry";
import { ProviderError, type GenerationRequest } from "@/server/providers/types";
import { ChargedProviderError, executeGeneration } from "@/server/services/generation";
import { BudgetBlockedError } from "@/server/services/spend-guard";
import { canonicalReferences, storeGeneratedImage } from "@/server/services/media";

export interface PromptTestJob {
  runId: string;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "RENDERED"]);

function classify(err: unknown): { kind: string; message: string; retryable: boolean } {
  if (err instanceof ProviderError) return { kind: err.kind, message: err.message, retryable: err.retryable };
  if (err instanceof BudgetBlockedError) return { kind: "blocked_budget", message: err.message, retryable: false };
  if (err instanceof PausedError) return { kind: "paused", message: err.message, retryable: false };
  if (err instanceof DomainError) return { kind: "invalid", message: err.message, retryable: false };
  return { kind: "internal", message: "Internal error while running the test", retryable: true };
}

export async function runPromptTestJob(job: Pick<Job<PromptTestJob>, "data" | "attemptsMade" | "opts">, signal: AbortSignal) {
  const run = await db.promptTestRun.findUnique({ where: { id: job.data.runId }, include: { promptVersion: { include: { template: true } } } });
  if (!run || TERMINAL.has(run.status)) return { skipped: true };
  const provider = run.providerId ? await db.aiProvider.findUnique({ where: { id: run.providerId } }) : null;
  if (!provider) {
    await db.promptTestRun.update({ where: { id: run.id }, data: { status: "FAILED", errorKind: "invalid", error: "Provider no longer exists", finishedAt: new Date() } });
    return { failed: true };
  }
  const attempt = run.attempts + 1;
  const startedAt = run.startedAt ?? new Date();
  await db.promptTestRun.update({ where: { id: run.id }, data: { status: "RUNNING", attempts: attempt, startedAt } });

  const config = parseConfig(provider.config);
  const template = run.promptVersion.template;
  const params = run.promptVersion.defaultParams as Record<string, unknown>;
  const capability = template.kind === "IMAGE" ? "IMAGE" : "TEXT";
  const request: GenerationRequest = {
    capability,
    model: run.model ?? config.model ?? "",
    prompt: run.renderedPrompt,
    system: capability === "TEXT" ? (run.safetyRules ?? undefined) : undefined,
    maxOutputTokens: capability === "TEXT" ? 4_000 : undefined,
    referenceImages: capability === "IMAGE" && run.creatorId ? await canonicalReferences(run.creatorId) : undefined,
    params: {
      kind: template.kind,
      ...(capability === "IMAGE" ? { size: params.size ?? config.imageSize ?? "1024x1536", quality: params.quality ?? config.imageQuality ?? "medium" } : {}),
    },
  };

  try {
    const exec = await executeGeneration({
      provider,
      config,
      request,
      attribution: { creatorId: run.creatorId, campaignId: run.campaignId },
      ledgerKey: `prompt-test:${run.id}:${attempt}`,
      purpose: "prompt_test",
      signal,
    });
    let outputMediaId: string | null = null;
    let output: string | null = null;
    const first = exec.result.outputs[0];
    if (first?.kind === "image" && first.bytes) {
      const asset = await storeGeneratedImage({
        bytes: first.bytes,
        mimeType: first.mimeType,
        creatorId: run.creatorId,
        providerKey: provider.key,
        modelVersion: exec.result.servedBy,
        prompt: run.renderedPrompt,
        params: request.params,
        isMock: provider.isMock,
      });
      outputMediaId = asset.id;
    } else {
      output = first?.text ?? "";
    }
    await db.promptTestRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        output,
        outputMediaId,
        model: exec.result.servedBy,
        costMicros: exec.costMicros,
        costBasis: exec.basis,
        error: null,
        errorKind: null,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      },
    });
    return { ok: true };
  } catch (err) {
    const c = classify(err);
    const final = !c.retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const charged = err instanceof ChargedProviderError ? { costMicros: err.costMicros, costBasis: err.basis as CostBasis | null } : null;
    if (c.kind === "internal") logger.error({ runId: run.id, err: (err as Error).message }, "prompt test failed");
    await db.promptTestRun.update({
      where: { id: run.id },
      data: {
        status: final ? "FAILED" : "QUEUED",
        errorKind: c.kind,
        error: c.message,
        ...(final
          ? {
              finishedAt: new Date(),
              durationMs: Date.now() - startedAt.getTime(),
              // Blocked before any call: known zero. Provider failures: charged amount if any, else unknown.
              ...(charged ?? (["blocked_budget", "paused", "invalid", "invalid_input"].includes(c.kind) ? { costMicros: 0n, costBasis: "MEASURED" as const } : {})),
            }
          : {}),
      },
    });
    if (final) throw new UnrecoverableError(c.message);
    throw err;
  }
}

export const promptTestProcessors = {
  "prompt-test.run": (job: Job<PromptTestJob>, signal: AbortSignal) => runPromptTestJob(job, signal),
};
