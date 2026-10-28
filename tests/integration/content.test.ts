import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toMicros } from "@/lib/money";
import { db } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { MockImageAdapter } from "@/server/providers/adapters/mock";
import { mockFromSchema } from "@/server/providers/mock-text";
import { registerAdapterOverride, setProviderPricing, syncProviderRegistry, verifyProvider } from "@/server/providers/registry";
import { ProviderError, type GenerationRequest, type GenerationResult, type ProviderAdapter } from "@/server/providers/types";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { redis } from "@/server/redis";
import {
  approveContent,
  approveMedia,
  costPerUsableAsset,
  createBatch,
  createContent,
  regenerateShot,
  rejectContent,
  resumeProduction,
  startProduction,
} from "@/server/services/content";
import { runContentStepJob, scheduleNextStep } from "@/server/services/content-pipeline";
import { releaseReservation, reserveBudget } from "@/server/services/cost-manager";
import { BudgetBlockedError } from "@/server/services/spend-guard";
import { STARTER_PROMPTS } from "../../prisma/starter-prompts";
import { acting, makeCreator, makeUser, uid } from "./helpers";

// ── Fake paid providers (real-mode tests; they never touch the network) ──

let textCalls = 0;
let imageCalls: string[] = [];
let failImage: (req: GenerationRequest) => boolean = () => false;
let qcVerdict: Record<string, unknown> | null = null;

class FakeClaude implements ProviderAdapter {
  readonly key = "anthropic";
  readonly isMock = false;
  async discoverCapabilities() {
    return [{ capability: "TEXT" as const, model: "claude-opus-5-5", commercialUseAllowed: true }];
  }
  validate() {}
  estimate() {
    return { maxUsage: { input_mtok: 2000, output_mtok: 1000 }, uncertaintyNote: "test bound" };
  }
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    textCalls++;
    const isQc = req.params.kind === "QC";
    const json = isQc && qcVerdict ? qcVerdict : mockFromSchema(req.jsonSchema ?? { type: "string" }, req.prompt);
    return { outputs: [{ kind: "text", text: JSON.stringify(json) }], attempts: [{ model: req.model, usage: { input_mtok: 1000, output_mtok: 500 } }], servedBy: req.model, notes: [] };
  }
}

class FakeImages implements ProviderAdapter {
  readonly key = "openai-images";
  readonly isMock = false;
  async discoverCapabilities() {
    return [{ capability: "IMAGE" as const, model: "gpt-image-2", commercialUseAllowed: true }];
  }
  validate() {}
  estimate() {
    return { maxUsage: { per_image: 1 }, uncertaintyNote: "one image" };
  }
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    imageCalls.push(String(req.params.seed));
    if (failImage(req)) throw new ProviderError("transient", "image service unavailable");
    const out = await new MockImageAdapter().generate(req);
    return { ...out, attempts: [{ model: req.model, usage: { per_image: 1 } }], servedBy: req.model };
  }
}

// Claude: 1,000 in + 500 out at $4/$20 → $0.014 × 0.95 = €0.0133 per text step. Image: €0.04 each.
const TEXT_COST = 13_300n;
const IMAGE_COST = 40_000n;

function setMockMode(on: boolean) {
  process.env.MOCK_MODE = on ? "true" : "false";
  resetEnvCache();
}

async function setGlobalBudget(limitEur: string | null) {
  await db.budgetPolicy.deleteMany({ where: { scope: "GLOBAL", period: "MONTH" } });
  if (limitEur) await db.budgetPolicy.create({ data: { scope: "GLOBAL", period: "MONTH", limitMicros: toMicros(limitEur) } });
}

const admin = { type: "USER" as const, id: null, label: "admin@test" };

async function makeRealProvidersReady() {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.OPENAI_API_KEY = "sk-test";
  const claude = await db.aiProvider.findUniqueOrThrow({ where: { key: "anthropic" } });
  await setProviderPricing(admin, claude.id, {
    currency: "USD",
    fxToEur: "0.95",
    source: "https://example.com/claude",
    updatedAt: "2026-10-01T00:00:00.000Z",
    models: { "claude-opus-5-5": { input_mtok: "4.00", output_mtok: "20.00" }, "claude-haiku-5-5": { input_mtok: "4.00", output_mtok: "20.00" } },
  });
  await verifyProvider(admin, claude.id);
  const images = await db.aiProvider.findUniqueOrThrow({ where: { key: "openai-images" } });
  await setProviderPricing(admin, images.id, { currency: "EUR", source: "https://example.com/images", updatedAt: "2026-10-01T00:00:00.000Z", models: { "gpt-image-2": { per_image: "0.04" } } });
  await verifyProvider(admin, images.id);
}

/** Creator with an approved character and creator-scoped copies of the starter templates. */
async function readyCreator() {
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

const signal = () => new AbortController().signal;

/** Runs queued jobs of an item in-process (as the worker would) until nothing is queued. */
async function drain(itemId: string, attempts = 1) {
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

let op: ReturnType<typeof acting>;

beforeAll(async () => {
  registerAdapterOverride("anthropic", async () => new FakeClaude());
  registerAdapterOverride("openai-images", async () => new FakeImages());
  await syncProviderRegistry();
  op = acting(await makeUser("OPERATOR"));
});

beforeEach(() => {
  setMockMode(true);
  textCalls = 0;
  imageCalls = [];
  failImage = () => false;
  qcVerdict = null;
});

afterAll(async () => {
  registerAdapterOverride("anthropic", null);
  registerAdapterOverride("openai-images", null);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  setMockMode(true);
  await setGlobalBudget(null);
  // Leave the real providers unconfigured again for other test files.
  await db.aiProvider.updateMany({ where: { key: { in: ["anthropic", "openai-images"] } }, data: { pricing: {}, config: {} } });
  await syncProviderRegistry();
  for (const q of ["generation-text", "generation-image"] as const) await getQueue(q).obliterate({ force: true });
  await closeQueues();
  redis().disconnect();
});

describe("content pipeline in mock mode", () => {
  it("runs idea → brief → shot list → caption → image → QC → ready, then approval", async () => {
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "Rainy day outfit", idea: "Three layers for a rainy autumn commute", produce: true });
    expect(await db.generationJob.count({ where: { contentItemId: item.id } })).toBe(1);
    await drain(item.id);

    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { mediaAssets: true, generationJobs: true } });
    expect(done.status).toBe("READY");
    expect(done.generationJobs.map((j) => j.step).sort()).toEqual(["brief", "caption", "image", "qc", "script"]);
    expect(done.generationJobs.every((j) => j.status === "SUCCEEDED" && j.isMock)).toBe(true);
    expect((done.brief as { hook: string }).hook).toMatch(/^\[Mock hook/);
    expect((done.script as { shots: unknown[] }).shots).toHaveLength(1);
    expect(done.caption).toMatch(/Made with AI$/);
    expect(done.mediaAssets).toHaveLength(1);
    expect(done.mediaAssets[0]).toMatchObject({ isMock: true, shotIndex: 0, status: "PENDING_REVIEW", source: "GENERATED" });
    expect(done.qualityReport).toMatchObject({ pass: true });
    // The mock warning is part of the technical report.
    expect(JSON.stringify(done.mediaAssets[0]!.qualityReport)).toContain("Mock image");
    // Mock work is never booked as spend and never holds budget.
    expect(await db.costLedger.count({ where: { contentItemId: item.id } })).toBe(0);
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id } })).toBe(0);

    await approveContent(op, item.id);
    const approved = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { mediaAssets: true } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.mediaAssets[0]!.status).toBe("APPROVED");
    expect(await db.approval.count({ where: { subjectType: "CONTENT_ITEM", subjectId: item.id, decision: "APPROVED" } })).toBe(1);
  });

  it("produces one image per carousel slide and schedules each step only once", async () => {
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "CAROUSEL", shots: 3, title: "Capsule basics", idea: "Five pieces, many outfits" });
    await startProduction(op, item.id);
    await scheduleNextStep(item.id); // duplicate trigger
    expect(await db.generationJob.count({ where: { contentItemId: item.id } })).toBe(1);
    await expect(startProduction(op, item.id)).rejects.toThrow(/already in production/);
    await drain(item.id);
    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { mediaAssets: true } });
    expect(done.status).toBe("READY");
    expect(done.mediaAssets.map((a) => a.shotIndex).sort()).toEqual([0, 1, 2]);
    expect(done.generationCount).toBe(3);
  });

  it("creates batches and starts the items that can run", async () => {
    const creator = await readyCreator();
    const batch = await createBatch(op, { creatorId: creator.id, format: "STORY", name: "Week 44", ideas: ["Morning routine", "Coffee spot", "Evening walk"], produce: true });
    const items = await db.contentItem.findMany({ where: { batchId: batch.id } });
    expect(items).toHaveLength(3);
    expect(await db.generationJob.count({ where: { contentItemId: { in: items.map((i) => i.id) } } })).toBe(3);
  });

  it("refuses video formats, creators without an approved character, and paused creators", async () => {
    const creator = await readyCreator();
    const video = await createContent(op, { creatorId: creator.id, format: "SHORT_VIDEO", title: "Video idea" });
    await expect(startProduction(op, video.id)).rejects.toThrow(/phase 6/);
    const bare = await makeCreator();
    const item = await createContent(op, { creatorId: bare.id, format: "IMAGE_POST", title: "No character yet" });
    await expect(startProduction(op, item.id)).rejects.toThrow(/approved character/);
    await db.creator.update({ where: { id: creator.id }, data: { status: "PAUSED" } });
    const paused = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "Paused creator" });
    await expect(startProduction(op, paused.id)).rejects.toThrow(/paused/);
  });

  it("enforces the generation limit on regeneration and the approval rules", async () => {
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "Limit test", produce: true });
    await drain(item.id);
    await regenerateShot(op, item.id, 0);
    await drain(item.id);
    const two = await db.mediaAsset.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(two).toHaveLength(2);
    expect(two[0]!.checksumSha256).not.toBe(two[1]!.checksumSha256); // a new take, not a copy
    await db.contentItem.update({ where: { id: item.id }, data: { maxGenerations: 2 } });
    await expect(regenerateShot(op, item.id, 0)).rejects.toThrow(/Generation limit reached: 2 of 2/);

    await approveMedia(op, two[0]!.id);
    await approveMedia(op, two[1]!.id); // switches the approved take
    const after = await db.mediaAsset.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(after.map((a) => a.status)).toEqual(["REJECTED", "APPROVED"]);

    const viewer = acting(await makeUser("VIEWER"));
    await expect(approveContent(viewer, item.id)).rejects.toThrow(/permission/);
    await db.contentItem.update({ where: { id: item.id }, data: { status: "QC_REVIEW" } });
    await expect(approveContent(op, item.id)).rejects.toThrow(/explain why/);
    await approveContent(op, item.id, "Checked manually, hands look fine");
    expect(await db.approval.findFirst({ where: { subjectId: item.id, subjectType: "CONTENT_ITEM" } })).toMatchObject({ payload: { qcOverride: true } });
    await expect(rejectContent(op, item.id, "too late")).rejects.toThrow(/Invalid content status transition/);
  });
});

describe("content pipeline with paid providers", () => {
  beforeEach(async () => {
    setMockMode(false);
    await makeRealProvidersReady();
  });

  it("blocks a step on budget before calling the provider, then resumes it", async () => {
    await setGlobalBudget("0.01"); // below one text step estimate
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "Budget test", produce: true });
    await drain(item.id);
    const blocked = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { generationJobs: true } });
    expect(blocked).toMatchObject({ status: "IDEA", failedStep: "brief", lastError: expect.stringContaining("budget") });
    expect(blocked.generationJobs[0]).toMatchObject({ status: "BLOCKED_BUDGET", actualCostMicros: null });
    expect(textCalls).toBe(0);
    expect(await db.costLedger.count({ where: { contentItemId: item.id } })).toBe(0);
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id, status: "HELD" } })).toBe(0);

    await setGlobalBudget("100");
    await resumeProduction(op, item.id);
    await drain(item.id);
    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(done.status).toBe("READY");
    expect(textCalls).toBe(4); // brief, script, caption, qc
  });

  it("resumes a failed image step without paying again for work that succeeded", async () => {
    await setGlobalBudget("100");
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "CAROUSEL", shots: 3, title: "Resume test", produce: true });
    failImage = (req) => String(req.params.seed).includes(":1:"); // slide 2 keeps failing
    await drain(item.id, 3);

    const failed = await db.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(failed).toMatchObject({ status: "FAILED", failedStep: "image" });
    expect(imageCalls.filter((s) => s.includes(":1:"))).toHaveLength(3); // retried by the queue, then given up
    expect(await db.costLedger.count({ where: { contentItemId: item.id, category: "IMAGE" } })).toBe(2);

    failImage = () => false;
    imageCalls = [];
    await resumeProduction(op, item.id);
    await drain(item.id);
    expect(imageCalls).toEqual([`${item.id}:1:1`]); // only the failed slide ran again

    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { generationJobs: true } });
    expect(done.status).toBe("READY");
    const ledger = await db.costLedger.findMany({ where: { contentItemId: item.id } });
    expect(ledger.filter((l) => l.category === "IMAGE")).toHaveLength(3);
    expect(ledger.filter((l) => l.category === "TOKENS")).toHaveLength(4);
    for (const l of ledger) expect(l).toMatchObject({ basis: "MEASURED", creatorId: creator.id });
    // Every job's recorded cost equals what the ledger booked for it.
    for (const j of done.generationJobs) {
      const booked = ledger.filter((l) => l.generationJobId === j.id).reduce((s, l) => s + l.amountMicros, 0n);
      expect(j.actualCostMicros).toBe(booked);
    }
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id, status: "HELD" } })).toBe(0);
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id, status: "CONSUMED" } })).toBe(7);

    await approveContent(op, item.id);
    const cost = await costPerUsableAsset({ contentItemId: item.id });
    expect(cost).toMatchObject({ spentMicros: 4n * TEXT_COST + 3n * IMAGE_COST, usableAssets: 3, perAssetMicros: (4n * TEXT_COST + 3n * IMAGE_COST) / 3n });
  });

  it("keeps items in review when quality control finds errors", async () => {
    await setGlobalBudget("100");
    qcVerdict = { score: 55, pass: false, identity_consistent: false, issues: [{ severity: "error", shot: 1, message: "Six fingers on the left hand" }], summary: "Hand artefact" };
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "IMAGE_POST", title: "QC test", produce: true });
    await drain(item.id);
    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { mediaAssets: true } });
    expect(done.status).toBe("QC_REVIEW");
    expect(done.qualityScore).toBe(55);
    expect((done.qualityReport as { reasons: string[] }).reasons).toEqual(expect.arrayContaining(["Reviewer model did not pass the content", "Score 55 is below 70", "1 rubric error(s)"]));
    expect(done.mediaAssets[0]!.qualityReport).toMatchObject({ issues: [{ message: "Six fingers on the left hand" }] });
  });
});

describe("budget reservations", () => {
  it("count against the budget while held and free it when released", async () => {
    await setGlobalBudget("100");
    const provider = await db.aiProvider.findUniqueOrThrow({ where: { key: "anthropic" } });
    const creator = await makeCreator();
    await db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitMicros: toMicros("1") } });
    const a = await reserveBudget({ estimateMicros: toMicros("0.70"), providerId: provider.id, creatorId: creator.id, ttlMs: 60_000 });
    await expect(reserveBudget({ estimateMicros: toMicros("0.40"), providerId: provider.id, creatorId: creator.id, ttlMs: 60_000 })).rejects.toBeInstanceOf(BudgetBlockedError);
    await releaseReservation(a.id);
    const b = await reserveBudget({ estimateMicros: toMicros("0.40"), providerId: provider.id, creatorId: creator.id, ttlMs: 60_000 });
    await releaseReservation(b.id);
    // Concurrent reservations are serialised: only as many as fit are granted.
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => reserveBudget({ estimateMicros: toMicros("0.30"), providerId: provider.id, creatorId: creator.id, ttlMs: 60_000 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results) if (r.status === "fulfilled") await releaseReservation(r.value.id);
  });
});
