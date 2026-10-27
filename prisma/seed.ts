// Seed: idempotent. Base seed installs the owner account, provider registry, safe default limits and
// starter prompt templates. `--demo` adds clearly flagged demo creators/content (is_demo = true).

import { PrismaClient, type Prisma } from "@prisma/client";
import { hashPassword } from "../src/server/auth/password";
import { syncProviderRegistry } from "../src/server/providers/catalog";
import { toMicros } from "../src/lib/money";

const db = new PrismaClient();
const SEED_ACTOR = { actorType: "SYSTEM" as const, actorLabel: "seed" };

async function seedOwner() {
  const email = (process.env.SEED_OWNER_EMAIL ?? "owner@creatorfarm.local").toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return console.log(`owner ${email} exists`);
  if (!password || password.length < 12) throw new Error("Set SEED_OWNER_PASSWORD (min 12 chars) to create the first owner account");
  const user = await db.user.create({ data: { email, name: process.env.SEED_OWNER_NAME ?? "Farm Owner", role: "OWNER", passwordHash: await hashPassword(password) } });
  await db.auditLog.create({ data: { ...SEED_ACTOR, action: "user.created", entityType: "user", entityId: user.id, metadata: { email, role: "OWNER" } } });
  console.log(`created owner ${email}`);
}

async function seedLimits() {
  const hasGlobal = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" } });
  if (!hasGlobal) {
    await db.autonomyPolicy.create({
      data: {
        scope: "GLOBAL",
        maxCostPerJobMicros: toMicros("5.00"),
        maxGenerationsPerItem: 6,
        maxConcurrentJobs: 10,
        maxPostsPerDay: 3,
        maxWorkflowMinutes: 180,
        maxRetries: 3,
        requireHumanApproval: false,
      },
    });
  }
  const budget = process.env.SEED_MONTHLY_BUDGET_EUR;
  const hasBudget = await db.budgetPolicy.findFirst({ where: { scope: "GLOBAL", period: "MONTH" } });
  if (!hasBudget && budget) {
    await db.budgetPolicy.create({ data: { scope: "GLOBAL", period: "MONTH", limitMicros: toMicros(budget), warnAtPercent: 80, autoPause: true } });
    await db.auditLog.create({ data: { ...SEED_ACTOR, action: "budget.created", metadata: { scope: "GLOBAL", period: "MONTH", limitEur: budget } } });
  }
}

const STARTER_PROMPTS: { key: string; name: string; kind: Prisma.PromptTemplateCreateInput["kind"]; body: string; variables: string[] }[] = [
  {
    key: "image.lifestyle.default",
    name: "Lifestyle photo",
    kind: "IMAGE",
    body: "{{identity_prompt}}. Candid lifestyle photograph, {{scene}}, natural light, {{camera}}. Aspect ratio {{aspect_ratio}}.",
    variables: ["identity_prompt", "scene", "camera", "aspect_ratio"],
  },
  {
    key: "script.short_video.default",
    name: "Short video script",
    kind: "SCRIPT",
    body: "Write a {{duration_seconds}}-second vertical video script for {{creator_name}} ({{tone_of_voice}}) about {{topic}}. Return scenes with action, dialogue and on-screen text.",
    variables: ["duration_seconds", "creator_name", "tone_of_voice", "topic"],
  },
  {
    key: "caption.default",
    name: "Caption",
    kind: "CAPTION",
    body: "Write a {{platform}} caption in {{language}} for {{creator_name}} about {{topic}}. Max {{max_chars}} characters. Include the AI disclosure: {{ai_disclosure}}.",
    variables: ["platform", "language", "creator_name", "topic", "max_chars", "ai_disclosure"],
  },
  {
    key: "safety.rules.global",
    name: "Global safety rules",
    kind: "SAFETY_RULES",
    body: "Never depict or imitate real, identifiable people. No minors. No medical, financial or political claims. Follow platform AI-content labelling rules.",
    variables: [],
  },
];

async function seedPrompts() {
  for (const p of STARTER_PROMPTS) {
    const exists = await db.promptTemplate.findUnique({ where: { key: p.key } });
    if (exists) continue;
    await db.promptTemplate.create({
      data: {
        key: p.key,
        name: p.name,
        kind: p.kind,
        scope: "GLOBAL",
        versions: {
          create: {
            version: 1,
            status: "PUBLISHED",
            publishedAt: new Date(),
            body: p.body,
            variablesSchema: { type: "object", required: p.variables, properties: Object.fromEntries(p.variables.map((v) => [v, { type: "string" }])) },
            changelog: "Starter template",
          },
        },
      },
    });
  }
}

async function seedDemo() {
  if (await db.creator.findFirst({ where: { isDemo: true } })) return console.log("demo data exists");
  const now = Date.now();
  const day = 86_400_000;

  const campaign = await db.campaign.create({
    data: { name: "Autumn Wardrobe (demo)", objective: "Showcase seasonal styling", status: "ACTIVE", isDemo: true, startsAt: new Date(now - 7 * day), endsAt: new Date(now + 21 * day) },
  });

  const specs = [
    { slug: "demo-lena-studio", name: "Lena Studio", niche: "Minimal fashion & capsule wardrobes", audience: "Women 22–35 interested in sustainable fashion", language: "nl-NL", regions: ["NL", "BE"], status: "ACTIVE" as const },
    { slug: "demo-milo-moves", name: "Milo Moves", niche: "Urban fitness & mobility", audience: "Office workers 25–40", language: "en-GB", regions: ["GB", "NL"], status: "ACTIVE" as const },
    { slug: "demo-yara-eats", name: "Yara Eats", niche: "Quick plant-based recipes", audience: "Students and young professionals", language: "nl-NL", regions: ["NL"], status: "PAUSED" as const },
  ];

  for (const [i, s] of specs.entries()) {
    const creator = await db.creator.create({
      data: {
        slug: s.slug,
        name: s.name,
        niche: s.niche,
        targetAudience: s.audience,
        language: s.language,
        targetRegions: s.regions,
        personality: "Warm, curious, practical",
        toneOfVoice: "Friendly and concise",
        backstory: "Fictional character created for demonstration purposes.",
        contentPillars: ["How-to", "Behind the scenes", "Weekly picks"],
        contentFormats: ["IMAGE_POST", "SHORT_VIDEO", "CAROUSEL"],
        status: s.status,
        isDemo: true,
        characterProfiles: {
          create: {
            version: 1,
            status: "APPROVED",
            approvedAt: new Date(now - 10 * day),
            identityPrompt: `Synthetic adult character "${s.name}", consistent facial features, natural styling`,
            appearance: { ageRange: "25-30", style: "natural" },
            likenessAttestation: "Synthetic identity, not based on a real person (demo).",
          },
        },
        socialAccounts: {
          create: {
            platform: (["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const)[i]!,
            handle: s.slug.replace("demo-", "demo_"),
            status: "NOT_CONNECTED",
            isDemo: true,
          },
        },
      },
      include: { socialAccounts: true },
    });
    await db.campaignCreator.create({ data: { campaignId: campaign.id, creatorId: creator.id } });
    await db.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creator.id, period: "MONTH", limitMicros: toMicros("150.00") } });

    const statuses = ["IDEA", "SCRIPTED", "QC_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED"] as const;
    for (const [j, status] of statuses.entries()) {
      const item = await db.contentItem.create({
        data: {
          creatorId: creator.id,
          campaignId: j % 2 === 0 ? campaign.id : null,
          title: `${s.name}: demo item ${j + 1}`,
          format: j % 3 === 0 ? "SHORT_VIDEO" : "IMAGE_POST",
          status,
          isDemo: true,
          createdAt: new Date(now - (j + 1) * 2 * day),
        },
      });
      if (status === "SCHEDULED" || status === "PUBLISHED") {
        const account = creator.socialAccounts[0]!;
        const job = await db.publishingJob.create({
          data: {
            contentItemId: item.id,
            socialAccountId: account.id,
            platform: account.platform,
            scheduledFor: status === "SCHEDULED" ? new Date(now + (i + 1) * day) : new Date(now - day),
            status: status === "SCHEDULED" ? "SCHEDULED" : "PUBLISHED",
            idempotencyKey: `demo:publish:${item.id}:${account.id}`,
            isMock: true,
            confirmedAt: status === "PUBLISHED" ? new Date(now - day) : null,
          },
        });
        if (status === "PUBLISHED") {
          await db.analyticsSnapshot.create({
            data: {
              socialAccountId: account.id,
              publishingJobId: job.id,
              contentItemId: item.id,
              capturedAt: new Date(now - day / 2),
              origin: "DEMO",
              source: "demo-seed",
              views: BigInt(1200 + i * 800),
              reach: BigInt(900 + i * 500),
              likes: BigInt(80 + i * 40),
              comments: BigInt(6 + i),
              shares: BigInt(3 + i),
            },
          });
        }
      }
    }
  }
  await db.auditLog.create({ data: { ...SEED_ACTOR, action: "seed.demo_data_created", metadata: { creators: specs.length } } });
  console.log("demo data created (all rows flagged is_demo)");
}

async function main() {
  await seedOwner();
  await seedLimits();
  await syncProviderRegistry();
  await seedPrompts();
  if (process.argv.includes("--demo")) await seedDemo();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
