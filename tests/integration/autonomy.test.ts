import { readFileSync } from "node:fs";
import path from "node:path";
import type { AutonomyPolicy } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toMicros } from "@/lib/money";
import { findActivePause, setControlSwitch } from "@/server/controls";
import { db } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { setProviderEnabled, setProviderPricing, syncProviderRegistry, updateProviderConfig } from "@/server/providers/registry";
import { closeQueues, getQueue } from "@/server/queue/queues";
import { redis } from "@/server/redis";
import { AUTOPILOT_EMAIL, autopilotUser, runAutopilot } from "@/server/services/autopilot";
import { checkBudgetsAfterCharge } from "@/server/services/budget-watch";
import { changeCampaignStatus, createCampaign, setCampaignBudget } from "@/server/services/campaigns";
import { setAutonomyMode, setCreatorBudget } from "@/server/services/creators";
import { createContent } from "@/server/services/content";
import { runContentStepJob } from "@/server/services/content-pipeline";
import { changeBudget, changePolicy, decideApproval } from "@/server/services/policy-admin";
import { completeConnect, decideConnection, startConnect, updateAccountLimits } from "@/server/services/social";
import { changeRole, createUser, setUserDisabled } from "@/server/services/users";
import { mockConsentCode } from "@/server/platforms/mock";
import { acting, makeCreator, makeSocialAccount, makeUser, uid } from "./helpers";
import { drain, readyCreator, signal } from "./pipeline-helpers";

const ORIGIN = "http://localhost:3000";
let owner: ReturnType<typeof acting>;
let admin: ReturnType<typeof acting>;
let savedGlobal: AutonomyPolicy | null;

const POLICY_VALUES = {
  maxCostPerJobEur: "5.00",
  maxGenerationsPerItem: 6,
  maxConcurrentJobs: 10,
  maxPostsPerDay: 3,
  maxWorkflowMinutes: 180,
  maxRetries: 3,
  maxNewItemsPerDay: 1,
  autoApproveMinScore: null as number | null,
  requireHumanApproval: false,
};

async function setGlobalPolicy(values: Partial<AutonomyPolicy>) {
  await db.autonomyPolicy.deleteMany({ where: { scope: "GLOBAL" } });
  await db.autonomyPolicy.create({ data: { scope: "GLOBAL", maxCostPerJobMicros: toMicros("5.00"), maxGenerationsPerItem: 6, maxConcurrentJobs: 10, maxPostsPerDay: 3, maxWorkflowMinutes: 180, maxRetries: 3, ...values } });
}

beforeAll(async () => {
  process.env.MOCK_MODE = "true";
  resetEnvCache();
  await syncProviderRegistry();
  owner = acting(await makeUser("OWNER"));
  admin = acting(await makeUser("ADMIN"));
  savedGlobal = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" } });
});

afterAll(async () => {
  await db.autonomyPolicy.deleteMany({ where: { scope: "GLOBAL" } });
  if (savedGlobal) await db.autonomyPolicy.create({ data: savedGlobal });
  await db.budgetPolicy.deleteMany({ where: { scope: "GLOBAL", period: "DAY" } });
  await db.controlSwitch.updateMany({ where: { paused: true }, data: { paused: false } });
  for (const q of ["generation-text", "generation-image", "publishing"] as const) await getQueue(q).obliterate({ force: true });
  await closeQueues();
  redis().disconnect();
});

describe("no limit can be changed through an agent path", () => {
  it("rejects every limit, budget, switch, link and user change by the autopilot, whatever role it claims", async () => {
    const pilot = await autopilotUser();
    // Even with the owner's role, an automated actor is refused.
    const agent = { ...pilot, role: "OWNER" as const };
    const creator = await makeCreator();
    const campaign = await createCampaign(owner, { name: `Campaign ${uid()}`, objective: "test", creatorIds: [creator.id] });
    const account = await makeSocialAccount(creator.id);
    const provider = await db.aiProvider.findFirstOrThrow({ where: { key: "anthropic" } });
    const other = await makeUser("VIEWER");
    await setGlobalPolicy({ maxNewItemsPerDay: 1 });
    const before = await db.autonomyPolicy.findFirstOrThrow({ where: { scope: "GLOBAL" } });
    await db.controlSwitch.create({ data: { scope: "CREATOR", targetId: creator.id, paused: true, reason: "test pause" } });
    const request = await changeBudget(admin, { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitEur: null, reason: "" }).catch(() => null);

    const attempts: [string, () => Promise<unknown>][] = [
      ["changePolicy", () => changePolicy(agent, { scope: "GLOBAL", values: { ...POLICY_VALUES, maxPostsPerDay: 50 } })],
      ["changeBudget", () => changeBudget(agent, { scope: "GLOBAL", period: "MONTH", limitEur: "999999" })],
      ["decideApproval", () => decideApproval(agent, request && !request.applied ? request.approvalId : "00000000-0000-0000-0000-000000000000", true)],
      ["setAutonomyMode", () => setAutonomyMode(agent, creator.id, "CONTROLLED_AUTONOMY")],
      ["setCreatorBudget", () => setCreatorBudget(agent, creator.id, "MONTH", null)],
      ["setCampaignBudget", () => setCampaignBudget(agent, campaign.id, "MONTH", null)],
      ["changeCampaignStatus", () => changeCampaignStatus(agent, campaign.id, "activate")],
      ["startConnect", () => startConnect(agent, { creatorId: creator.id, platform: "INSTAGRAM" }, ORIGIN)],
      ["decideConnection", () => decideConnection(agent, account.id, true)],
      ["updateAccountLimits", () => updateAccountLimits(agent, account.id, { maxPostsPerDay: 50, minGapMinutes: 0 })],
      ["updateProviderConfig", () => updateProviderConfig(agent.actor, provider.id, { maxRequestsPerMinute: 10_000 })],
      ["setProviderPricing", () => setProviderPricing(agent.actor, provider.id, {})],
      ["setProviderEnabled", () => setProviderEnabled(agent.actor, provider.id, true)],
      ["resume switch", () => setControlSwitch(agent.actor, { scope: "CREATOR", targetId: creator.id, paused: false, reason: "agent resume" })],
      ["createUser", () => createUser(agent, { email: `x-${uid()}@test.local`, name: "x", role: "OWNER", password: "correct-horse-battery" })],
      ["changeRole", () => changeRole(agent, other.id, "OWNER")],
      ["setUserDisabled", () => setUserDisabled(agent, other.id, true)],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toThrow(/person|human/i);
    }

    expect(await db.autonomyPolicy.findFirstOrThrow({ where: { scope: "GLOBAL" } })).toEqual(before);
    expect(await findActivePause({ chain: "generation", creatorId: creator.id })).toMatchObject({ scope: "CREATOR" });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).role).toBe("VIEWER");
  });

  it("keeps the autopilot module away from every limit-changing function", () => {
    const source = readFileSync(path.join(process.cwd(), "src/server/services/autopilot.ts"), "utf8");
    // Type-only imports (ActingUser) carry no behaviour.
    const imports = [...source.matchAll(/^import (?!type )[^;]*from "([^"]+)"/gm)].map((m) => m[1]!);
    for (const banned of ["policy-admin", "creators", "campaigns", "social", "users", "registry", "budget-watch", "cost-manager", "insights"]) {
      expect(imports.some((i) => i.endsWith(`/${banned}`)), banned).toBe(false);
    }
    for (const fn of ["setControlSwitch", "changePolicy", "changeBudget", "decideApproval", "decideExperiment", "setAutonomyMode", "autonomyPolicy.", "budgetPolicy.", "controlSwitch."]) {
      expect(source.includes(fn), fn).toBe(false);
    }
  });

  it("gives the autopilot a service identity that can never sign in or be edited", async () => {
    const pilot = await autopilotUser();
    const row = await db.user.findUniqueOrThrow({ where: { email: AUTOPILOT_EMAIL } });
    expect(row).toMatchObject({ isSystem: true, role: "OPERATOR" });
    expect(row.disabledAt).not.toBeNull();
    expect(pilot.actor.type).toBe("AGENT");
    await expect(db.user.update({ where: { id: row.id }, data: { disabledAt: null } })).rejects.toThrow(/users_system_disabled/);
    await expect(changeRole(owner, row.id, "OWNER")).rejects.toThrow(/service identity/);
    await expect(setUserDisabled(owner, row.id, false)).rejects.toThrow(/service identity/);
  });
});

describe("raising a limit needs the owner", () => {
  it("files an admin's budget increase as a request; the owner's approval applies it", async () => {
    const creator = await makeCreator();
    await changeBudget(admin, { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitEur: "10" });
    const res = await changeBudget(admin, { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitEur: "50", reason: "launch week" });
    expect(res.applied).toBe(false);
    // Asking twice stays one request.
    expect(await changeBudget(admin, { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitEur: "50", reason: "launch week" })).toEqual(res);
    const budget = () => db.budgetPolicy.findFirstOrThrow({ where: { scope: "CREATOR", targetId: creator.id, period: "MONTH" } });
    expect((await budget()).limitMicros).toBe(toMicros("10"));
    expect(await db.notification.findFirst({ where: { type: "approval.requested", body: { contains: "launch" } } })).toBeNull();
    expect(await db.notification.count({ where: { type: "approval.requested", body: { contains: "50,00" } } })).toBe(1);

    const approvalId = (res as { approvalId: string }).approvalId;
    await expect(decideApproval(admin, approvalId, true)).rejects.toThrow(/owner/);
    await decideApproval(owner, approvalId, true, "ok for launch");
    expect((await budget()).limitMicros).toBe(toMicros("50"));
    expect(await db.approval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ decision: "APPROVED", decidedById: owner.id });
    await expect(decideApproval(owner, approvalId, true)).rejects.toThrow(/not pending/);

    // Lowering is immediate for an admin.
    expect(await changeBudget(admin, { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitEur: "20" })).toEqual({ applied: true });
    expect((await budget()).limitMicros).toBe(toMicros("20"));
  });

  it("files a looser autonomy policy as a request and rejects a stale one", async () => {
    await setGlobalPolicy({ maxNewItemsPerDay: 1 });
    // Tightening applies directly.
    expect(await changePolicy(admin, { scope: "GLOBAL", values: { ...POLICY_VALUES, maxPostsPerDay: 2 } })).toEqual({ applied: true });
    const looser = await changePolicy(admin, { scope: "GLOBAL", values: { ...POLICY_VALUES, maxPostsPerDay: 2, autoApproveMinScore: 80 } });
    expect(looser.applied).toBe(false);
    expect((await db.autonomyPolicy.findFirstOrThrow({ where: { scope: "GLOBAL" } })).autoApproveMinScore).toBeNull();
    // Someone tightens meanwhile: the request no longer matches what the owner would approve.
    await changePolicy(admin, { scope: "GLOBAL", values: { ...POLICY_VALUES, maxPostsPerDay: 1 } });
    await expect(decideApproval(owner, (looser as { approvalId: string }).approvalId, true)).rejects.toThrow(/changed after this request/);
    // The owner changes it directly, recorded as an approved change.
    expect(await changePolicy(owner, { scope: "GLOBAL", values: { ...POLICY_VALUES, autoApproveMinScore: 80 }, reason: "trial" })).toEqual({ applied: true });
    expect(await db.approval.findFirst({ where: { subjectType: "POLICY_CHANGE", decision: "APPROVED", decidedById: owner.id } })).not.toBeNull();
  });
});

describe("exceeding a limit pauses the right scope", () => {
  async function charge(creatorId: string, eur: string) {
    await db.costLedger.create({ data: { entryType: "CHARGE", category: "IMAGE", basis: "MEASURED", amountMicros: toMicros(eur), creatorId, idempotencyKey: `test:${uid()}` } });
    return checkBudgetsAfterCharge({ creatorId });
  }

  it("pauses only the creator whose budget ran out, warns first, and needs a person to resume", async () => {
    const [a, b] = [await makeCreator(), await makeCreator()];
    await db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: a.id, period: "MONTH", limitMicros: toMicros("1"), warnAtPercent: 50, autoPause: true } });
    await charge(a.id, "0.60");
    expect(await db.notification.count({ where: { type: "budget.warning", title: { contains: a.name } } })).toBe(1);
    expect(await findActivePause({ chain: "generation", creatorId: a.id })).toBeNull();

    const paused = await charge(a.id, "0.50");
    expect(paused).toHaveLength(1);
    expect(await findActivePause({ chain: "generation", creatorId: a.id })).toMatchObject({ scope: "CREATOR", targetId: a.id });
    expect(await findActivePause({ chain: "generation", creatorId: b.id })).toBeNull();
    expect(await findActivePause({ chain: "generation" })).toBeNull();
    // Charging again does not stack pauses or notifications.
    await charge(a.id, "0.10");
    expect(await db.notification.count({ where: { type: "budget.auto_paused", title: { contains: a.name } } })).toBe(1);

    const pilot = await autopilotUser();
    await expect(setControlSwitch(pilot.actor, { scope: "CREATOR", targetId: a.id, paused: false, reason: "resume" })).rejects.toThrow(/person/);
    await setControlSwitch(admin.actor, { scope: "CREATOR", targetId: a.id, paused: false, reason: "budget reviewed" });
    expect(await findActivePause({ chain: "generation", creatorId: a.id })).toBeNull();
  });

  it("pauses the whole generation chain when the farm-wide budget runs out", async () => {
    const creator = await makeCreator();
    await db.budgetPolicy.create({ data: { scope: "GLOBAL", period: "DAY", limitMicros: 1n, autoPause: true } });
    await charge(creator.id, "0.01");
    expect(await findActivePause({ chain: "generation" })).toMatchObject({ scope: "ALL_GENERATION" });
    expect(await findActivePause({ chain: "publishing" })).toBeNull();
    await db.budgetPolicy.deleteMany({ where: { scope: "GLOBAL", period: "DAY" } });
    await setControlSwitch(owner.actor, { scope: "ALL_GENERATION", paused: false, reason: "test done" });
  });
});

describe("autopilot planning within policy", () => {
  async function connectedAccount(creatorId: string) {
    const url = await startConnect(owner, { creatorId, platform: "INSTAGRAM" }, ORIGIN);
    const state = new URL(url, ORIGIN).searchParams.get("state")!;
    return completeConnect(owner, { platform: "INSTAGRAM", state, code: mockConsentCode(`auto_${uid()}`), error: null });
  }

  async function plannedCreator(mode: "MANUAL" | "ASSISTED" | "CONTROLLED_AUTONOMY") {
    const creator = await readyCreator();
    await db.creator.update({
      where: { id: creator.id },
      data: {
        autonomyMode: mode,
        contentPillars: [{ name: "Rainy-day style", description: "" }, { name: "Coffee spots", description: "" }],
        publishingSchedule: { slots: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ platform: "INSTAGRAM", weekday, time: "18:00" })) },
      },
    });
    return creator;
  }

  const pilotItems = async (creatorId: string) => db.contentItem.findMany({ where: { creatorId, createdById: (await autopilotUser()).id }, orderBy: { createdAt: "asc" } });

  it("does nothing for a creator in manual mode", async () => {
    const creator = await plannedCreator("MANUAL");
    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators).toHaveLength(0);
    expect(await pilotItems(creator.id)).toHaveLength(0);
  });

  it("starts nothing until a person sets a daily quota", async () => {
    await setGlobalPolicy({ maxNewItemsPerDay: null });
    const creator = await plannedCreator("CONTROLLED_AUTONOMY");
    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]).toMatchObject({ created: 0 });
    expect(run.creators[0]!.skipped.join(" ")).toMatch(/no daily quota/);
    expect(await pilotItems(creator.id)).toHaveLength(0);
  });

  it("assisted: produces up to the daily quota and leaves review to a person", async () => {
    await setGlobalPolicy({ maxNewItemsPerDay: 2, autoApproveMinScore: 0 });
    const creator = await plannedCreator("ASSISTED");
    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]).toMatchObject({ created: 2, approved: 0, scheduled: 0 });
    const items = await pilotItems(creator.id);
    expect(items.map((i) => i.title)).toEqual(["Rainy-day style: autopilot idea", "Coffee spots: autopilot idea"]);
    for (const i of items) await drain(i.id);
    expect((await pilotItems(creator.id)).map((i) => i.status)).toEqual(["READY", "READY"]);

    // Quota reached for today; nothing approved in assisted mode.
    const again = await runAutopilot({ creatorIds: [creator.id] });
    expect(again.creators[0]).toMatchObject({ created: 0, approved: 0 });
    expect(await db.auditLog.findFirst({ where: { action: "content.created", actorType: "AGENT", entityId: items[0]!.id } })).not.toBeNull();
  });

  it("controlled autonomy: approves its own items that pass QC above the bar and schedules them", async () => {
    await setGlobalPolicy({ maxNewItemsPerDay: 1, autoApproveMinScore: 0 });
    const creator = await plannedCreator("CONTROLLED_AUTONOMY");
    await connectedAccount(creator.id);
    await runAutopilot({ creatorIds: [creator.id] });
    const [item] = await pilotItems(creator.id);
    await drain(item!.id);
    const ready = await db.contentItem.findUniqueOrThrow({ where: { id: item!.id } });
    expect(ready.status).toBe("READY");

    // A creator policy that requires a person stops self-approval.
    await db.autonomyPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, requireHumanApproval: true } });
    expect((await runAutopilot({ creatorIds: [creator.id] })).creators[0]).toMatchObject({ approved: 0 });
    await db.autonomyPolicy.deleteMany({ where: { scope: "CREATOR", targetId: creator.id } });

    // A bar above the QC score stops it too.
    expect(ready.qualityScore).toBeGreaterThanOrEqual(70);
    await db.contentItem.update({ where: { id: item!.id }, data: { qualityScore: 75 } });
    await db.autonomyPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, autoApproveMinScore: 80 } });
    expect((await runAutopilot({ creatorIds: [creator.id] })).creators[0]).toMatchObject({ approved: 0 });
    await db.autonomyPolicy.deleteMany({ where: { scope: "CREATOR", targetId: creator.id } });

    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]).toMatchObject({ approved: 1, scheduled: 1 });
    const job = await db.publishingJob.findFirstOrThrow({ where: { contentItemId: item!.id } });
    expect(job).toMatchObject({ status: "SCHEDULED", isMock: true, createdById: (await autopilotUser()).id });
    expect(job.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    expect(await db.approval.findFirst({ where: { subjectType: "CONTENT_ITEM", subjectId: item!.id, decidedById: (await autopilotUser()).id } })).not.toBeNull();
  });

  it("never approves when the global policy does not allow it, and stops when paused", async () => {
    await setGlobalPolicy({ maxNewItemsPerDay: 1, autoApproveMinScore: null });
    const creator = await plannedCreator("CONTROLLED_AUTONOMY");
    await runAutopilot({ creatorIds: [creator.id] });
    const [item] = await pilotItems(creator.id);
    await drain(item!.id);
    // A creator policy cannot switch auto-approval on by itself.
    await db.autonomyPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, autoApproveMinScore: 0 } });
    const run = await runAutopilot({ creatorIds: [creator.id] });
    expect(run.creators[0]!.approved).toBe(0);
    expect(run.creators[0]!.skipped.join(" ")).toMatch(/auto-approval is off/);

    const paused = await plannedCreator("ASSISTED");
    await setControlSwitch(admin.actor, { scope: "CREATOR", targetId: paused.id, paused: true, reason: "hold" });
    expect((await runAutopilot({ creatorIds: [paused.id] })).creators[0]).toMatchObject({ created: 0 });

    await setControlSwitch(admin.actor, { scope: "ALL_GENERATION", paused: true, reason: "farm hold" });
    const farm = await runAutopilot({ creatorIds: [creator.id] });
    expect(farm.paused).toBe("farm hold");
    expect(farm.creators).toHaveLength(0);
    await setControlSwitch(admin.actor, { scope: "ALL_GENERATION", paused: false, reason: "done" });
  });
});

describe("policy checks before every step", () => {
  const step = (jobId: string) => runContentStepJob({ data: { jobId }, attemptsMade: 0, opts: { attempts: 1 } }, signal());

  it("defers a step while the creator's concurrency limit is reached, then runs it", async () => {
    await setGlobalPolicy({});
    const creator = await readyCreator();
    await db.autonomyPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, maxConcurrentJobs: 1 } });
    const busy = await createContent(owner, { creatorId: creator.id, format: "IMAGE_POST", title: "Busy item", produce: false });
    const running = await db.generationJob.create({ data: { creatorId: creator.id, contentItemId: busy.id, kind: "TEXT", step: "brief", idempotencyKey: `busy:${uid()}`, status: "RUNNING", renderedPrompt: "x", isMock: true, providerId: (await db.aiProvider.findFirstOrThrow({ where: { key: "mock-text" } })).id } });
    const item = await createContent(owner, { creatorId: creator.id, format: "IMAGE_POST", title: "Waiting item", produce: true });
    const job = await db.generationJob.findFirstOrThrow({ where: { contentItemId: item.id } });

    expect(await step(job.id)).toEqual({ deferred: "concurrency" });
    expect((await db.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");

    await db.generationJob.update({ where: { id: running.id }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
    await drain(item.id);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("READY");
  });

  it("stops the chain when production runs past the workflow limit", async () => {
    await setGlobalPolicy({ maxWorkflowMinutes: 60 });
    const creator = await readyCreator();
    const item = await createContent(owner, { creatorId: creator.id, format: "IMAGE_POST", title: "Slow item", produce: true });
    await db.contentItem.update({ where: { id: item.id }, data: { productionStartedAt: new Date(Date.now() - 2 * 3_600_000) } });
    const job = await db.generationJob.findFirstOrThrow({ where: { contentItemId: item.id } });
    await expect(step(job.id)).rejects.toThrow(/60-minute workflow limit \(global policy\)/);
    expect((await db.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("BLOCKED_POLICY");
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ failedStep: "brief", status: "IDEA" });
  });
});
