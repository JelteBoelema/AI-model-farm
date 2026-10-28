// Content Factory orchestration. Every step of an item is a separate generation job with a
// deterministic idempotency key; the job row is the source of truth and a step that succeeded is
// never executed again. Steps chain automatically: brief → shot list → caption → one image job per
// shot → quality control. Failures stop the chain at that step; resuming re-queues only the failed
// jobs, so work (and money) already spent is never repeated.

import { Prisma, type AiProvider, type ContentItem, type ContentStatus, type GenerationJob } from "@prisma/client";
import { UnrecoverableError, type Job } from "bullmq";
import type { z } from "zod";
import {
  AI_DISCLOSURE_TEXT,
  ensureDisclosure,
  PHOTO_FORMATS,
  QC_PASS_SCORE,
  STEP_JSON_SCHEMAS,
  STEP_LABELS,
  STEP_OUTPUTS,
  STEP_TEMPLATES,
  stepForStatus,
  technicalChecks,
  technicalPass,
  TEXT_STEP_SETTINGS,
  type BriefOutput,
  type FormatSpec,
  type PipelineStep,
  type QcOutput,
  type ScriptOutput,
  type TechnicalCheck,
} from "@/lib/content-pipeline";
import { assertTransition } from "@/lib/state-machines";
import { recordAudit, SYSTEM_ACTOR } from "../audit";
import { PausedError } from "../controls";
import { db } from "../db";
import { DomainError } from "../errors";
import { logger } from "../logger";
import { parseConfig, selectProvider } from "../providers/registry";
import { ProviderError, type GenerationRequest, type ReferenceImage } from "../providers/types";
import { enqueue } from "../queue/queues";
import type { QueueName } from "../queue/definitions";
import { storage } from "../storage";
import { ChargedProviderError, executeGeneration } from "./generation";
import { canonicalReferences, storeGeneratedImage } from "./media";
import { renderVersion, resolvePromptVersion } from "./prompts";
import { BudgetBlockedError } from "./spend-guard";

const QUEUE_FOR_STEP: Record<PipelineStep, QueueName> = {
  brief: "generation-text",
  script: "generation-text",
  caption: "generation-text",
  image: "generation-image",
  qc: "generation-text",
};

export const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING"] as const;
const RESUMABLE_JOB_STATUSES = ["FAILED", "BLOCKED_BUDGET", "BLOCKED_POLICY", "DEAD_LETTER"] as const;
const QC_REFERENCE_IMAGES = 2;
const QC_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ContentStepJob {
  jobId: string;
}

type ItemWithCampaign = ContentItem & { campaign: { name: string; objective: string; brief: string } | null };

export function formatSpec(item: Pick<ContentItem, "format">): FormatSpec {
  const spec = PHOTO_FORMATS[item.format];
  if (!spec) throw new DomainError(`${item.format.toLowerCase().replaceAll("_", " ")} production arrives with the video engine (phase 6)`);
  return spec;
}

export function requestedShots(item: Pick<ContentItem, "format" | "script">): number {
  const spec = formatSpec(item);
  const n = Number((item.script as { requestedShots?: unknown }).requestedShots);
  return Number.isInteger(n) ? Math.min(spec.maxShots, Math.max(spec.minShots, n)) : spec.defaultShots;
}

export function shotList(item: Pick<ContentItem, "script">): ScriptOutput["shots"] {
  const shots = (item.script as { shots?: unknown }).shots;
  return Array.isArray(shots) ? (shots as ScriptOutput["shots"]) : [];
}

function briefText(brief: unknown): string {
  const b = brief as Partial<BriefOutput>;
  return [
    b.angle && `Angle: ${b.angle}`,
    b.hook && `Hook: ${b.hook}`,
    b.key_message && `Key message: ${b.key_message}`,
    b.visual_direction && `Visual direction: ${b.visual_direction}`,
    b.pillar && `Pillar: ${b.pillar}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Compare-and-set status change: only applies when the item is still in the expected state. */
async function moveItem(tx: Prisma.TransactionClient, itemId: string, from: ContentStatus, to: ContentStatus, data: Prisma.ContentItemUpdateManyMutationInput = {}) {
  assertTransition("content", from, to);
  const { count } = await tx.contentItem.updateMany({ where: { id: itemId, status: from }, data: { ...data, status: to } });
  return count === 1;
}

async function loadItem(itemId: string): Promise<ItemWithCampaign> {
  const item = await db.contentItem.findUnique({ where: { id: itemId }, include: { campaign: { select: { name: true, objective: true, brief: true } } } });
  if (!item) throw new DomainError("Content item not found");
  return item;
}

async function resolveStepTemplate(step: PipelineStep, item: ContentItem) {
  const t = STEP_TEMPLATES[step];
  const resolved = await resolvePromptVersion({ kind: t.kind, keyPrefix: t.keyPrefix, creatorId: item.creatorId, campaignId: item.campaignId });
  if (!resolved) throw new DomainError(`No published ${t.kind.toLowerCase().replaceAll("_", " ")} template with a key starting with "${t.keyPrefix}" (Prompt Studio)`);
  return resolved.version;
}

interface NewJob {
  item: ContentItem;
  step: PipelineStep;
  key: string;
  provider: AiProvider;
  promptVersionId: string | null;
  renderedPrompt: string;
  params: Record<string, unknown>;
}

function jobData(j: NewJob): Prisma.GenerationJobUncheckedCreateInput {
  return {
    creatorId: j.item.creatorId,
    contentItemId: j.item.id,
    providerId: j.provider.id,
    promptVersionId: j.promptVersionId,
    kind: j.step === "image" ? "IMAGE" : "TEXT",
    step: j.step,
    idempotencyKey: j.key,
    renderedPrompt: j.renderedPrompt,
    params: j.params as Prisma.InputJsonValue,
    isMock: j.provider.isMock,
  };
}

async function queueJob(job: Pick<GenerationJob, "id" | "step" | "idempotencyKey" | "status" | "attempt">, resume = false) {
  if (job.status !== "QUEUED") return;
  // A resumed job gets a new queue id: the failed copy may still exist in the queue's history.
  const key = resume ? `${job.idempotencyKey}:r${job.attempt}` : job.idempotencyKey;
  await enqueue(QUEUE_FOR_STEP[job.step as PipelineStep], "content.step", { jobId: job.id } satisfies ContentStepJob, { idempotencyKey: key });
}

/** Creates the job row unless the key exists already (idempotent), then queues it. */
async function createAndQueue(j: NewJob) {
  let job = await db.generationJob.findUnique({ where: { idempotencyKey: j.key } });
  if (job) {
    await queueJob(job); // planned before; re-queuing a queued job is a no-op
    return job;
  }
  try {
    job = await db.generationJob.create({ data: jobData(j) });
  } catch (err) {
    // Lost a race with a concurrent planner.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    job = (await db.generationJob.findUnique({ where: { idempotencyKey: j.key } }))!;
  }
  await queueJob(job);
  return job;
}

async function scheduleTextStep(item: ItemWithCampaign, step: "brief" | "script" | "caption") {
  const spec = formatSpec(item);
  const version = await resolveStepTemplate(step, item);
  const shots = requestedShots(item);
  const brief = item.brief as Partial<BriefOutput>;
  const values: Record<string, Record<string, unknown>> = {
    brief: {
      format: spec.label,
      title: item.title,
      idea: item.idea || item.title,
      campaign_context: item.campaign ? [item.campaign.name, item.campaign.objective, item.campaign.brief].filter(Boolean).join(" — ") : "",
    },
    script: { shots, format: spec.label, brief: briefText(item.brief) },
    caption: { platform: "instagram", topic: brief.key_message ? `${item.title}: ${brief.key_message}` : item.title, max_chars: 2200, ai_disclosure: AI_DISCLOSURE_TEXT },
  };
  const rendered = await renderVersion(version.id, values[step]!, { creatorId: item.creatorId, campaignId: item.campaignId });
  const { row, config } = await selectProvider("TEXT");
  const settings = TEXT_STEP_SETTINGS[step];
  return createAndQueue({
    item,
    step,
    key: `content:${item.id}:${step}:1`,
    provider: row,
    promptVersionId: version.id,
    renderedPrompt: rendered.text,
    params: {
      model: (settings.bulk ? config.bulkModel : undefined) ?? config.model ?? "",
      effort: settings.effort,
      maxOutputTokens: settings.maxOutputTokens,
      system: rendered.safetyRules,
      ...(step === "script" ? { shots } : {}),
    },
  });
}

async function generationLimit(item: ContentItem): Promise<number> {
  const autonomy = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" }, select: { maxGenerationsPerItem: true } });
  return Math.min(item.maxGenerations, autonomy?.maxGenerationsPerItem ?? Number.POSITIVE_INFINITY);
}

/**
 * Queues one image job per requested shot. Moves the item to GENERATING and counts the generations
 * in the same transaction, so concurrent calls cannot exceed the item's generation limit.
 */
export async function scheduleImages(itemId: string, shotIndexes: number[] | "all", from: ContentStatus) {
  const item = await loadItem(itemId);
  const spec = formatSpec(item);
  const shots = shotList(item);
  if (shots.length === 0) throw new DomainError("This item has no shot list yet");
  const indexes = shotIndexes === "all" ? shots.map((_, i) => i) : shotIndexes;
  if (indexes.some((i) => !shots[i])) throw new DomainError("Unknown shot");
  const limit = await generationLimit(item);
  if (item.generationCount + indexes.length > limit)
    throw new DomainError(`Generation limit reached: ${item.generationCount} of ${limit} generations used for this item`);

  const version = await resolveStepTemplate("image", item);
  const { row, config } = await selectProvider("IMAGE");
  const prompts: { shot: number; text: string }[] = [];
  for (const i of indexes) {
    const rendered = await renderVersion(version.id, { scene: shots[i]!.scene, aspect_ratio: spec.aspectRatio }, { creatorId: item.creatorId, campaignId: item.campaignId });
    prompts.push({ shot: i, text: rendered.text });
  }

  const jobs = await db.$transaction(async (tx) => {
    const path: ContentStatus[] = from === "PROMPTED" ? ["PROMPTED", "GENERATING"] : [from, "PROMPTED", "GENERATING"];
    for (let k = 0; k < path.length - 1; k++) assertTransition("content", path[k]!, path[k + 1]!);
    const { count } = await tx.contentItem.updateMany({
      where: { id: item.id, status: from, generationCount: item.generationCount },
      data: { status: "GENERATING", generationCount: { increment: indexes.length }, failedStep: null, lastError: null },
    });
    if (count !== 1) throw new DomainError("The item changed meanwhile; reload and try again");
    const created: GenerationJob[] = [];
    for (const p of prompts) {
      const take = (await tx.generationJob.count({ where: { contentItemId: item.id, step: "image", params: { path: ["shot"], equals: p.shot } } })) + 1;
      created.push(
        await tx.generationJob.create({
          data: jobData({
            item,
            step: "image",
            key: `content:${item.id}:image:${p.shot}:${take}`,
            provider: row,
            promptVersionId: version.id,
            renderedPrompt: p.text,
            params: { model: config.model ?? "", shot: p.shot, take, size: spec.size, quality: config.imageQuality ?? "medium", seed: `${item.id}:${p.shot}:${take}` },
          }),
        }),
      );
    }
    return created;
  });
  for (const j of jobs) await queueJob(j);
  return jobs;
}

/** Latest take per shot (by take number). */
async function latestImageJobs(itemId: string) {
  const jobs = await db.generationJob.findMany({ where: { contentItemId: itemId, step: "image" }, orderBy: { createdAt: "asc" }, include: { mediaAssets: true } });
  const byShot = new Map<number, (typeof jobs)[number]>();
  for (const j of jobs) byShot.set(Number((j.params as { shot?: number }).shot), j);
  return byShot;
}

async function scheduleQc(item: ItemWithCampaign) {
  const version = await resolveStepTemplate("qc", item);
  const rubric = await renderVersion(version.id, {}, { creatorId: item.creatorId, campaignId: item.campaignId });
  const shots = shotList(item);
  const prompt = [
    `Review a ${formatSpec(item).label.toLowerCase()} for the AI character "${item.title}" before human approval.`,
    `Brief:\n${briefText(item.brief)}`,
    `Shots:\n${shots.map((s, i) => `${i + 1}. ${s.scene}`).join("\n")}`,
    `Caption:\n${item.caption}\nHashtags: ${item.hashtags.join(" ")}`,
    `Rubric:\n${rubric.text}`,
    "Use shot 0 for issues with the caption or the post as a whole. pass is true only when nothing in the rubric is an error.",
  ].join("\n\n");
  const { row, config } = await selectProvider("TEXT");
  const settings = TEXT_STEP_SETTINGS.qc;
  return createAndQueue({
    item,
    step: "qc",
    key: `content:${item.id}:qc:${item.generationCount}`,
    provider: row,
    promptVersionId: version.id,
    renderedPrompt: prompt,
    params: { model: config.model ?? "", effort: settings.effort, maxOutputTokens: settings.maxOutputTokens },
  });
}

/** Queues whatever comes next for the item's status. Safe to call repeatedly. */
export async function scheduleNextStep(itemId: string) {
  const item = await loadItem(itemId);
  const step = stepForStatus(item.status);
  try {
    if (step === "brief" || step === "script" || step === "caption") return await scheduleTextStep(item, step);
    if (step === "image") return (await scheduleImages(item.id, "all", "PROMPTED"))[0];
    if (item.status === "QC_REVIEW") return await scheduleQc(item);
    return null;
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await markStepFailed(item.id, step ?? "qc", err.message);
    return null;
  }
}

/** Records why the chain stopped. Image and QC failures also move the item to FAILED. */
export async function markStepFailed(itemId: string, step: PipelineStep, message: string) {
  const item = await db.contentItem.findUnique({ where: { id: itemId }, select: { status: true, title: true } });
  if (!item) return;
  await db.$transaction(async (tx) => {
    await tx.contentItem.update({ where: { id: itemId }, data: { failedStep: step, lastError: message } });
    if (step === "image" && item.status === "GENERATING") await moveItem(tx, itemId, "GENERATING", "FAILED");
    if (step === "qc" && item.status === "QC_REVIEW") await moveItem(tx, itemId, "QC_REVIEW", "FAILED");
  });
  await db.notification.create({
    data: { severity: "WARNING", type: "content.step_failed", title: `${STEP_LABELS[step]} failed: ${item.title}`, body: message.slice(0, 500), link: `/content/${itemId}` },
  });
  await recordAudit(SYSTEM_ACTOR, { action: "content.step_failed", entityType: "content_item", entityId: itemId, metadata: { step, message: message.slice(0, 300) } });
}

/** Re-queues the failed jobs of the step that stopped the chain (or re-plans it if none exist). */
export async function resumeItem(itemId: string) {
  const item = await loadItem(itemId);
  if (!item.failedStep) throw new DomainError("Nothing to resume: no step failed");
  const step = item.failedStep as PipelineStep;
  let failed = await db.generationJob.findMany({ where: { contentItemId: itemId, step, status: { in: [...RESUMABLE_JOB_STATUSES] } }, orderBy: { createdAt: "asc" } });
  if (step === "image") {
    // Only shots whose latest take failed; an older failed take that was regenerated stays as history.
    const latest = await latestImageJobs(itemId);
    const ids = new Set([...latest.values()].map((j) => j.id));
    failed = failed.filter((j) => ids.has(j.id));
  }
  if (step === "qc") failed = failed.slice(-1);

  const target: ContentStatus | null = item.status === "FAILED" ? (step === "qc" ? "QC_REVIEW" : step === "image" ? "GENERATING" : null) : null;
  if (item.status === "FAILED" && !target) throw new DomainError("This item cannot be resumed");

  if (failed.length === 0) {
    await db.$transaction(async (tx) => {
      await tx.contentItem.update({ where: { id: itemId }, data: { failedStep: null, lastError: null } });
      // A failed image step without failed jobs never started (e.g. limit reached): plan it again.
      if (target) await moveItem(tx, itemId, "FAILED", step === "image" ? "PROMPTED" : "QC_REVIEW");
    });
    return scheduleNextStep(itemId);
  }

  await db.$transaction(async (tx) => {
    for (const j of failed) {
      assertTransition("generationJob", j.status, "QUEUED");
      await tx.generationJob.update({ where: { id: j.id }, data: { status: "QUEUED", error: Prisma.DbNull } });
    }
    await tx.contentItem.update({ where: { id: itemId }, data: { failedStep: null, lastError: null } });
    if (target) await moveItem(tx, itemId, "FAILED", target);
  });
  for (const j of failed) await queueJob({ ...j, status: "QUEUED" }, true);
  return failed[0];
}

// ─────────────────────────────── Worker side ───────────────────────────────

function classify(err: unknown): { kind: string; message: string; retryable: boolean } {
  if (err instanceof ProviderError) return { kind: err.kind, message: err.message, retryable: err.retryable };
  if (err instanceof BudgetBlockedError) return { kind: "blocked_budget", message: err.message, retryable: false };
  if (err instanceof PausedError) return { kind: "paused", message: err.message, retryable: false };
  if (err instanceof DomainError) return { kind: "invalid", message: err.message, retryable: false };
  return { kind: "internal", message: "Internal error while running the step", retryable: true };
}

function parseOutput<S extends keyof typeof STEP_OUTPUTS>(step: S, text: string | undefined): z.infer<(typeof STEP_OUTPUTS)[S]> {
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    throw new ProviderError("transient", "The model returned output that is not valid JSON");
  }
  const parsed = STEP_OUTPUTS[step].safeParse(json);
  if (!parsed.success) throw new ProviderError("transient", `The model output does not match the expected structure: ${parsed.error.issues[0]?.message ?? ""}`);
  return parsed.data as z.infer<(typeof STEP_OUTPUTS)[S]>;
}

async function qcImages(item: ContentItem) {
  const latest = await latestImageJobs(item.id);
  const shots = shotList(item);
  const images: ReferenceImage[] = [];
  const assets: { shot: number; asset: NonNullable<(typeof latest extends Map<number, infer J> ? J : never)>["mediaAssets"][number] }[] = [];
  const notes: string[] = [];
  const refs = await canonicalReferences(item.creatorId, QC_REFERENCE_IMAGES);
  images.push(...refs);
  for (let i = 0; i < shots.length; i++) {
    const asset = latest.get(i)?.mediaAssets[0];
    if (!asset) continue;
    assets.push({ shot: i, asset });
    if (Number(asset.sizeBytes) > QC_MAX_IMAGE_BYTES) notes.push(`Shot ${i + 1} is larger than 5 MB and was not shown to the reviewer model`);
    else images.push({ bytes: await storage().get(asset.storageKey), mimeType: asset.mimeType });
  }
  const order = `Images: ${refs.length ? `the first ${refs.length} are approved reference photos of the character; ` : "no reference photos are available; "}then one image per shot in order (shots ${assets
    .filter((a) => Number(a.asset.sizeBytes) <= QC_MAX_IMAGE_BYTES)
    .map((a) => a.shot + 1)
    .join(", ")}).`;
  return { images, assets, notes, order, hasReferences: refs.length > 0 };
}

async function duplicateOf(assetId: string, checksum: string) {
  const dup = await db.mediaAsset.findFirst({ where: { checksumSha256: checksum, id: { not: assetId } }, select: { id: true } });
  return dup?.id ?? null;
}

export async function runContentStepJob(job: Pick<Job<ContentStepJob>, "data" | "attemptsMade" | "opts">, signal: AbortSignal) {
  const gen = await db.generationJob.findUnique({ where: { id: job.data.jobId }, include: { provider: true, mediaAssets: { select: { id: true } } } });
  if (!gen || !(ACTIVE_JOB_STATUSES as readonly string[]).includes(gen.status)) return { skipped: true };
  const step = gen.step as PipelineStep;
  const item = await loadItem(gen.contentItemId!);

  // Crash recovery: the image was stored but the job was not marked done. Never pay twice.
  if (step === "image" && gen.mediaAssets.length > 0) {
    await db.generationJob.update({ where: { id: gen.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), error: Prisma.DbNull } });
    await afterImage(item.id);
    return { recovered: true };
  }

  const attempt = gen.attempt + 1;
  if (gen.status === "QUEUED") assertTransition("generationJob", "QUEUED", "RUNNING");
  await db.generationJob.update({ where: { id: gen.id }, data: { status: "RUNNING", attempt, startedAt: gen.startedAt ?? new Date() } });

  const config = parseConfig(gen.provider.config);
  const params = gen.params as Record<string, unknown>;
  const request: GenerationRequest =
    step === "image"
      ? {
          capability: "IMAGE",
          model: String(params.model ?? config.model ?? ""),
          prompt: gen.renderedPrompt,
          referenceImages: await canonicalReferences(item.creatorId),
          params: { kind: "IMAGE", size: params.size, quality: params.quality, seed: params.seed },
        }
      : {
          capability: "TEXT",
          model: String(params.model ?? config.model ?? ""),
          prompt: gen.renderedPrompt,
          system: typeof params.system === "string" ? params.system : undefined,
          maxOutputTokens: Number(params.maxOutputTokens) || undefined,
          jsonSchema: step === "script" ? scriptSchema(Number(params.shots) || 1) : STEP_JSON_SCHEMAS[step],
          params: { kind: step.toUpperCase(), effort: params.effort },
        };
  let qcContext: Awaited<ReturnType<typeof qcImages>> | null = null;
  if (step === "qc") {
    qcContext = await qcImages(item);
    request.referenceImages = qcContext.images;
    request.prompt = `${gen.renderedPrompt}\n\n${qcContext.order}`;
  }

  let spent = gen.actualCostMicros ?? 0n;
  try {
    if (gen.provider.status === "DISABLED") throw new DomainError(`Provider ${gen.provider.displayName} is disabled`);
    const exec = await executeGeneration({
      provider: gen.provider,
      config,
      request,
      attribution: { creatorId: item.creatorId, campaignId: item.campaignId, contentItemId: item.id, generationJobId: gen.id },
      ledgerKey: `genjob:${gen.id}:${attempt}`,
      purpose: `content.${step}`,
      signal,
      checkCreatorPause: true,
    });
    spent += exec.costMicros;
    const done = { status: "SUCCEEDED" as const, finishedAt: new Date(), error: Prisma.DbNull, actualCostMicros: spent, costBasis: exec.basis, providerJobId: exec.result.providerRequestId ?? null };
    const first = exec.result.outputs[0];

    if (step === "image") {
      if (!first?.bytes) throw new ProviderError("transient", "The provider returned no image");
      await db.$transaction(async (tx) => {
        await storeGeneratedImage(
          {
            bytes: first.bytes!,
            mimeType: first.mimeType,
            creatorId: item.creatorId,
            contentItemId: item.id,
            generationJobId: gen.id,
            shotIndex: Number(params.shot),
            providerKey: gen.provider.key,
            modelVersion: exec.result.servedBy,
            prompt: gen.renderedPrompt,
            params: request.params,
            isMock: gen.provider.isMock,
          },
          tx,
        );
        await tx.generationJob.update({ where: { id: gen.id }, data: { ...done, output: { notes: exec.result.notes } } });
      });
      await afterImage(item.id);
      return { ok: true };
    }

    if (step === "qc") {
      const verdict = parseOutput("qc", first?.text);
      await finishQc(item, gen.id, verdict, qcContext!, done);
      return { ok: true };
    }

    const output = parseOutput(step, first?.text);
    const advanced = await db.$transaction(async (tx) => {
      await tx.generationJob.update({ where: { id: gen.id }, data: { ...done, output: output as Prisma.InputJsonValue } });
      if (step === "brief") return moveItem(tx, item.id, "IDEA", "BRIEFED", { brief: output as Prisma.InputJsonValue });
      if (step === "script") {
        const shots = (output as ScriptOutput).shots.slice(0, requestedShots(item));
        return moveItem(tx, item.id, "BRIEFED", "SCRIPTED", { script: { requestedShots: requestedShots(item), shots } });
      }
      const c = output as { caption: string; hashtags: string[] };
      const hashtags = [...new Set(c.hashtags.map((h) => h.replace(/^#+/, "").trim()).filter(Boolean))].slice(0, 30);
      return moveItem(tx, item.id, "SCRIPTED", "PROMPTED", { caption: item.aiDisclosure ? ensureDisclosure(c.caption, AI_DISCLOSURE_TEXT) : c.caption, hashtags });
    });
    if (advanced) await scheduleNextStep(item.id);
    return { ok: true };
  } catch (err) {
    const c = classify(err);
    if (err instanceof ChargedProviderError && err.costMicros !== null) spent += err.costMicros;
    const final = !c.retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const status = c.kind === "blocked_budget" ? "BLOCKED_BUDGET" : c.kind === "paused" ? "BLOCKED_POLICY" : final ? "FAILED" : "QUEUED";
    if (status === "QUEUED") assertTransition("generationJob", "FAILED", "QUEUED");
    else assertTransition("generationJob", "RUNNING", status);
    if (c.kind === "internal") logger.error({ jobId: gen.id, err: (err as Error).message }, "content step failed");
    await db.generationJob.update({
      where: { id: gen.id },
      data: {
        status,
        error: { kind: c.kind, message: c.message },
        ...(spent > 0n || gen.actualCostMicros !== null ? { actualCostMicros: spent, costBasis: err instanceof ChargedProviderError && err.basis ? err.basis : (gen.costBasis ?? "MEASURED") } : {}),
        ...(status !== "QUEUED" ? { finishedAt: new Date() } : {}),
      },
    });
    if (status !== "QUEUED") {
      await markStepFailed(item.id, step, c.message);
      throw new UnrecoverableError(c.message);
    }
    throw err;
  }
}

function scriptSchema(shots: number): Record<string, unknown> {
  const base = STEP_JSON_SCHEMAS.script as { properties: { shots: Record<string, unknown> } };
  return { ...base, properties: { shots: { ...base.properties.shots, minItems: shots, maxItems: shots } } };
}

/** When every shot's latest take succeeded, the item moves on to quality control. */
async function afterImage(itemId: string) {
  const item = await loadItem(itemId);
  if (item.status !== "GENERATING") return;
  const latest = await latestImageJobs(itemId);
  const shots = shotList(item);
  const allDone = shots.every((_, i) => latest.get(i)?.status === "SUCCEEDED");
  if (!allDone) return;
  const moved = await db.$transaction((tx) => moveItem(tx, itemId, "GENERATING", "QC_REVIEW", { qualityReport: Prisma.DbNull, qualityScore: null }));
  if (moved) await scheduleNextStep(itemId);
}

async function finishQc(item: ContentItem, jobId: string, verdict: QcOutput, ctx: Awaited<ReturnType<typeof qcImages>>, done: Prisma.GenerationJobUpdateInput) {
  const spec = formatSpec(item);
  const perShot: { shot: number; assetId: string; checks: TechnicalCheck[]; pass: boolean }[] = [];
  for (const { shot, asset } of ctx.assets) {
    const checks = technicalChecks(
      { mimeType: asset.mimeType, width: asset.width, height: asset.height, sizeBytes: Number(asset.sizeBytes), isMock: asset.isMock, duplicateOf: await duplicateOf(asset.id, asset.checksumSha256) },
      spec,
    );
    perShot.push({ shot, assetId: asset.id, checks, pass: technicalPass(checks) });
  }
  const identityChecked = ctx.hasReferences;
  const rubricErrors = verdict.issues.filter((i) => i.severity === "error");
  const reasons = [
    ...perShot.filter((s) => !s.pass).map((s) => `Shot ${s.shot + 1} failed technical checks`),
    ...(verdict.pass ? [] : ["Reviewer model did not pass the content"]),
    ...(verdict.score < QC_PASS_SCORE ? [`Score ${verdict.score} is below ${QC_PASS_SCORE}`] : []),
    ...(rubricErrors.length ? [`${rubricErrors.length} rubric error(s)`] : []),
    ...(identityChecked && !verdict.identity_consistent ? ["Character does not match the references"] : []),
  ];
  const pass = reasons.length === 0;
  const report = {
    pass,
    reasons,
    score: verdict.score,
    summary: verdict.summary,
    identityChecked,
    identityConsistent: verdict.identity_consistent,
    issues: verdict.issues,
    notes: ctx.notes,
    shots: perShot,
    jobId,
    checkedAt: new Date().toISOString(),
  };
  await db.$transaction(async (tx) => {
    await tx.generationJob.update({ where: { id: jobId }, data: { ...done, output: report as unknown as Prisma.InputJsonValue } });
    for (const s of perShot) {
      const shotIssues = verdict.issues.filter((i) => i.shot === s.shot + 1);
      await tx.mediaAsset.update({
        where: { id: s.assetId },
        data: { qualityScore: verdict.score, qualityReport: { technical: s.checks, pass: s.pass, issues: shotIssues } as unknown as Prisma.InputJsonValue },
      });
    }
    await tx.contentItem.update({ where: { id: item.id }, data: { qualityReport: report as unknown as Prisma.InputJsonValue, qualityScore: verdict.score } });
    if (pass) await moveItem(tx, item.id, "QC_REVIEW", "READY");
  });
}

export const contentProcessors = {
  "content.step": (job: Job<ContentStepJob>, signal: AbortSignal) => runContentStepJob(job, signal),
};
