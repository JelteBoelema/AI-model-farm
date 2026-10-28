import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoTechnicalChecks } from "@/lib/content-pipeline";
import { toMicros } from "@/lib/money";
import { db } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { extractFrame, inspect, renderMockClip } from "@/server/media/ffmpeg";
import { MockVideoAdapter } from "@/server/providers/adapters/mock";
import { mockFromSchema } from "@/server/providers/mock-text";
import { registerAdapterOverride, setProviderPricing, syncProviderRegistry, updateProviderConfig, verifyProvider } from "@/server/providers/registry";
import type { GenerationRequest, GenerationResult, PollResult, ProviderAdapter } from "@/server/providers/types";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { redis } from "@/server/redis";
import { approveContent, createContent, regenerateShot, resumeProduction } from "@/server/services/content";
import { MAX_ASYNC_WAIT_MS, runContentStepJob } from "@/server/services/content-pipeline";
import { storage } from "@/server/storage";
import { sniffImage } from "@/lib/image-meta";
import { STARTER_PROMPTS } from "../../prisma/starter-prompts";
import { acting, makeCreator, makeUser, uid } from "./helpers";

// ── Fake paid providers (no network) ──

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
    return { outputs: [{ kind: "text", text: JSON.stringify(mockFromSchema(req.jsonSchema ?? { type: "string" }, req.prompt)) }], attempts: [{ model: req.model, usage: { input_mtok: 1000, output_mtok: 500 } }], servedBy: req.model, notes: [] };
  }
}

/** Long-running video provider: answers "not done" until `readyAfterPolls` polls have happened. */
let readyAfterPolls = 1;
let polls = 0;
let submits = 0;
class FakeVeo implements ProviderAdapter {
  readonly key = "google-veo";
  readonly isMock = false;
  async discoverCapabilities() {
    return [{ capability: "VIDEO" as const, model: "veo-test", commercialUseAllowed: true }];
  }
  validate() {}
  estimate(req: GenerationRequest) {
    return { maxUsage: { video_second: Number(req.params.durationSeconds) }, uncertaintyNote: "per second" };
  }
  async generate(): Promise<GenerationResult> {
    throw new Error("async only");
  }
  async submit() {
    submits++;
    return { providerJobId: `operations/op-${submits}` };
  }
  async poll(_id: string, req: GenerationRequest, signal: AbortSignal): Promise<PollResult> {
    polls++;
    if (polls <= readyAfterPolls) return { done: false };
    const out = await new MockVideoAdapter().generate({ ...req, model: "mock" }, signal);
    return { done: true, result: { ...out, attempts: [{ model: req.model, usage: { video_second: Number(req.params.durationSeconds) } }], servedBy: req.model } };
  }
}

class FakeVoice implements ProviderAdapter {
  readonly key = "elevenlabs";
  readonly isMock = false;
  async discoverCapabilities() {
    return [{ capability: "SPEECH" as const, model: "voice-test", commercialUseAllowed: true }];
  }
  validate() {}
  estimate(req: GenerationRequest) {
    return { maxUsage: { speech_kchar: req.prompt.length }, uncertaintyNote: "per character" };
  }
  async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    const out = await new MockVideoAdapter().generate({ ...req, model: "mock" }, signal);
    return { ...out, attempts: [{ model: req.model, usage: { speech_kchar: req.prompt.length } }], servedBy: req.model };
  }
}

const admin = { type: "USER" as const, id: null, label: "admin@test" };

function exec(bin: string, args: string[], input: Buffer): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const out: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve({ stdout: Buffer.concat(out) }) : reject(new Error(`${bin} exited ${code}`))));
    p.stdin.end(input);
  });
}
const signal = () => new AbortController().signal;

function setMockMode(on: boolean) {
  process.env.MOCK_MODE = on ? "true" : "false";
  resetEnvCache();
}

async function setGlobalBudget(limitEur: string | null) {
  await db.budgetPolicy.deleteMany({ where: { scope: "GLOBAL", period: "MONTH" } });
  if (limitEur) await db.budgetPolicy.create({ data: { scope: "GLOBAL", period: "MONTH", limitMicros: toMicros(limitEur) } });
}

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

/** Runs queued jobs (and due polls of running long jobs) in-process until nothing is left. */
async function drain(itemId: string) {
  for (let round = 0; round < 60; round++) {
    const jobs = await db.generationJob.findMany({ where: { contentItemId: itemId, OR: [{ status: "QUEUED" }, { status: "RUNNING", providerJobId: { not: null } }] }, orderBy: { createdAt: "asc" } });
    if (jobs.length === 0) return;
    for (const j of jobs) await runContentStepJob({ data: { jobId: j.id }, attemptsMade: 0, opts: { attempts: 1 } }, signal()).catch(() => undefined);
  }
  throw new Error("pipeline did not settle");
}

let op: ReturnType<typeof acting>;

beforeAll(async () => {
  registerAdapterOverride("anthropic", async () => new FakeClaude());
  registerAdapterOverride("google-veo", async () => new FakeVeo());
  registerAdapterOverride("elevenlabs", async () => new FakeVoice());
  await syncProviderRegistry();
  op = acting(await makeUser("OPERATOR"));
});

beforeEach(() => {
  setMockMode(true);
  polls = 0;
  submits = 0;
  readyAfterPolls = 1;
});

afterAll(async () => {
  for (const k of ["anthropic", "google-veo", "elevenlabs"]) registerAdapterOverride(k, null);
  for (const k of ["ANTHROPIC_API_KEY", "GOOGLE_GENAI_API_KEY", "ELEVENLABS_API_KEY"]) delete process.env[k];
  setMockMode(true);
  await setGlobalBudget(null);
  await db.aiProvider.updateMany({ where: { key: { in: ["anthropic", "google-veo", "elevenlabs"] } }, data: { pricing: {}, config: {} } });
  await syncProviderRegistry();
  for (const q of ["generation-text", "generation-video", "media-processing"] as const) await getQueue(q).obliterate({ force: true });
  await closeQueues();
  redis().disconnect();
});

describe("video pipeline in mock mode", () => {
  it("storyboard → voice-over + clip per scene → 9:16 assembly with subtitles → QC → approval", async () => {
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "SHORT_VIDEO", shots: 2, title: "Morning routine", idea: "Three habits in 8 seconds", produce: true });
    await drain(item.id);

    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { scenes: { orderBy: { position: "asc" } }, mediaAssets: true, generationJobs: true } });
    expect(done.status).toBe("READY");
    expect(done.generationJobs.map((j) => j.step).sort()).toEqual(["assemble", "brief", "caption", "qc", "scene", "scene", "script", "voice", "voice"]);
    expect(done.scenes).toHaveLength(2);
    expect(done.scenes.every((s) => [4, 6, 8].includes(s.durationMs / 1000) && s.dialogue.length > 0)).toBe(true);
    expect(done.generationCount).toBe(2); // voice-overs are not generations

    const final = done.mediaAssets.find((a) => a.kind === "VIDEO" && a.shotIndex === null)!;
    expect(final).toMatchObject({ source: "DERIVED", width: 1080, height: 1920, isMock: true });
    const report = final.qualityReport as { technical: { check: string; ok: boolean }[]; pass: boolean };
    expect(report.pass).toBe(true);
    expect(report.technical.filter((c) => !c.ok).map((c) => c.check)).toEqual(["Real provider output"]);
    expect(done.mediaAssets.find((a) => a.kind === "SUBTITLE")).toMatchObject({ mimeType: "text/vtt" });
    const planned = done.scenes.reduce((n, s) => n + s.durationMs, 0);
    expect(Math.abs(final.durationMs! - planned)).toBeLessThanOrEqual(500);
    expect(await db.costLedger.count({ where: { contentItemId: item.id } })).toBe(0);

    // The watermark is in the delivered video: the "MOCK" band across the middle of a frame is dark,
    // while the rows above it carry the bright gradient.
    const frame = await extractFrame(await storage().get(final.storageKey), 1000);
    expect(sniffImage(frame)).toMatchObject({ mimeType: "image/png" });
    const luma = async (yFraction: number) => {
      const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `crop=iw:2:0:ih*${yFraction},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], frame);
      return stdout[0]!;
    };
    expect(await luma(0.41)).toBeLessThan(60); // inside the band, above the letters
    expect(await luma(0.2)).toBeGreaterThan(80);

    await approveContent(op, item.id);
    const approved = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { scenes: true, mediaAssets: true } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.mediaAssets.filter((a) => a.kind === "VIDEO" && a.status === "APPROVED")).toHaveLength(3); // 2 clips + final
    expect(approved.scenes.every((s) => s.approvedAssetId)).toBe(true);
  });

  it("regenerating one scene leaves the other scene untouched and re-assembles", async () => {
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "SHORT_VIDEO", shots: 2, title: "Scene redo", produce: true });
    await drain(item.id);
    const before = await db.generationJob.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    const scene0 = await db.mediaAsset.findFirstOrThrow({ where: { contentItemId: item.id, kind: "VIDEO", shotIndex: 0 } });

    await regenerateShot(op, item.id, 1);
    await drain(item.id);

    const after = await db.generationJob.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    const added = after.filter((j) => !before.some((b) => b.id === j.id));
    expect(added.map((j) => j.step).sort()).toEqual(["assemble", "qc", "scene"]); // no new voice-over, nothing for scene 1
    expect((added.find((j) => j.step === "scene")!.params as { shot: number; take: number })).toMatchObject({ shot: 1, take: 2 });
    for (const b of before) expect(after.find((a) => a.id === b.id)).toMatchObject({ status: b.status, updatedAt: b.updatedAt });
    expect(await db.mediaAsset.count({ where: { contentItemId: item.id, kind: "VIDEO", shotIndex: 0 } })).toBe(1);
    expect(await db.mediaAsset.findUniqueOrThrow({ where: { id: scene0.id } })).toMatchObject({ checksumSha256: scene0.checksumSha256 });

    const finals = await db.mediaAsset.findMany({ where: { contentItemId: item.id, kind: "VIDEO", shotIndex: null }, orderBy: { createdAt: "asc" } });
    expect(finals).toHaveLength(2);
    const used = (finals[1]!.paramsSnapshot as { scenes: { clip: string }[] }).scenes.map((s) => s.clip);
    expect(used[0]).toBe(scene0.id);
    expect(used[1]).not.toBe((finals[0]!.paramsSnapshot as { scenes: { clip: string }[] }).scenes[1]!.clip);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("READY");
  });

  it("refuses talking-head production until a lip-sync provider exists", async () => {
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "TALKING_HEAD", title: "Talking" });
    const { startProduction } = await import("@/server/services/content");
    await expect(startProduction(op, item.id)).rejects.toThrow(/lip-sync/);
  });
});

describe("technical video QC", () => {
  it("rejects a clip in the wrong format and accepts the assembled format", async () => {
    const landscape = await renderMockClip({ width: 960, height: 540, durationMs: 2000, label: "SCENE 1", colors: [[10, 10, 10], [200, 200, 200]] });
    const facts = await inspect(landscape);
    const checks = videoTechnicalChecks({ ...facts.probe, loudness: facts.loudness, plannedMs: 2000, hasVoice: false, cueProblems: [], isMock: false });
    const failing = checks.filter((c) => !c.ok && c.severity === "error").map((c) => c.check);
    expect(failing).toEqual(expect.arrayContaining(["Resolution", "Audio track"]));
    expect(checks.find((c) => c.check === "Duration")!.ok).toBe(true);
  });
});

describe("long-running video provider", () => {
  async function realProviders() {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.GOOGLE_GENAI_API_KEY = "g-test";
    process.env.ELEVENLABS_API_KEY = "e-test";
    const claude = await db.aiProvider.findUniqueOrThrow({ where: { key: "anthropic" } });
    await setProviderPricing(admin, claude.id, { currency: "EUR", source: "https://example.com/c", updatedAt: "2026-10-01T00:00:00.000Z", models: { "claude-opus-5-5": { input_mtok: "1", output_mtok: "1" }, "claude-haiku-5-5": { input_mtok: "1", output_mtok: "1" } } });
    await verifyProvider(admin, claude.id);
    const veo = await db.aiProvider.findUniqueOrThrow({ where: { key: "google-veo" } });
    await updateProviderConfig(admin, veo.id, { model: "veo-test" });
    await setProviderPricing(admin, veo.id, { currency: "EUR", source: "https://example.com/v", updatedAt: "2026-10-01T00:00:00.000Z", models: { "veo-test": { video_second: "0.10" } } });
    await verifyProvider(admin, veo.id);
    const voice = await db.aiProvider.findUniqueOrThrow({ where: { key: "elevenlabs" } });
    await updateProviderConfig(admin, voice.id, { model: "voice-test", voiceId: "Voice12345" });
    await setProviderPricing(admin, voice.id, { currency: "EUR", source: "https://example.com/e", updatedAt: "2026-10-01T00:00:00.000Z", models: { "voice-test": { speech_kchar: "0.20" } } });
    await verifyProvider(admin, voice.id);
    expect((await db.aiProvider.findMany({ where: { key: { in: ["anthropic", "google-veo", "elevenlabs"] } } })).map((p) => p.status)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
  }

  beforeEach(async () => {
    setMockMode(false);
    await setGlobalBudget("100");
    await realProviders();
  });

  it("holds budget while the provider works, then books the measured cost once", async () => {
    readyAfterPolls = 2;
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "SHORT_VIDEO", shots: 2, title: "Async", produce: true });
    await drain(item.id);
    expect(submits).toBe(2);
    expect(polls).toBeGreaterThanOrEqual(4);
    const done = await db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { scenes: true } });
    expect(done.status).toBe("READY");
    const seconds = done.scenes.reduce((n, s) => n + s.durationMs / 1000, 0);
    const videoCharges = await db.costLedger.findMany({ where: { contentItemId: item.id, category: "VIDEO_SECONDS" } });
    expect(videoCharges).toHaveLength(2);
    expect(videoCharges.reduce((n, c) => n + c.amountMicros, 0n)).toBe(toMicros((seconds * 0.1).toFixed(2)));
    expect(await db.costLedger.count({ where: { contentItemId: item.id, category: "AUDIO" } })).toBe(2);
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id, status: "HELD" } })).toBe(0);
    const scenes = await db.generationJob.findMany({ where: { contentItemId: item.id, step: "scene" } });
    expect(scenes.every((j) => j.providerJobId?.startsWith("operations/") && j.status === "SUCCEEDED")).toBe(true);
  });

  it("gives up after the maximum wait, books the estimate, and resumes with a new submission", async () => {
    readyAfterPolls = 1_000;
    const creator = await readyCreator();
    const item = await createContent(op, { creatorId: creator.id, format: "SHORT_VIDEO", shots: 2, title: "Stuck", produce: true });
    // Run until the clips are submitted and polled once.
    for (let i = 0; i < 6; i++) {
      const jobs = await db.generationJob.findMany({ where: { contentItemId: item.id, OR: [{ status: "QUEUED" }, { status: "RUNNING", providerJobId: { not: null } }] } });
      for (const j of jobs) await runContentStepJob({ data: { jobId: j.id }, attemptsMade: 0, opts: { attempts: 1 } }, signal()).catch(() => undefined);
    }
    const running = await db.generationJob.findMany({ where: { contentItemId: item.id, step: "scene", status: "RUNNING" } });
    expect(running).toHaveLength(2);
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id, status: "HELD" } })).toBe(2);
    await db.generationJob.updateMany({ where: { id: { in: running.map((j) => j.id) } }, data: { startedAt: new Date(Date.now() - MAX_ASYNC_WAIT_MS - 60_000) } });
    for (const j of running) await runContentStepJob({ data: { jobId: j.id }, attemptsMade: 0, opts: { attempts: 1 } }, signal()).catch(() => undefined);

    const failed = await db.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(failed).toMatchObject({ status: "FAILED", failedStep: "scene" });
    const estimated = await db.costLedger.findMany({ where: { contentItemId: item.id, category: "VIDEO_SECONDS" } });
    expect(estimated).toHaveLength(2);
    expect(estimated.every((c) => c.basis === "ESTIMATED" && c.uncertaintyNote?.includes("outcome unknown"))).toBe(true);
    expect(await db.budgetReservation.count({ where: { contentItemId: item.id, status: "HELD" } })).toBe(0);

    readyAfterPolls = 0;
    polls = 0;
    await resumeProduction(op, item.id);
    await drain(item.id);
    expect(submits).toBe(4); // resubmitted, not re-polled with the old operation
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("READY");
  });
});
