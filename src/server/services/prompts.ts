// Prompt Studio domain logic. Published versions are immutable (also enforced by a database
// trigger); generations and test runs pin the exact version and store the rendered prompt.

import type { Prisma, PromptKind, PromptScope, PromptVersion } from "@prisma/client";
import { z } from "zod";
import { can, type Permission } from "@/lib/rbac";
import {
  parseVariableDefs,
  PROMPT_KINDS,
  PROMPT_SCOPES,
  RULE_KINDS,
  serializeVariableDefs,
  TEXT_KINDS,
  variableDefsSchema,
  type ContextVariable,
  type VariableDef,
} from "@/lib/schemas/prompt";
import { db } from "../db";
import { recordAudit } from "../audit";
import { DomainError } from "../errors";
import { renderTemplate, TemplateError, validateTemplate, type TemplateIssue } from "../prompts/engine";
import { MOCK_TEXT_PROVIDER, mockGenerateText } from "../providers/mock-text";
import type { ActingUser } from "./users";

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

const CLOSED_CAMPAIGN = ["COMPLETED", "ARCHIVED"] as const;

export const createTemplateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "Keys use lowercase letters, digits and . _ - (e.g. caption.instagram.default)")
      .max(80),
    name: z.string().trim().min(2).max(80),
    kind: z.enum(PROMPT_KINDS),
    scope: z.enum(PROMPT_SCOPES),
    creatorId: z.string().uuid().nullable().default(null),
    campaignId: z.string().uuid().nullable().default(null),
    description: z.string().trim().max(500).default(""),
  })
  .refine((t) => (t.scope === "CREATOR") === (t.creatorId !== null), { message: "Creator templates need a creator (and only those)", path: ["creatorId"] })
  .refine((t) => (t.scope === "CAMPAIGN") === (t.campaignId !== null), { message: "Campaign templates need a campaign (and only those)", path: ["campaignId"] });

export const draftSchema = z.object({
  body: z.string().max(20_000),
  variables: variableDefsSchema,
  defaultParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/** Publishing templates that every creator uses, or rule templates, needs an admin. */
function publishPermission(template: { scope: PromptScope; kind: PromptKind }): Permission {
  return template.scope === "GLOBAL" || (RULE_KINDS as readonly string[]).includes(template.kind) ? "prompts:publish" : "prompts:edit";
}

export async function createTemplate(by: ActingUser, raw: z.input<typeof createTemplateSchema>) {
  require(by, "prompts:edit");
  const input = createTemplateSchema.parse(raw);
  if (await db.promptTemplate.findUnique({ where: { key: input.key }, select: { id: true } })) throw new DomainError("A template with this key already exists");
  if (input.creatorId && !(await db.creator.findUnique({ where: { id: input.creatorId }, select: { id: true } }))) throw new DomainError("Creator not found");
  if (input.campaignId && !(await db.campaign.findUnique({ where: { id: input.campaignId }, select: { id: true } }))) throw new DomainError("Campaign not found");
  return db.$transaction(async (tx) => {
    const template = await tx.promptTemplate.create({ data: input, select: { id: true, key: true } });
    await tx.promptVersion.create({
      data: { templateId: template.id, version: 1, status: "DRAFT", body: "", variablesSchema: serializeVariableDefs([]), createdById: by.id },
    });
    await recordAudit(by.actor, { action: "prompt.template_created", entityType: "prompt_template", entityId: template.id, metadata: { key: input.key, kind: input.kind, scope: input.scope } }, tx);
    return template;
  });
}

export async function setTemplateArchived(by: ActingUser, templateId: string, archived: boolean) {
  require(by, "prompts:edit");
  const t = await db.promptTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new DomainError("Template not found");
  if (archived) {
    const pins = await db.campaignPromptPin.count({ where: { templateId, campaign: { status: { notIn: [...CLOSED_CAMPAIGN] } } } });
    if (pins) throw new DomainError(`Unpin this template from ${pins} open campaign(s) before archiving`);
  }
  await db.$transaction(async (tx) => {
    await tx.promptTemplate.update({ where: { id: templateId }, data: { archivedAt: archived ? new Date() : null } });
    await recordAudit(by.actor, { action: archived ? "prompt.template_archived" : "prompt.template_restored", entityType: "prompt_template", entityId: templateId }, tx);
  });
}

async function loadVersion(versionId: string) {
  const v = await db.promptVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  if (!v) throw new DomainError("Prompt version not found");
  return v;
}

export function versionIssues(v: Pick<PromptVersion, "body" | "variablesSchema">): { defs: VariableDef[]; issues: TemplateIssue[]; references: string[] } {
  let defs: VariableDef[];
  try {
    defs = parseVariableDefs(v.variablesSchema);
  } catch {
    return { defs: [], issues: [{ severity: "error", message: "Stored variable definitions are invalid" }], references: [] };
  }
  return { defs, ...validateTemplate(v.body, defs) };
}

export async function saveDraft(by: ActingUser, versionId: string, raw: z.input<typeof draftSchema>) {
  require(by, "prompts:edit");
  const input = draftSchema.parse(raw);
  const v = await loadVersion(versionId);
  if (v.status !== "DRAFT") throw new DomainError("Published versions are immutable; create a new draft");
  if (v.template.archivedAt) throw new DomainError("The template is archived");
  await db.$transaction(async (tx) => {
    const res = await tx.promptVersion.updateMany({
      where: { id: versionId, status: "DRAFT" },
      data: { body: input.body, variablesSchema: serializeVariableDefs(input.variables) as Prisma.InputJsonValue, defaultParams: input.defaultParams },
    });
    if (res.count !== 1) throw new DomainError("This version was published meanwhile");
    await recordAudit(by.actor, { action: "prompt.draft_saved", entityType: "prompt_version", entityId: versionId }, tx);
  });
  // Drafts may be saved while incomplete; the issues are shown to the editor and block publishing.
  return validateTemplate(input.body, input.variables).issues;
}

export async function createDraftVersion(by: ActingUser, templateId: string) {
  require(by, "prompts:edit");
  const template = await db.promptTemplate.findUnique({ where: { id: templateId }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!template) throw new DomainError("Template not found");
  if (template.archivedAt) throw new DomainError("The template is archived");
  if (template.versions.some((v) => v.status === "DRAFT")) throw new DomainError("This template already has a draft version");
  const base = template.versions.find((v) => v.status === "PUBLISHED") ?? template.versions[0];
  const version = (template.versions[0]?.version ?? 0) + 1;
  return db.$transaction(async (tx) => {
    const draft = await tx.promptVersion.create({
      data: {
        templateId,
        version,
        status: "DRAFT",
        body: base?.body ?? "",
        variablesSchema: (base?.variablesSchema ?? serializeVariableDefs([])) as Prisma.InputJsonValue,
        defaultParams: (base?.defaultParams ?? {}) as Prisma.InputJsonValue,
        createdById: by.id,
      },
    });
    await recordAudit(by.actor, { action: "prompt.draft_created", entityType: "prompt_version", entityId: draft.id, metadata: { templateId, version, basedOn: base?.version ?? null } }, tx);
    return draft;
  });
}

export async function publishVersion(by: ActingUser, versionId: string, changelogRaw: string) {
  const v = await loadVersion(versionId);
  require(by, publishPermission(v.template));
  const changelog = changelogRaw.trim();
  if (changelog.length < 3) throw new DomainError("Describe what changed in this version");
  if (v.status !== "DRAFT") throw new DomainError("Only drafts can be published");
  const { issues } = versionIssues(v);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) throw new DomainError(`Fix the template before publishing: ${errors.map((e) => e.message).join("; ")}`);
  await db.$transaction(async (tx) => {
    const res = await tx.promptVersion.updateMany({ where: { id: versionId, status: "DRAFT" }, data: { status: "PUBLISHED", publishedAt: new Date(), changelog } });
    if (res.count !== 1) throw new DomainError("This version changed meanwhile");
    await recordAudit(by.actor, { action: "prompt.published", entityType: "prompt_version", entityId: versionId, metadata: { templateId: v.templateId, version: v.version, changelog } }, tx);
  });
}

export async function deprecateVersion(by: ActingUser, versionId: string) {
  const v = await loadVersion(versionId);
  require(by, publishPermission(v.template));
  if (v.status !== "PUBLISHED") throw new DomainError("Only published versions can be deprecated");
  const pins = await db.campaignPromptPin.findMany({ where: { promptVersionId: versionId, campaign: { status: { notIn: [...CLOSED_CAMPAIGN] } } }, include: { campaign: { select: { name: true } } } });
  if (pins.length) throw new DomainError(`Pinned by open campaign(s): ${pins.map((p) => p.campaign.name).join(", ")}. Re-pin them first.`);
  await db.$transaction(async (tx) => {
    await tx.promptVersion.update({ where: { id: versionId }, data: { status: "DEPRECATED" } });
    await recordAudit(by.actor, { action: "prompt.deprecated", entityType: "prompt_version", entityId: versionId, metadata: { templateId: v.templateId, version: v.version } }, tx);
  });
}

export async function pinVersion(by: ActingUser, campaignId: string, versionId: string | null, templateId: string) {
  require(by, "prompts:edit");
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  if (!campaign) throw new DomainError("Campaign not found");
  if ((CLOSED_CAMPAIGN as readonly string[]).includes(campaign.status)) throw new DomainError("Closed campaigns cannot be changed");
  const existing = await db.campaignPromptPin.findUnique({ where: { campaignId_templateId: { campaignId, templateId } } });
  await db.$transaction(async (tx) => {
    if (versionId === null) {
      if (!existing) return;
      await tx.campaignPromptPin.delete({ where: { campaignId_templateId: { campaignId, templateId } } });
    } else {
      const v = await tx.promptVersion.findUnique({ where: { id: versionId }, select: { status: true, templateId: true } });
      if (!v || v.templateId !== templateId) throw new DomainError("Prompt version not found");
      if (v.status !== "PUBLISHED") throw new DomainError("Only published versions can be pinned");
      await tx.campaignPromptPin.upsert({
        where: { campaignId_templateId: { campaignId, templateId } },
        create: { campaignId, templateId, promptVersionId: versionId, pinnedById: by.id },
        update: { promptVersionId: versionId, pinnedById: by.id, pinnedAt: new Date() },
      });
    }
    await recordAudit(
      by.actor,
      { action: versionId ? "prompt.pinned" : "prompt.unpinned", entityType: "campaign", entityId: campaignId, metadata: { templateId, versionId, previous: existing?.promptVersionId ?? null } },
      tx,
    );
  });
}

/**
 * Which published version applies? A campaign pin wins; otherwise the latest published version of
 * the most specific template: campaign-scoped → creator-scoped → global (ties broken by key).
 */
export async function resolvePromptVersion(q: { templateKey?: string; kind?: PromptKind; creatorId?: string | null; campaignId?: string | null }) {
  if (!q.templateKey && !q.kind) throw new Error("templateKey or kind is required");
  const scopes: Prisma.PromptTemplateWhereInput[] = [
    ...(q.campaignId ? [{ scope: "CAMPAIGN" as const, campaignId: q.campaignId }] : []),
    ...(q.creatorId ? [{ scope: "CREATOR" as const, creatorId: q.creatorId }] : []),
    { scope: "GLOBAL" as const },
  ];
  for (const scope of scopes) {
    const templates = await db.promptTemplate.findMany({
      where: { ...scope, archivedAt: null, ...(q.templateKey ? { key: q.templateKey } : { kind: q.kind }) },
      orderBy: { key: "asc" },
      select: { id: true },
    });
    for (const t of templates) {
      if (q.campaignId) {
        const pin = await db.campaignPromptPin.findUnique({ where: { campaignId_templateId: { campaignId: q.campaignId, templateId: t.id } }, include: { promptVersion: true } });
        if (pin) return { version: pin.promptVersion, pinned: true };
      }
      const latest = await db.promptVersion.findFirst({ where: { templateId: t.id, status: "PUBLISHED" }, orderBy: { version: "desc" } });
      if (latest) return { version: latest, pinned: false };
    }
  }
  return null;
}

export async function buildContext(creatorId?: string | null, campaignId?: string | null): Promise<Partial<Record<ContextVariable, string>>> {
  const ctx: Partial<Record<ContextVariable, string>> = {};
  if (creatorId) {
    const c = await db.creator.findUnique({
      where: { id: creatorId },
      include: { characterProfiles: { where: { status: "APPROVED" }, select: { identityPrompt: true, negativePrompt: true } } },
    });
    if (!c) throw new DomainError("Creator not found");
    Object.assign(ctx, {
      creator_name: c.name,
      creator_niche: c.niche,
      creator_audience: c.targetAudience,
      creator_language: c.language,
      creator_tone: c.toneOfVoice,
      creator_personality: c.personality,
      creator_identity_prompt: c.characterProfiles[0]?.identityPrompt || undefined,
      creator_negative_prompt: c.characterProfiles[0]?.negativePrompt || undefined,
    });
  }
  if (campaignId) {
    const c = await db.campaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new DomainError("Campaign not found");
    Object.assign(ctx, { campaign_name: c.name, campaign_objective: c.objective || undefined, campaign_brief: c.brief || undefined });
  }
  return ctx;
}

/** Published global safety rules, rendered with the same context; appended to generative prompts. */
export async function renderSafetyRules(context: Partial<Record<string, string>>): Promise<string | null> {
  const templates = await db.promptTemplate.findMany({ where: { kind: "SAFETY_RULES", scope: "GLOBAL", archivedAt: null }, orderBy: { key: "asc" }, select: { id: true } });
  const parts: string[] = [];
  for (const t of templates) {
    const v = await db.promptVersion.findFirst({ where: { templateId: t.id, status: "PUBLISHED" }, orderBy: { version: "desc" } });
    if (!v) continue;
    const defs = parseVariableDefs(v.variablesSchema);
    parts.push(renderTemplate(v.body, defs, {}, context).text);
  }
  return parts.length ? parts.join("\n\n") : null;
}

export interface RenderedPrompt {
  text: string;
  safetyRules: string | null;
  values: Record<string, unknown>;
}

export async function renderVersion(versionId: string, values: Record<string, unknown>, opts: { creatorId?: string | null; campaignId?: string | null } = {}): Promise<RenderedPrompt> {
  const v = await loadVersion(versionId);
  const context = await buildContext(opts.creatorId, opts.campaignId);
  try {
    const { defs } = versionIssues(v);
    const rendered = renderTemplate(v.body, defs, values, context);
    const safetyRules = (RULE_KINDS as readonly string[]).includes(v.template.kind) ? null : await renderSafetyRules(context);
    return { text: rendered.text, safetyRules, values: rendered.values };
  } catch (err) {
    if (err instanceof TemplateError) throw new DomainError(err.message);
    throw err;
  }
}

export const testRunSchema = z.object({
  versionId: z.string().uuid(),
  values: z.record(z.string(), z.unknown()).default({}),
  creatorId: z.string().uuid().nullable().default(null),
  campaignId: z.string().uuid().nullable().default(null),
});

/**
 * Records a test of a version. Text kinds run against the text provider (mock until phase 4);
 * visual and rule kinds are rendered only. Cost is recorded per run: mock and render-only runs cost
 * a known 0, real provider runs will book their measured cost.
 */
export async function runPromptTest(by: ActingUser, raw: z.input<typeof testRunSchema>) {
  require(by, "prompts:edit");
  const input = testRunSchema.parse(raw);
  const v = await loadVersion(input.versionId);
  if (v.status === "DEPRECATED") throw new DomainError("Deprecated versions cannot be tested");
  const started = Date.now();
  const rendered = await renderVersion(v.id, input.values, input);
  const generates = (TEXT_KINDS as readonly string[]).includes(v.template.kind);
  const fullPrompt = rendered.safetyRules ? `${rendered.text}\n\n---\nRules:\n${rendered.safetyRules}` : rendered.text;

  const run = await db.$transaction(async (tx) => {
    const created = await tx.promptTestRun.create({
      data: {
        promptVersionId: v.id,
        creatorId: input.creatorId,
        campaignId: input.campaignId,
        variables: rendered.values as Prisma.InputJsonValue,
        renderedPrompt: rendered.text,
        safetyRules: rendered.safetyRules,
        status: generates ? "SUCCEEDED" : "RENDERED",
        providerKey: generates ? MOCK_TEXT_PROVIDER : null,
        isMock: generates,
        output: generates ? mockGenerateText(fullPrompt, v.template.kind) : null,
        costMicros: 0n,
        costBasis: "MEASURED",
        durationMs: Date.now() - started,
        createdById: by.id,
      },
    });
    await recordAudit(by.actor, { action: "prompt.test_run", entityType: "prompt_version", entityId: v.id, metadata: { testRunId: created.id, status: created.status, isMock: created.isMock } }, tx);
    return created;
  });
  return run;
}
