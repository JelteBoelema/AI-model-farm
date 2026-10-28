// Content Factory orchestration. Every step of an item is a separate generation job with a
// deterministic idempotency key; the job row is the source of truth and a step that succeeded is
// never executed again. Steps chain automatically:
//   photos: brief → shot list → caption → one image job per shot → quality control
//   video:  brief → storyboard → caption → voice-over + clip per scene → assembly → quality control
// Failures stop the chain at that step; resuming re-queues only the failed jobs, so work (and money)
// already spent is never repeated. Regenerating one shot or scene creates a new take for that shot
// only; the other shots keep their takes.

import { Prisma, type AiProvider, type ContentItem, type ContentStatus, type GenerationJob, type GenerationKind, type MediaAsset } from "@prisma/client";
import { UnrecoverableError, type Job } from "bullmq";
import type { z } from "zod";
import {
  AI_DISCLOSURE_TEXT,
  buildCues,
  cueProblems,
  ensureDisclosure,
  FORMAT_SPECS,
  QC_PASS_SCORE,
  STEP_JSON_SCHEMAS,
  STEP_OUTPUTS,
  stepForStatus,
  stepLabel,
  stepTemplate,
  storyboardSchema,
  technicalChecks,
  technicalPass,
  TEXT_STEP_SETTINGS,
  toVtt,
  videoTechnicalChecks,
  type BriefOutput,
  type FormatSpec,
  type PhotoSpec,
  type PipelineStep,
  type QcOutput,
  type ScriptOutput,
  type TechnicalCheck,
  type TemplatedStep,
  type TextStep,
  type VideoSpec,
} from "@/lib/content-pipeline";
import { parseVariableDefs } from "@/lib/schemas/prompt";
import { assertTransition } from "@/lib/state-machines";
import { recordAudit, SYSTEM_ACTOR } from "../audit";
import { PausedError } from "../controls";
import { db } from "../db";
import { DomainError } from "../errors";
import { logger } from "../logger";
import { assembleVideo, extractFrame, FfmpegError, probe } from "../media/ffmpeg";
import { createAdapter, LocalRateLimitError, parseConfig, selectProvider } from "../providers/registry";
import { ProviderError, type GenerationRequest, type ReferenceImage } from "../providers/types";
import { enqueue } from "../queue/queues";
import { QUEUES, type QueueName } from "../queue/definitions";
import { storage } from "../storage";
import { abandonGeneration, ChargedProviderError, executeGeneration, pollGeneration, submitGeneration, type ExecuteResult } from "./generation";
import { canonicalReferences, storeGeneratedImage, storeMedia } from "./media";
import { renderVersion, resolvePromptVersion } from "./prompts";
import { attemptsFor, effectivePolicy } from "./policy";
import { BudgetBlockedError } from "./spend-guard";

const QUEUE_FOR_STEP: Record<PipelineStep, QueueName> = {
  brief: "generation-text",
  script: "generation-text",
  caption: "generation-text",
  image: "generation-image",
  voice: "generation-video",
  scene: "generation-video",
  assemble: "media-processing",
  qc: "generation-text",
};

const KIND_FOR_STEP: Record<PipelineStep, GenerationKind> = {
  brief: "TEXT",
  script: "TEXT",
  caption: "TEXT",
  image: "IMAGE",
  voice: "SPEECH",
  scene: "VIDEO",
  assemble: "MEDIA_PROCESSING",
  qc: "TEXT",
};

/** Steps that produce one take per shot / scene. */
const TAKE_STEPS = ["image", "scene", "voice"] as const;
type TakeStep = (typeof TAKE_STEPS)[number];
const isTakeStep = (s: string): s is TakeStep => (TAKE_STEPS as readonly string[]).includes(s);
/** Steps that run while the item is GENERATING (their failure moves the item to FAILED). */
const GENERATING_STEPS: PipelineStep[] = ["image", "scene", "voice", "assemble"];

export const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING"] as const;
const RESUMABLE_JOB_STATUSES = ["FAILED", "BLOCKED_BUDGET", "BLOCKED_POLICY", "DEAD_LETTER"] as const;
const QC_REFERENCE_IMAGES = 2;
const QC_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Long-running video jobs: how often to ask the provider, and when to give up. */
export const POLL_INTERVAL_MS = 15_000;
export const MAX_ASYNC_WAIT_MS = 30 * 60_000;

export interface ContentStepJob {
  jobId: string;
}

type ItemWithCampaign = ContentItem & { campaign: { name: string; objective: string; brief: string } | null };

export function formatSpec(item: Pick<ContentItem, "format">): FormatSpec {
  const spec = FORMAT_SPECS[item.format];
  if (!spec) throw new DomainError(`${item.format.toLowerCase().replaceAll("_", " ")} production needs a lip-sync provider, which has not been selected yet`);
  return spec;
}

export function requestedShots(item: Pick<ContentItem, "format" | "script">): number {
  const spec = formatSpec(item);
  const n = Number((item.script as { requestedShots?: unknown }).requestedShots);
  return Number.isInteger(n) ? Math.min(spec.maxShots, Math.max(spec.minShots, n)) : spec.defaultShots;
}

/** Photos of a photo item, or scenes (visual + action) of a video item. */
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

/**
 * Renders a step template with the pipeline's values. Templates may declare only the variables they
 * need (a customised template can drop or add optional ones), so undeclared values are left out.
 */
async function renderStep(version: { id: string; variablesSchema: unknown }, values: Record<string, unknown>, item: ContentItem) {
  const declared = new Set(parseVariableDefs(version.variablesSchema).map((d) => d.name));
  return renderVersion(version.id, Object.fromEntries(Object.entries(values).filter(([k]) => declared.has(k))), { creatorId: item.creatorId, campaignId: item.campaignId });
}

async function resolveStepTemplate(step: TemplatedStep, item: ContentItem) {
  const t = stepTemplate(step, formatSpec(item).kind);
  const resolved = await resolvePromptVersion({ kind: t.kind, keyPrefix: t.keyPrefix, creatorId: item.creatorId, campaignId: item.campaignId });
  if (!resolved) throw new DomainError(`No published ${t.kind.toLowerCase().replaceAll("_", " ")} template with a key starting with "${t.keyPrefix}" (Prompt Studio)`);
  return resolved.version;
}

interface NewJob {
  item: ContentItem;
  step: PipelineStep;
  key: string;
  provider: AiProvider | null;
  promptVersionId: string | null;
  renderedPrompt: string;
  params: Record<string, unknown>;
}

function jobData(j: NewJob): Prisma.GenerationJobUncheckedCreateInput {
  return {
    creatorId: j.item.creatorId,
    contentItemId: j.item.id,
    providerId: j.provider?.id ?? null,
    promptVersionId: j.promptVersionId,
    kind: KIND_FOR_STEP[j.step],
    step: j.step,
    idempotencyKey: j.key,
    renderedPrompt: j.renderedPrompt,
    params: j.params as Prisma.InputJsonValue,
    isMock: j.provider?.isMock ?? false,
  };
}

async function queueJob(job: Pick<GenerationJob, "id" | "step" | "idempotencyKey" | "status" | "attempt" | "creatorId">, opts: { suffix?: string; delayMs?: number } = {}) {
  if (job.status !== "QUEUED" && !opts.suffix?.startsWith("poll") && !opts.suffix?.startsWith("wait")) return;
  // Resumed jobs, polls and deferred jobs get a new queue id: earlier copies may still exist in the queue's history.
  const key = opts.suffix ? `${job.idempotencyKey}:${opts.suffix}` : job.idempotencyKey;
  const queue = QUEUE_FOR_STEP[job.step as PipelineStep];
  // The policy's retry limit caps the queue's attempts.
  const attempts = attemptsFor(QUEUES[queue].attempts, await effectivePolicy({ creatorId: job.creatorId }));
  await enqueue(queue, "content.step", { jobId: job.id } satisfies ContentStepJob, { idempotencyKey: key, attempts, ...(opts.delayMs ? { delay: opts.delayMs } : {}) });
}

/** How long a job waits before trying again when the concurrency limit is reached. */
export const CONCURRENCY_WAIT_MS = 15_000;

/**
 * Policy checks before a step runs. Returns "wait" when the concurrency limit is reached (the job
 * is deferred, not failed); throws a PolicyBlockedError when a hard limit stops the chain.
 */
async function checkPolicy(item: ContentItem, step: PipelineStep): Promise<"run" | "wait"> {
  const policy = await effectivePolicy({ creatorId: item.creatorId, campaignId: item.campaignId });
  if (policy.maxWorkflowMinutes !== null && item.productionStartedAt) {
    const minutes = (Date.now() - item.productionStartedAt.getTime()) / 60_000;
    if (minutes > policy.maxWorkflowMinutes)
      throw new PolicyBlockedError(`Production of this item ran for ${Math.round(minutes)} minutes, over the ${policy.maxWorkflowMinutes}-minute workflow limit (${(policy.source.maxWorkflowMinutes ?? "GLOBAL").toLowerCase()} policy)`);
  }
  if (policy.maxConcurrentJobs !== null && step !== "assemble") {
    const scoped = policy.source.maxConcurrentJobs === "CREATOR" ? { creatorId: item.creatorId } : policy.source.maxConcurrentJobs === "CAMPAIGN" ? { contentItem: { campaignId: item.campaignId } } : {};
    const running = await db.generationJob.count({ where: { status: "RUNNING", providerJobId: null, ...scoped } });
    if (running >= policy.maxConcurrentJobs) return "wait";
  }
  return "run";
}

export class PolicyBlockedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "PolicyBlockedError";
  }
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
  const topic = brief.key_message ? `${item.title}: ${brief.key_message}` : item.title;
  const values: Record<string, Record<string, unknown>> = {
    brief: {
      format: spec.label,
      title: item.title,
      idea: item.idea || item.title,
      campaign_context: item.campaign ? [item.campaign.name, item.campaign.objective, item.campaign.brief].filter(Boolean).join(" — ") : "",
    },
    // Photo shot lists and video storyboards receive the same values; each template uses what it declares.
    script: { shots, scenes: shots, format: spec.label, brief: briefText(item.brief), topic, hook: true, duration_seconds: Math.min(90, shots * 6) },
    caption: { platform: "instagram", topic, max_chars: 2200, ai_disclosure: AI_DISCLOSURE_TEXT },
  };
  const rendered = await renderStep(version, values[step]!, item);
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
      ...(step === "script" ? { shots, format: spec.kind } : {}),
    },
  });
}

async function generationLimit(item: ContentItem): Promise<number> {
  const policy = await effectivePolicy({ creatorId: item.creatorId, campaignId: item.campaignId });
  return Math.min(item.maxGenerations, policy.maxGenerationsPerItem ?? Number.POSITIVE_INFINITY);
}

interface PlannedTake {
  step: TakeStep;
  shot: number;
  prompt: string;
  provider: AiProvider;
  promptVersionId: string | null;
  params: Record<string, unknown>;
}

/** Image prompts for photo shots. */
async function planImages(item: ItemWithCampaign, spec: PhotoSpec, indexes: number[]): Promise<PlannedTake[]> {
  const shots = shotList(item);
  const version = await resolveStepTemplate("image", item);
  const { row, config } = await selectProvider("IMAGE");
  const planned: PlannedTake[] = [];
  for (const i of indexes) {
    const rendered = await renderStep(version, { scene: shots[i]!.scene, aspect_ratio: spec.aspectRatio }, item);
    planned.push({ step: "image", shot: i, prompt: rendered.text, provider: row, promptVersionId: version.id, params: { model: config.model ?? "", size: spec.size, quality: config.imageQuality ?? "medium" } });
  }
  return planned;
}

/** Clip prompts per scene, plus the voice-over of scenes that have none yet. */
async function planScenes(item: ItemWithCampaign, indexes: number[]): Promise<PlannedTake[]> {
  const scenes = await db.videoScene.findMany({ where: { contentItemId: item.id }, orderBy: { position: "asc" } });
  const version = await resolveStepTemplate("scene", item);
  const video = await selectProvider("VIDEO");
  const planned: PlannedTake[] = [];
  const needsVoice = scenes.some((s, i) => indexes.includes(i) && s.dialogue.trim());
  const voices = needsVoice ? await db.generationJob.findMany({ where: { contentItemId: item.id, step: "voice", status: { in: ["QUEUED", "RUNNING", "SUCCEEDED"] } }, select: { params: true } }) : [];
  const speech = needsVoice ? await selectProvider("SPEECH") : null;
  const creator = needsVoice ? await db.creator.findUnique({ where: { id: item.creatorId }, select: { promptSettings: true } }) : null;
  for (const i of indexes) {
    const s = scenes[i];
    if (!s) throw new DomainError("Unknown scene");
    const rendered = await renderStep(version, { scene: s.prompt, action: s.action }, item);
    planned.push({
      step: "scene",
      shot: i,
      prompt: rendered.text,
      provider: video.row,
      promptVersionId: version.id,
      params: { model: video.config.model ?? "", durationSeconds: Math.round(s.durationMs / 1000), aspectRatio: "9:16", label: `SCENE ${i + 1}`, negativePrompt: "" },
    });
    // A scene's voice-over depends on its text only: a new clip keeps the existing voice.
    if (s.dialogue.trim() && speech && !voices.some((v) => (v.params as { shot?: number }).shot === i)) {
      const voiceId = (creator?.promptSettings as { voiceId?: unknown } | null)?.voiceId;
      planned.push({ step: "voice", shot: i, prompt: s.dialogue.trim(), provider: speech.row, promptVersionId: null, params: { model: speech.config.model ?? "", voiceId: typeof voiceId === "string" ? voiceId : (speech.config.voiceId ?? null) } });
    }
  }
  return planned;
}

/**
 * Queues new takes (images or scene clips) for the given shots. Moves the item to GENERATING and
 * counts the visual generations in the same transaction, so concurrent calls cannot exceed the
 * item's generation limit. Voice-overs do not count as generations.
 */
export async function scheduleTakes(itemId: string, shotIndexes: number[] | "all", from: ContentStatus) {
  const item = await loadItem(itemId);
  const spec = formatSpec(item);
  const shots = shotList(item);
  if (shots.length === 0) throw new DomainError(spec.kind === "video" ? "This item has no storyboard yet" : "This item has no shot list yet");
  const indexes = shotIndexes === "all" ? shots.map((_, i) => i) : shotIndexes;
  if (indexes.some((i) => !shots[i])) throw new DomainError(spec.kind === "video" ? "Unknown scene" : "Unknown shot");
  const limit = await generationLimit(item);
  if (item.generationCount + indexes.length > limit)
    throw new DomainError(`Generation limit reached: ${item.generationCount} of ${limit} generations used for this item`);

  const planned = spec.kind === "video" ? await planScenes(item, indexes) : await planImages(item, spec, indexes);

  const jobs = await db.$transaction(async (tx) => {
    const path: ContentStatus[] = from === "PROMPTED" ? ["PROMPTED", "GENERATING"] : [from, "PROMPTED", "GENERATING"];
    for (let k = 0; k < path.length - 1; k++) assertTransition("content", path[k]!, path[k + 1]!);
    const { count } = await tx.contentItem.updateMany({
      where: { id: item.id, status: from, generationCount: item.generationCount },
      data: { status: "GENERATING", generationCount: { increment: indexes.length }, failedStep: null, lastError: null },
    });
    if (count !== 1) throw new DomainError("The item changed meanwhile; reload and try again");
    const created: GenerationJob[] = [];
    for (const p of planned) {
      const take = (await tx.generationJob.count({ where: { contentItemId: item.id, step: p.step, params: { path: ["shot"], equals: p.shot } } })) + 1;
      created.push(
        await tx.generationJob.create({
          data: jobData({
            item,
            step: p.step,
            key: `content:${item.id}:${p.step}:${p.shot}:${take}`,
            provider: p.provider,
            promptVersionId: p.promptVersionId,
            renderedPrompt: p.prompt,
            params: { ...p.params, shot: p.shot, take, seed: `${item.id}:${p.shot}:${take}` },
          }),
        }),
      );
    }
    return created;
  });
  for (const j of jobs) await queueJob(j);
  return jobs;
}

type JobWithMedia = GenerationJob & { mediaAssets: MediaAsset[] };

/** Latest take per shot for a step. */
async function latestJobs(itemId: string, step: TakeStep): Promise<Map<number, JobWithMedia>> {
  const jobs = await db.generationJob.findMany({ where: { contentItemId: itemId, step }, orderBy: { createdAt: "asc" }, include: { mediaAssets: true } });
  const byShot = new Map<number, JobWithMedia>();
  for (const j of jobs) byShot.set(Number((j.params as { shot?: number }).shot), j);
  return byShot;
}

/** The final, assembled video of an item (latest assembly). */
export async function finalVideo(itemId: string) {
  return db.mediaAsset.findFirst({ where: { contentItemId: itemId, kind: "VIDEO", shotIndex: null, source: "DERIVED" }, orderBy: { createdAt: "desc" } });
}

async function scheduleAssembly(item: ItemWithCampaign) {
  return createAndQueue({ item, step: "assemble", key: `content:${item.id}:assemble:${item.generationCount}`, provider: null, promptVersionId: null, renderedPrompt: "", params: {} });
}

async function scheduleQc(item: ItemWithCampaign) {
  const spec = formatSpec(item);
  const version = await resolveStepTemplate("qc", item);
  const rubric = await renderVersion(version.id, {}, { creatorId: item.creatorId, campaignId: item.campaignId });
  const shots = shotList(item);
  const scenes = spec.kind === "video" ? await db.videoScene.findMany({ where: { contentItemId: item.id }, orderBy: { position: "asc" } }) : [];
  const listing =
    spec.kind === "video"
      ? `Scenes:\n${scenes.map((s, i) => `${i + 1}. ${s.prompt} (${s.durationMs / 1000} s) — voice-over: "${s.dialogue}"`).join("\n")}`
      : `Shots:\n${shots.map((s, i) => `${i + 1}. ${s.scene}`).join("\n")}`;
  const prompt = [
    `Review a ${spec.label.toLowerCase()} for the AI character "${item.title}" before human approval.`,
    `Brief:\n${briefText(item.brief)}`,
    listing,
    `Caption:\n${item.caption}\nHashtags: ${item.hashtags.join(" ")}`,
    `Rubric:\n${rubric.text}`,
    `Use ${spec.kind === "video" ? "scene" : "shot"} 0 (field "shot") for issues with the caption or the post as a whole. pass is true only when nothing in the rubric is an error.`,
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
  const kind = formatSpec(item).kind;
  const step = stepForStatus(item.status, kind);
  try {
    if (step === "brief" || step === "script" || step === "caption") return await scheduleTextStep(item, step);
    if (step === "image" || step === "scene") return (await scheduleTakes(item.id, "all", "PROMPTED"))[0];
    if (item.status === "GENERATING" && kind === "video") return await scheduleAssembly(item);
    if (item.status === "QC_REVIEW") return await scheduleQc(item);
    return null;
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await markStepFailed(item.id, step ?? (item.status === "GENERATING" ? "assemble" : "qc"), err.message);
    return null;
  }
}

/** Records why the chain stopped. Generating and QC failures also move the item to FAILED. */
export async function markStepFailed(itemId: string, step: PipelineStep, message: string) {
  const item = await db.contentItem.findUnique({ where: { id: itemId }, select: { status: true, title: true, format: true } });
  if (!item) return;
  await db.$transaction(async (tx) => {
    await tx.contentItem.update({ where: { id: itemId }, data: { failedStep: step, lastError: message } });
    if (GENERATING_STEPS.includes(step) && item.status === "GENERATING") await moveItem(tx, itemId, "GENERATING", "FAILED");
    if (step === "qc" && item.status === "QC_REVIEW") await moveItem(tx, itemId, "QC_REVIEW", "FAILED");
  });
  const label = stepLabel(step, FORMAT_SPECS[item.format]?.kind ?? "photo");
  await db.notification.create({
    data: { severity: "WARNING", type: "content.step_failed", title: `${label} failed: ${item.title}`, body: message.slice(0, 500), link: `/content/${itemId}` },
  });
  await recordAudit(SYSTEM_ACTOR, { action: "content.step_failed", entityType: "content_item", entityId: itemId, metadata: { step, message: message.slice(0, 300) } });
}

/** Re-queues the failed jobs of the step that stopped the chain (or re-plans it if none exist). */
export async function resumeItem(itemId: string) {
  const item = await loadItem(itemId);
  if (!item.failedStep) throw new DomainError("Nothing to resume: no step failed");
  const step = item.failedStep as PipelineStep;
  // Takes of every shot share the generating phase: resume all failed takes, not only the first step's.
  const steps: PipelineStep[] = isTakeStep(step) ? [...TAKE_STEPS] : [step];
  let failed = await db.generationJob.findMany({ where: { contentItemId: itemId, step: { in: steps }, status: { in: [...RESUMABLE_JOB_STATUSES] } }, orderBy: { createdAt: "asc" } });
  if (isTakeStep(step)) {
    // Only shots whose latest take failed; an older failed take that was regenerated stays as history.
    const latest = new Set<string>();
    for (const s of TAKE_STEPS) for (const j of (await latestJobs(itemId, s)).values()) latest.add(j.id);
    failed = failed.filter((j) => latest.has(j.id));
  }
  if (step === "qc" || step === "assemble") failed = failed.slice(-1);

  const target: ContentStatus | null = item.status === "FAILED" ? (step === "qc" ? "QC_REVIEW" : GENERATING_STEPS.includes(step) ? "GENERATING" : null) : null;
  if (item.status === "FAILED" && !target) throw new DomainError("This item cannot be resumed");

  if (failed.length === 0) {
    await db.$transaction(async (tx) => {
      await tx.contentItem.update({ where: { id: itemId }, data: { failedStep: null, lastError: null } });
      // A failed step without failed jobs never started (e.g. limit reached): plan it again.
      if (target) await moveItem(tx, itemId, "FAILED", isTakeStep(step) ? "PROMPTED" : target);
    });
    return scheduleNextStep(itemId);
  }

  await db.$transaction(async (tx) => {
    for (const j of failed) {
      assertTransition("generationJob", j.status, "QUEUED");
      // A long-running job that was given up is submitted again from scratch.
      await tx.generationJob.update({ where: { id: j.id }, data: { status: "QUEUED", error: Prisma.DbNull, providerJobId: null } });
    }
    await tx.contentItem.update({ where: { id: itemId }, data: { failedStep: null, lastError: null } });
    if (target) await moveItem(tx, itemId, "FAILED", target);
  });
  for (const j of failed) await queueJob({ ...j, status: "QUEUED" }, { suffix: `r${j.attempt}` });
  return failed[0];
}

// ─────────────────────────────── Worker side ───────────────────────────────

function classify(err: unknown): { kind: string; message: string; retryable: boolean } {
  if (err instanceof ProviderError) return { kind: err.kind, message: err.message, retryable: err.retryable };
  if (err instanceof BudgetBlockedError) return { kind: "blocked_budget", message: err.message, retryable: false };
  if (err instanceof PausedError) return { kind: "paused", message: err.message, retryable: false };
  if (err instanceof PolicyBlockedError) return { kind: "policy", message: err.message, retryable: false };
  if (err instanceof DomainError) return { kind: "invalid", message: err.message, retryable: false };
  if (err instanceof FfmpegError) return { kind: "media", message: err.message, retryable: false };
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

interface QcContext {
  images: ReferenceImage[];
  /** Photo items: the asset per shot that was reviewed. */
  assets: { shot: number; asset: MediaAsset }[];
  /** Video items: the assembled video that was reviewed. */
  video: MediaAsset | null;
  notes: string[];
  order: string;
  hasReferences: boolean;
}

async function qcContext(item: ContentItem): Promise<QcContext> {
  const spec = formatSpec(item);
  const refs = await canonicalReferences(item.creatorId, QC_REFERENCE_IMAGES);
  const images: ReferenceImage[] = [...refs];
  const notes: string[] = [];
  const refText = refs.length ? `the first ${refs.length} are approved reference photos of the character; ` : "no reference photos are available; ";
  if (spec.kind === "video") {
    const video = await finalVideo(item.id);
    if (!video) throw new DomainError("No assembled video to review");
    const bytes = await storage().get(video.storageKey);
    const scenes = await db.videoScene.findMany({ where: { contentItemId: item.id }, orderBy: { position: "asc" } });
    let start = 0;
    for (const s of scenes) {
      images.push({ bytes: await extractFrame(bytes, start + s.durationMs / 2), mimeType: "image/png" });
      start += s.durationMs;
    }
    return { images, assets: [], video, notes, order: `Images: ${refText}then one frame from the middle of each scene in order (scenes 1–${scenes.length}).`, hasReferences: refs.length > 0 };
  }
  const latest = await latestJobs(item.id, "image");
  const assets: { shot: number; asset: MediaAsset }[] = [];
  for (let i = 0; i < shotList(item).length; i++) {
    const asset = latest.get(i)?.mediaAssets[0];
    if (!asset) continue;
    assets.push({ shot: i, asset });
    if (Number(asset.sizeBytes) > QC_MAX_IMAGE_BYTES) notes.push(`Shot ${i + 1} is larger than 5 MB and was not shown to the reviewer model`);
    else images.push({ bytes: await storage().get(asset.storageKey), mimeType: asset.mimeType });
  }
  const shown = assets.filter((a) => Number(a.asset.sizeBytes) <= QC_MAX_IMAGE_BYTES).map((a) => a.shot + 1);
  return { images, assets, video: null, notes, order: `Images: ${refText}then one image per shot in order (shots ${shown.join(", ")}).`, hasReferences: refs.length > 0 };
}

async function duplicateOf(assetId: string, checksum: string) {
  const dup = await db.mediaAsset.findFirst({ where: { checksumSha256: checksum, id: { not: assetId } }, select: { id: true } });
  return dup?.id ?? null;
}

function buildRequest(step: PipelineStep, gen: GenerationJob, config: ReturnType<typeof parseConfig>, refs: ReferenceImage[]): GenerationRequest {
  const params = gen.params as Record<string, unknown>;
  const model = String(params.model ?? config.model ?? "");
  switch (step) {
    case "image":
      return { capability: "IMAGE", model, prompt: gen.renderedPrompt, referenceImages: refs, params: { kind: "IMAGE", size: params.size, quality: params.quality, seed: params.seed } };
    case "scene":
      return {
        capability: "VIDEO",
        model,
        prompt: gen.renderedPrompt,
        referenceImages: refs.slice(0, 3),
        params: { kind: "VIDEO", durationSeconds: params.durationSeconds, aspectRatio: params.aspectRatio, seed: params.seed, label: params.label, negativePrompt: params.negativePrompt },
      };
    case "voice":
      return { capability: "SPEECH", model, prompt: gen.renderedPrompt, params: { kind: "SPEECH", voiceId: params.voiceId } };
    default: {
      const textStep = step as TextStep;
      const jsonSchema =
        textStep === "script"
          ? params.format === "video"
            ? storyboardSchema(Number(params.shots) || 1, (FORMAT_SPECS.SHORT_VIDEO as VideoSpec).sceneSeconds)
            : scriptSchema(Number(params.shots) || 1)
          : STEP_JSON_SCHEMAS[textStep];
      return {
        capability: "TEXT",
        model,
        prompt: gen.renderedPrompt,
        system: typeof params.system === "string" ? params.system : undefined,
        maxOutputTokens: Number(params.maxOutputTokens) || undefined,
        jsonSchema,
        params: { kind: textStep.toUpperCase(), effort: params.effort },
      };
    }
  }
}

export async function runContentStepJob(job: Pick<Job<ContentStepJob>, "data" | "attemptsMade" | "opts">, signal: AbortSignal) {
  const gen = await db.generationJob.findUnique({ where: { id: job.data.jobId }, include: { provider: true, mediaAssets: { select: { id: true } } } });
  if (!gen || !(ACTIVE_JOB_STATUSES as readonly string[]).includes(gen.status)) return { skipped: true };
  const step = gen.step as PipelineStep;
  const item = await loadItem(gen.contentItemId!);

  // Crash recovery: the output was stored but the job was not marked done. Never pay twice.
  if (isTakeStep(step) && gen.mediaAssets.length > 0) {
    await db.generationJob.update({ where: { id: gen.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), error: Prisma.DbNull } });
    await afterTake(item.id);
    return { recovered: true };
  }

  const polling = gen.status === "RUNNING" && !!gen.providerJobId;
  if (!polling && gen.status === "QUEUED") {
    try {
      if ((await checkPolicy(item, step)) === "wait") {
        await queueJob(gen, { suffix: `wait${Date.now()}`, delayMs: CONCURRENCY_WAIT_MS });
        return { deferred: "concurrency" };
      }
    } catch (err) {
      if (!(err instanceof PolicyBlockedError)) throw err;
      assertTransition("generationJob", "QUEUED", "BLOCKED_POLICY");
      await db.generationJob.update({ where: { id: gen.id }, data: { status: "BLOCKED_POLICY", error: { kind: "policy", message: err.message }, finishedAt: new Date() } });
      await markStepFailed(item.id, step, err.message);
      throw new UnrecoverableError(err.message);
    }
  }
  const attempt = polling ? gen.attempt : gen.attempt + 1;
  if (gen.status === "QUEUED") assertTransition("generationJob", "QUEUED", "RUNNING");
  if (!polling) await db.generationJob.update({ where: { id: gen.id }, data: { status: "RUNNING", attempt, startedAt: gen.startedAt ?? new Date() } });

  let spent = gen.actualCostMicros ?? 0n;
  try {
    if (step === "assemble") {
      await runAssembly(item, gen.id, signal);
      return { ok: true };
    }
    const provider = gen.provider;
    if (!provider) throw new DomainError("This step has no provider");
    if (provider.status === "DISABLED") throw new DomainError(`Provider ${provider.displayName} is disabled`);
    const config = parseConfig(provider.config);
    const refs = step === "image" || step === "scene" ? await canonicalReferences(item.creatorId) : [];
    const request = buildRequest(step, gen, config, refs);
    let qc: QcContext | null = null;
    if (step === "qc") {
      qc = await qcContext(item);
      request.referenceImages = qc.images;
      request.prompt = `${gen.renderedPrompt}\n\n${qc.order}`;
    }
    const input = {
      provider,
      config,
      request,
      attribution: { creatorId: item.creatorId, campaignId: item.campaignId, contentItemId: item.id, generationJobId: gen.id },
      ledgerKey: `genjob:${gen.id}:${attempt}`,
      purpose: `content.${step}`,
      signal,
      checkCreatorPause: true,
    };

    let exec: ExecuteResult;
    const adapter = await createAdapter(provider);
    if (adapter.submit) {
      // Long-running provider: submit once, then poll on a delayed queue job until done.
      if (!gen.providerJobId) {
        const { providerJobId } = await submitGeneration({ ...input, adapter });
        await db.generationJob.update({ where: { id: gen.id }, data: { providerJobId, output: { polls: 0 } } });
        await queueJob({ ...gen, status: "RUNNING" }, { suffix: `poll${attempt}-0`, delayMs: POLL_INTERVAL_MS });
        return { submitted: providerJobId };
      }
      const polled = await pollGeneration({ ...input, adapter, providerJobId: gen.providerJobId });
      if (!polled) {
        const waited = Date.now() - (gen.startedAt ?? gen.createdAt).getTime();
        if (waited > MAX_ASYNC_WAIT_MS) {
          const { costMicros } = await abandonGeneration({ ...input, adapter }, `No result after ${Math.round(waited / 60_000)} minutes`);
          throw new ChargedProviderError(new ProviderError("timeout", `The provider did not finish within ${MAX_ASYNC_WAIT_MS / 60_000} minutes`), costMicros, costMicros === null ? null : "ESTIMATED");
        }
        const polls = Number((gen.output as { polls?: number } | null)?.polls ?? 0) + 1;
        await db.generationJob.update({ where: { id: gen.id }, data: { output: { polls } } });
        await queueJob({ ...gen, status: "RUNNING" }, { suffix: `poll${attempt}-${polls}`, delayMs: POLL_INTERVAL_MS });
        return { pending: true };
      }
      exec = polled;
    } else {
      exec = await executeGeneration({ ...input, adapter });
    }
    spent += exec.costMicros;
    const done = { status: "SUCCEEDED" as const, finishedAt: new Date(), error: Prisma.DbNull, actualCostMicros: spent, costBasis: exec.basis, providerJobId: gen.providerJobId ?? exec.result.providerRequestId ?? null };
    const first = exec.result.outputs[0];
    const shot = Number((gen.params as { shot?: number }).shot);

    if (isTakeStep(step)) {
      if (!first?.bytes) throw new ProviderError("transient", "The provider returned no output");
      const facts = step === "image" ? null : await probe(first.bytes, signal);
      await db.$transaction(async (tx) => {
        const common = { creatorId: item.creatorId, contentItemId: item.id, generationJobId: gen.id, shotIndex: shot, isMock: provider.isMock };
        if (step === "image") {
          await storeGeneratedImage({ ...common, bytes: first.bytes!, mimeType: first.mimeType, providerKey: provider.key, modelVersion: exec.result.servedBy, prompt: gen.renderedPrompt, params: request.params }, tx);
        } else {
          await storeMedia(
            {
              ...common,
              kind: step === "scene" ? "VIDEO" : "AUDIO",
              source: "GENERATED",
              bytes: first.bytes!,
              mimeType: first.mimeType ?? (step === "scene" ? "video/mp4" : "audio/mpeg"),
              width: facts?.video?.width ?? null,
              height: facts?.video?.height ?? null,
              durationMs: facts?.durationMs || first.durationMs || null,
              providerKey: provider.key,
              modelVersion: exec.result.servedBy,
              prompt: gen.renderedPrompt,
              params: request.params,
            },
            tx,
          );
        }
        await tx.generationJob.update({ where: { id: gen.id }, data: { ...done, output: { notes: exec.result.notes } } });
      });
      await afterTake(item.id);
      return { ok: true };
    }

    if (step === "qc") {
      const verdict = parseOutput("qc", first?.text);
      await finishQc(item, gen.id, verdict, qc!, done);
      return { ok: true };
    }

    const advanced = await finishTextStep(item, gen, step as Exclude<TextStep, "qc">, first?.text, done);
    if (advanced) await scheduleNextStep(item.id);
    return { ok: true };
  } catch (err) {
    if (err instanceof LocalRateLimitError && !polling) {
      // Nothing was sent or billed: wait for the next window (spread out) without using an attempt.
      assertTransition("generationJob", "RUNNING", "QUEUED");
      await db.generationJob.update({ where: { id: gen.id }, data: { status: "QUEUED", attempt: gen.attempt, error: { kind: "rate_limit_wait", message: err.message } } });
      await queueJob({ ...gen, status: "QUEUED" }, { suffix: `wait${Date.now()}`, delayMs: (err.options.retryAfterMs ?? 60_000) + Math.floor(Math.random() * 20_000) });
      return { deferred: "rate_limit" };
    }
    const c = classify(err);
    if (err instanceof ChargedProviderError && err.costMicros !== null) spent += err.costMicros;
    const final = !c.retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const status = c.kind === "blocked_budget" ? "BLOCKED_BUDGET" : c.kind === "paused" || c.kind === "policy" ? "BLOCKED_POLICY" : final ? "FAILED" : polling ? "RUNNING" : "QUEUED";
    if (status === "QUEUED") assertTransition("generationJob", "FAILED", "QUEUED");
    else if (status !== "RUNNING") assertTransition("generationJob", "RUNNING", status);
    if (c.kind === "internal") logger.error({ jobId: gen.id, err: (err as Error).message }, "content step failed");
    await db.generationJob.update({
      where: { id: gen.id },
      data: {
        status,
        error: { kind: c.kind, message: c.message },
        ...(spent > 0n || gen.actualCostMicros !== null ? { actualCostMicros: spent, costBasis: err instanceof ChargedProviderError && err.basis ? err.basis : (gen.costBasis ?? "MEASURED") } : {}),
        ...(status !== "QUEUED" && status !== "RUNNING" ? { finishedAt: new Date() } : {}),
      },
    });
    if (status !== "QUEUED" && status !== "RUNNING") {
      await markStepFailed(item.id, step, c.message);
      throw new UnrecoverableError(c.message);
    }
    throw err;
  }
}

async function finishTextStep(item: ItemWithCampaign, gen: GenerationJob, step: "brief" | "script" | "caption", text: string | undefined, done: Prisma.GenerationJobUpdateInput) {
  const spec = formatSpec(item);
  if (step === "script" && spec.kind === "video") {
    const board = parseOutput("storyboard", text);
    const scenes = board.scenes.slice(0, requestedShots(item));
    const allowed = spec.sceneSeconds;
    const fit = (s: number) => allowed.reduce((best, v) => (Math.abs(v - s) < Math.abs(best - s) ? v : best), allowed[0]!);
    const planned = scenes.map((s) => ({ ...s, duration_seconds: fit(s.duration_seconds) }));
    return db.$transaction(async (tx) => {
      await tx.generationJob.update({ where: { id: gen.id }, data: { ...done, output: board as unknown as Prisma.InputJsonValue } });
      const moved = await moveItem(tx, item.id, "BRIEFED", "SCRIPTED", {
        script: { requestedShots: requestedShots(item), shots: planned.map((s) => ({ scene: s.visual, purpose: s.action })), storyboard: planned } as unknown as Prisma.InputJsonValue,
      });
      if (moved) {
        await tx.videoScene.deleteMany({ where: { contentItemId: item.id } });
        await tx.videoScene.createMany({
          data: planned.map((s, i) => ({ contentItemId: item.id, position: i, prompt: s.visual, action: s.action, durationMs: s.duration_seconds * 1000, dialogue: s.voiceover, audioNotes: s.on_screen_text })),
        });
      }
      return moved;
    });
  }
  const output = parseOutput(step, text);
  return db.$transaction(async (tx) => {
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
}

function scriptSchema(shots: number): Record<string, unknown> {
  const base = STEP_JSON_SCHEMAS.script as { properties: { shots: Record<string, unknown> } };
  return { ...base, properties: { shots: { ...base.properties.shots, minItems: shots, maxItems: shots } } };
}

/**
 * After a take finished: photo items move to QC once every shot's latest take succeeded; video items
 * move on to assembly once every scene's latest clip (and voice-over, where the scene has one) did.
 */
async function afterTake(itemId: string) {
  const item = await loadItem(itemId);
  if (item.status !== "GENERATING") return;
  const spec = formatSpec(item);
  const shots = shotList(item);
  if (spec.kind === "photo") {
    const latest = await latestJobs(itemId, "image");
    if (!shots.every((_, i) => latest.get(i)?.status === "SUCCEEDED")) return;
    const moved = await db.$transaction((tx) => moveItem(tx, itemId, "GENERATING", "QC_REVIEW", { qualityReport: Prisma.DbNull, qualityScore: null }));
    if (moved) await scheduleNextStep(itemId);
    return;
  }
  const [clips, voices, scenes] = await Promise.all([latestJobs(itemId, "scene"), latestJobs(itemId, "voice"), db.videoScene.findMany({ where: { contentItemId: itemId }, orderBy: { position: "asc" } })]);
  const ready = scenes.every((s, i) => clips.get(i)?.status === "SUCCEEDED" && (!s.dialogue.trim() || voices.get(i)?.status === "SUCCEEDED"));
  if (ready) await scheduleNextStep(itemId); // GENERATING + video ⇒ assembly
}

/** Cuts the approved (or latest) clip of every scene with its voice-over into the final 9:16 video. */
async function runAssembly(item: ItemWithCampaign, jobId: string, signal: AbortSignal) {
  const scenes = await db.videoScene.findMany({ where: { contentItemId: item.id }, orderBy: { position: "asc" } });
  const [clips, voices] = await Promise.all([latestJobs(item.id, "scene"), latestJobs(item.id, "voice")]);
  const parts = [];
  const used: { clip: string; voice: string | null }[] = [];
  let isMock = false;
  let start = 0;
  const cueInput: { startMs: number; durationMs: number; text: string }[] = [];
  for (const [i, s] of scenes.entries()) {
    const approved = await db.mediaAsset.findFirst({ where: { contentItemId: item.id, shotIndex: i, kind: "VIDEO", status: "APPROVED" } });
    const clip = approved ?? clips.get(i)?.mediaAssets.find((a) => a.kind === "VIDEO") ?? null;
    if (!clip) throw new DomainError(`Scene ${i + 1} has no clip`);
    const voice = s.dialogue.trim() ? (voices.get(i)?.mediaAssets.find((a) => a.kind === "AUDIO") ?? null) : null;
    if (s.dialogue.trim() && !voice) throw new DomainError(`Scene ${i + 1} has no voice-over`);
    isMock ||= clip.isMock || !!voice?.isMock;
    parts.push({ video: await storage().get(clip.storageKey), durationMs: s.durationMs, voice: voice ? await storage().get(voice.storageKey) : null });
    used.push({ clip: clip.id, voice: voice?.id ?? null });
    if (s.dialogue.trim()) cueInput.push({ startMs: start, durationMs: s.durationMs, text: s.dialogue });
    start += s.durationMs;
  }
  const result = await assembleVideo(parts, signal);
  const hasVoice = cueInput.length > 0;
  const cues = buildCues(cueInput);
  const checks = videoTechnicalChecks({
    ...result.probe,
    loudness: result.loudness,
    plannedMs: start,
    hasVoice,
    cueProblems: hasVoice ? cueProblems(cues, result.probe.durationMs) : [],
    isMock,
  });
  const report = { technical: checks, pass: technicalPass(checks), probe: result.probe, loudness: result.loudness, scenes: used } as unknown as Prisma.InputJsonValue;
  await db.$transaction(async (tx) => {
    await storeMedia(
      {
        kind: "VIDEO",
        source: "DERIVED",
        bytes: result.bytes,
        mimeType: "video/mp4",
        creatorId: item.creatorId,
        contentItemId: item.id,
        generationJobId: jobId,
        width: result.probe.video?.width ?? null,
        height: result.probe.video?.height ?? null,
        durationMs: result.probe.durationMs,
        params: { scenes: used },
        qualityReport: report,
        isMock,
      },
      tx,
    );
    if (hasVoice)
      await storeMedia({ kind: "SUBTITLE", source: "DERIVED", bytes: Buffer.from(toVtt(cues)), mimeType: "text/vtt", creatorId: item.creatorId, contentItemId: item.id, generationJobId: jobId, durationMs: result.probe.durationMs, isMock }, tx);
    await tx.generationJob.update({ where: { id: jobId }, data: { status: "SUCCEEDED", finishedAt: new Date(), error: Prisma.DbNull, output: report } });
    await moveItem(tx, item.id, "GENERATING", "QC_REVIEW", { qualityReport: Prisma.DbNull, qualityScore: null });
  });
  await scheduleNextStep(item.id);
}

async function finishQc(item: ContentItem, jobId: string, verdict: QcOutput, ctx: QcContext, done: Prisma.GenerationJobUpdateInput) {
  const spec = formatSpec(item);
  const perShot: { shot: number; assetId: string; checks: TechnicalCheck[]; pass: boolean }[] = [];
  if (spec.kind === "photo") {
    for (const { shot, asset } of ctx.assets) {
      const checks = technicalChecks(
        { mimeType: asset.mimeType, width: asset.width, height: asset.height, sizeBytes: Number(asset.sizeBytes), isMock: asset.isMock, duplicateOf: await duplicateOf(asset.id, asset.checksumSha256) },
        spec,
      );
      perShot.push({ shot, assetId: asset.id, checks, pass: technicalPass(checks) });
    }
  }
  const videoReport = ctx.video?.qualityReport as { technical?: TechnicalCheck[]; pass?: boolean } | null;
  const identityChecked = ctx.hasReferences;
  const rubricErrors = verdict.issues.filter((i) => i.severity === "error");
  const reasons = [
    ...perShot.filter((s) => !s.pass).map((s) => `Shot ${s.shot + 1} failed technical checks`),
    ...(spec.kind === "video" && !videoReport?.pass ? ["The assembled video failed technical checks"] : []),
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
    video: ctx.video ? { assetId: ctx.video.id, technical: videoReport?.technical ?? [] } : null,
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
    if (ctx.video) await tx.mediaAsset.update({ where: { id: ctx.video.id }, data: { qualityScore: verdict.score, qualityReport: { ...(videoReport ?? {}), issues: verdict.issues } as unknown as Prisma.InputJsonValue } });
    await tx.contentItem.update({ where: { id: item.id }, data: { qualityReport: report as unknown as Prisma.InputJsonValue, qualityScore: verdict.score } });
    if (pass) await moveItem(tx, item.id, "QC_REVIEW", "READY");
  });
}

export const contentProcessors = {
  "content.step": (job: Job<ContentStepJob>, signal: AbortSignal) => runContentStepJob(job, signal),
};

/**
 * After Redis was lost: puts every content step that the database says is waiting back on its
 * queue. Polls of long-running provider jobs resume. A synchronous step that was running when the
 * queue disappeared may already have been paid for, so it is never re-run blindly: the item stops
 * at that step and a person resumes it after checking the cost ledger.
 */
export async function requeueContentJobs(now = new Date()) {
  const tag = `rebuild${now.getTime()}`;
  let queued = 0;
  let polling = 0;
  let interrupted = 0;
  const jobs = await db.generationJob.findMany({ where: { status: { in: [...ACTIVE_JOB_STATUSES] }, contentItemId: { not: null } } });
  for (const job of jobs) {
    if (job.status === "QUEUED") {
      await queueJob(job, { suffix: `wait${tag}` });
      queued++;
    } else if (job.providerJobId) {
      await queueJob(job, { suffix: `poll${tag}` });
      polling++;
    } else {
      assertTransition("generationJob", "RUNNING", "FAILED");
      const { count } = await db.generationJob.updateMany({ where: { id: job.id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: now, error: { code: "QUEUE_LOST", message: "Interrupted when the job queue was lost" } } });
      if (count === 1) {
        await markStepFailed(job.contentItemId!, job.step as PipelineStep, "Interrupted when the job queue was lost; check the cost ledger, then resume");
        interrupted++;
      }
    }
  }
  return { queued, polling, interrupted };
}
