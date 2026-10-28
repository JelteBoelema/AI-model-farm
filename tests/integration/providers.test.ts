import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnrecoverableError, type Worker } from "bullmq";
import { sniffImage } from "@/lib/image-meta";
import { toMicros } from "@/lib/money";
import { findActivePause, setControlSwitch } from "@/server/controls";
import { db } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { DomainError } from "@/server/errors";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { createWorker } from "@/server/queue/worker";
import { redis } from "@/server/redis";
import {
  acquireRateLimit,
  evaluateReadiness,
  parseConfig,
  registerAdapterOverride,
  selectProvider,
  setProviderPricing,
  syncProviderRegistry,
  updateProviderConfig,
  verifyProvider,
} from "@/server/providers/registry";
import { ProviderError, type GenerationRequest, type GenerationResult, type ProviderAdapter } from "@/server/providers/types";
import { ChargedProviderError, executeGeneration } from "@/server/services/generation";
import { createTemplate, publishVersion, runPromptTest, saveDraft } from "@/server/services/prompts";
import { BudgetBlockedError } from "@/server/services/spend-guard";
import { storage } from "@/server/storage";
import { promptTestProcessors, runPromptTestJob } from "@/workers/processors/prompt-tests";
import { acting, makeCreator, makeUser, uid } from "./helpers";

type Behaviour = (req: GenerationRequest) => Promise<GenerationResult>;
let behaviour: Behaviour = async (req) => ({ outputs: [{ kind: "text", text: "ok" }], attempts: [{ model: req.model, usage: { input_mtok: 1000, output_mtok: 500 } }], servedBy: req.model, notes: [] });
let calls = 0;

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
  async generate(req: GenerationRequest) {
    calls++;
    return behaviour(req);
  }
}

const PRICING = {
  currency: "USD",
  fxToEur: "0.95",
  source: "https://example.com/pricing",
  updatedAt: "2026-10-01T00:00:00.000Z",
  models: { "claude-opus-5-5": { input_mtok: "4.00", output_mtok: "20.00" } },
};
// 1,000 in + 500 out = $0.014 → €0.0133 ; estimate 2,000 in + 1,000 out = $0.028 → €0.0266
const ACTUAL = 13_300n;
const ESTIMATE = 26_600n;

function setMockMode(on: boolean) {
  process.env.MOCK_MODE = on ? "true" : "false";
  resetEnvCache();
}

async function anthropic() {
  return db.aiProvider.findUniqueOrThrow({ where: { key: "anthropic" } });
}

async function setGlobalBudget(limitEur: string | null) {
  await db.budgetPolicy.deleteMany({ where: { scope: "GLOBAL", period: "MONTH" } });
  if (limitEur) await db.budgetPolicy.create({ data: { scope: "GLOBAL", period: "MONTH", limitMicros: toMicros(limitEur) } });
}

const admin = { type: "USER" as const, id: null, label: "admin@test" };
const workers: Worker[] = [];

beforeAll(async () => {
  registerAdapterOverride("anthropic", async () => new FakeClaude());
  delete process.env.ANTHROPIC_API_KEY;
  await syncProviderRegistry();
});

afterAll(async () => {
  registerAdapterOverride("anthropic", null);
  delete process.env.ANTHROPIC_API_KEY;
  setMockMode(true);
  await setGlobalBudget(null);
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  redis().disconnect();
});

describe("registry readiness", () => {
  it("needs key, price list and a passing connection test; a model change requires a new test", async () => {
    let p = await anthropic();
    expect(p.status).toBe("NOT_CONFIGURED");
    expect((await evaluateReadiness(p)).checks.find((c) => c.label === "Credential")?.ok).toBe(false);

    process.env.ANTHROPIC_API_KEY = "sk-test";
    await setProviderPricing(admin, p.id, PRICING);
    expect((await anthropic()).status).toBe("NOT_CONFIGURED"); // not verified yet
    expect(await verifyProvider(admin, p.id)).toMatchObject({ ok: true });
    p = await anthropic();
    expect(p.status).toBe("ACTIVE");
    expect(parseConfig(p.config).verifiedAt).toBeTruthy();

    await updateProviderConfig(admin, p.id, { model: "claude-sonnet-5-5" });
    expect((await anthropic()).status).toBe("NOT_CONFIGURED");
    expect(await verifyProvider(admin, p.id)).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
    await updateProviderConfig(admin, p.id, { model: "claude-opus-5-5" });
    await verifyProvider(admin, p.id);
    expect((await anthropic()).status).toBe("ACTIVE");

    await expect(setProviderPricing(admin, p.id, { ...PRICING, currency: "USD", fxToEur: undefined })).rejects.toThrow(/Invalid price list/);
    const mock = await db.aiProvider.findUniqueOrThrow({ where: { key: "mock-text" } });
    await expect(setProviderPricing(admin, mock.id, PRICING)).rejects.toThrow(/fixed zero price/);
  });
});

describe("provider selection", () => {
  it("uses mocks in mock mode and never falls back to a mock outside it", async () => {
    setMockMode(true);
    expect((await selectProvider("TEXT")).row.key).toBe("mock-text");
    expect((await selectProvider("IMAGE")).row.key).toBe("mock-image");

    setMockMode(false);
    const p = await anthropic();
    expect((await selectProvider("TEXT")).row.key).toBe("anthropic");
    await expect(selectProvider("IMAGE")).rejects.toThrow(/No ready image provider/);

    await setControlSwitch(admin, { scope: "PROVIDER", targetId: p.id, paused: true, reason: "test pause" });
    await expect(selectProvider("TEXT")).rejects.toBeInstanceOf(DomainError);
    await setControlSwitch(admin, { scope: "PROVIDER", targetId: p.id, paused: false, reason: "resume" });
    setMockMode(true);
  });
});

describe("paid execution", () => {
  const run = async (ledgerKey: string, creatorId?: string) => {
    const provider = await anthropic();
    return executeGeneration({
      provider,
      config: parseConfig(provider.config),
      request: { capability: "TEXT", model: "claude-opus-5-5", prompt: "hello", params: {} },
      attribution: { creatorId },
      ledgerKey,
      purpose: "test",
      signal: new AbortController().signal,
    });
  };

  it("is blocked without a farm-wide budget, then books the measured cost exactly once", async () => {
    await setGlobalBudget(null);
    const before = calls;
    await expect(run(`t:${uid()}`)).rejects.toBeInstanceOf(BudgetBlockedError);
    expect(calls).toBe(before); // the provider was never called

    await setGlobalBudget("100");
    const creator = await makeCreator();
    const key = `t:${uid()}`;
    const res = await run(key, creator.id);
    expect(res).toMatchObject({ costMicros: ACTUAL, basis: "MEASURED" });
    const entry = await db.costLedger.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect(entry).toMatchObject({ amountMicros: ACTUAL, basis: "MEASURED", category: "TOKENS", creatorId: creator.id, isMock: false });
    await run(key, creator.id); // same ledger key: no second booking
    expect(await db.costLedger.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("enforces the per-job maximum and scoped budgets using the conservative estimate", async () => {
    await setGlobalBudget("100");
    const creator = await makeCreator();
    const policy = await db.autonomyPolicy.create({ data: { scope: "CREATOR", targetId: creator.id } }); // scoped policies don't cap per job
    const global = (await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" } })) ?? (await db.autonomyPolicy.create({ data: { scope: "GLOBAL" } }));
    await db.autonomyPolicy.update({ where: { id: global.id }, data: { maxCostPerJobMicros: ESTIMATE - 1n } });
    await expect(run(`t:${uid()}`)).rejects.toThrow(/maximum per job/);
    await db.autonomyPolicy.update({ where: { id: global.id }, data: { maxCostPerJobMicros: null } });
    await db.autonomyPolicy.delete({ where: { id: policy.id } });

    await db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, period: "DAY", limitMicros: ESTIMATE + 1n } });
    await run(`t:${uid()}`, creator.id); // spends ACTUAL
    await expect(run(`t:${uid()}`, creator.id)).rejects.toThrow(/creator daily budget .* would be exceeded/);
  });

  it("books the estimate on timeouts and prices unpriced fallback models as estimates", async () => {
    await setGlobalBudget("100");
    behaviour = async () => {
      throw new ProviderError("timeout", "timed out");
    };
    const key = `t:${uid()}`;
    const err = await run(key).catch((e) => e);
    expect(err).toBeInstanceOf(ChargedProviderError);
    expect(await db.costLedger.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({ amountMicros: ESTIMATE, basis: "ESTIMATED", uncertaintyNote: expect.stringContaining("Timed out") });

    behaviour = async (req) => ({
      outputs: [{ kind: "text", text: "ok" }],
      attempts: [
        { model: req.model, usage: { input_mtok: 10, output_mtok: 0 } },
        { model: "claude-sonnet-5-5", usage: { input_mtok: 1000, output_mtok: 500 } },
      ],
      servedBy: "claude-sonnet-5-5",
      notes: [],
    });
    const fb = await run(`t:${uid()}`);
    expect(fb).toMatchObject({ basis: "ESTIMATED", costMicros: ESTIMATE });
    expect(fb.note).toMatch(/claude-sonnet-5-5/);
  });

  it("pauses the provider automatically on credential errors", async () => {
    await setGlobalBudget("100");
    behaviour = async () => {
      throw new ProviderError("auth", "Anthropic rejected the API key");
    };
    const p = await anthropic();
    await expect(run(`t:${uid()}`)).rejects.toMatchObject({ kind: "auth" });
    expect(await findActivePause({ chain: "generation", providerId: p.id })).toMatchObject({ scope: "PROVIDER", reason: expect.stringContaining("Automatic") });
    expect(await db.notification.findFirst({ where: { type: "provider.auto_paused" } })).not.toBeNull();
    await expect(run(`t:${uid()}`)).rejects.toThrow(/Paused/);
    await setControlSwitch(admin, { scope: "PROVIDER", targetId: p.id, paused: false, reason: "key fixed" });
    behaviour = async (req) => ({ outputs: [{ kind: "text", text: "ok" }], attempts: [{ model: req.model, usage: { input_mtok: 1000, output_mtok: 500 } }], servedBy: req.model, notes: [] });
  });

  it("rate-limits per provider per minute", async () => {
    const id = `00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0").slice(-12)}`;
    const now = Date.now();
    await acquireRateLimit(id, 2, now);
    await acquireRateLimit(id, 2, now);
    await expect(acquireRateLimit(id, 2, now)).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("prompt tests through the queue", () => {
  async function publishedTemplate(kind: "CAPTION" | "IMAGE", body: string) {
    const owner = acting(await makeUser("OWNER"));
    const t = await createTemplate(owner, { key: `qt.${kind.toLowerCase()}.${uid()}`, name: "Queued test", kind, scope: "GLOBAL" });
    const v = await db.promptVersion.findFirstOrThrow({ where: { templateId: t.id } });
    await saveDraft(owner, v.id, { body, variables: [{ name: "topic", type: "text", required: true }] });
    await publishVersion(owner, v.id, "first version");
    return { owner, versionId: v.id };
  }
  const jobInfo = (runId: string) => ({ data: { runId }, attemptsMade: 0, opts: { attempts: 3 } });

  it("queues text tests and completes them on the worker with the mock provider", async () => {
    setMockMode(true);
    const { owner, versionId } = await publishedTemplate("CAPTION", "Caption about {{topic}}");
    const run = await runPromptTest(owner, { versionId, values: { topic: "rain" } });
    expect(run).toMatchObject({ status: "QUEUED", providerKey: "mock-text", isMock: true, costMicros: null });
    expect(await getQueue("generation-text").getJob(`prompt-test~${run.id}`)).toBeTruthy();

    await runPromptTestJob(jobInfo(run.id), new AbortController().signal);
    const done = await db.promptTestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: "SUCCEEDED", costMicros: 0n, attempts: 1, model: "mock" });
    expect(done.output).toMatch(/^\[Mock caption output/);
    // running the same job again is a no-op
    expect(await runPromptTestJob(jobInfo(run.id), new AbortController().signal)).toEqual({ skipped: true });
  });

  it("generates and stores watermarked mock images as media assets", async () => {
    setMockMode(true);
    const { owner, versionId } = await publishedTemplate("IMAGE", "Photo about {{topic}}");
    const run = await runPromptTest(owner, { versionId, values: { topic: "boots" } });
    await runPromptTestJob(jobInfo(run.id), new AbortController().signal);
    const done = await db.promptTestRun.findUniqueOrThrow({ where: { id: run.id }, include: { outputMedia: true } });
    expect(done.status).toBe("SUCCEEDED");
    expect(done.outputMedia).toMatchObject({ kind: "IMAGE", source: "GENERATED", isMock: true, providerKey: "mock-image", status: "PENDING_REVIEW", promptSnapshot: "Photo about boots" });
    const bytes = await storage().get(done.outputMedia!.storageKey);
    expect(sniffImage(bytes)).toMatchObject({ mimeType: "image/png", width: 512, height: 768 });
  });

  it("fails blocked runs without retrying and without cost", async () => {
    setMockMode(false);
    await setGlobalBudget(null);
    const { owner, versionId } = await publishedTemplate("CAPTION", "Caption about {{topic}}");
    const run = await runPromptTest(owner, { versionId, values: { topic: "x" } });
    expect(run.providerKey).toBe("anthropic");
    await expect(runPromptTestJob(jobInfo(run.id), new AbortController().signal)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await db.promptTestRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "FAILED", errorKind: "blocked_budget", costMicros: 0n });
    setMockMode(true);
  });

  it("is executed end-to-end by a real BullMQ worker", async () => {
    setMockMode(true);
    const { owner, versionId } = await publishedTemplate("CAPTION", "Caption about {{topic}}");
    const worker = createWorker("generation-text", promptTestProcessors);
    workers.push(worker);
    const run = await runPromptTest(owner, { versionId, values: { topic: "wind" } });
    for (let i = 0; i < 100; i++) {
      const r = await db.promptTestRun.findUniqueOrThrow({ where: { id: run.id } });
      if (r.status === "SUCCEEDED") return;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error("worker did not complete the run");
  });
});
