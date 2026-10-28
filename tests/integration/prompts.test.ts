import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import {
  createDraftVersion,
  createTemplate,
  deprecateVersion,
  pinVersion,
  publishVersion,
  renderVersion,
  resolvePromptVersion,
  runPromptTest,
  saveDraft,
  setTemplateArchived,
} from "@/server/services/prompts";
import { acting, makeCreator, makeUser, uid } from "./helpers";

const captionVars = [
  { name: "topic", type: "text" as const, required: true },
  { name: "platform", type: "enum" as const, options: ["instagram", "tiktok"], default: "instagram" },
];
const captionBody = "Write a {{platform}} caption for {{creator_name}} about {{topic}}.";

async function publishedTemplate(by: ReturnType<typeof acting>, over: Partial<{ scope: "GLOBAL" | "CREATOR" | "CAMPAIGN"; creatorId: string; campaignId: string; kind: "CAPTION" | "IMAGE" | "SAFETY_RULES"; body: string; key: string }> = {}) {
  const t = await createTemplate(by, {
    key: over.key ?? `test.caption.${uid()}`,
    name: "Caption",
    kind: over.kind ?? "CAPTION",
    scope: over.scope ?? "GLOBAL",
    creatorId: over.creatorId ?? null,
    campaignId: over.campaignId ?? null,
  });
  const v1 = await db.promptVersion.findFirstOrThrow({ where: { templateId: t.id } });
  await saveDraft(by, v1.id, { body: over.body ?? captionBody, variables: over.kind === "SAFETY_RULES" ? [] : captionVars });
  await publishVersion(by, v1.id, "initial");
  return { template: t, v1 };
}

describe("templates and versions", () => {
  it("creates a template with an empty draft v1 and validates scope", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const t = await createTemplate(op, { key: `Script.Short.${uid()}`, name: "Short script", kind: "SCRIPT", scope: "GLOBAL" });
    expect(t.key).toBe(t.key.toLowerCase());
    expect(await db.promptVersion.findMany({ where: { templateId: t.id } })).toMatchObject([{ version: 1, status: "DRAFT", body: "" }]);
    await expect(createTemplate(op, { key: t.key, name: "dup", kind: "SCRIPT", scope: "GLOBAL" })).rejects.toThrow(/already exists/);
    await expect(createTemplate(op, { key: `x.${uid()}`, name: "bad", kind: "SCRIPT", scope: "CREATOR" })).rejects.toThrow();
    await expect(createTemplate(acting(await makeUser("VIEWER")), { key: `x.${uid()}`, name: "v", kind: "SCRIPT", scope: "GLOBAL" })).rejects.toBeInstanceOf(DomainError);
  });

  it("drafts save while incomplete, but only valid drafts publish; global needs an admin", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const admin = acting(await makeUser("ADMIN"));
    const t = await createTemplate(op, { key: `cap.${uid()}`, name: "Cap", kind: "CAPTION", scope: "GLOBAL" });
    const v1 = await db.promptVersion.findFirstOrThrow({ where: { templateId: t.id } });
    const issues = await saveDraft(op, v1.id, { body: "About {{topic}} and {{missing}}", variables: captionVars });
    expect(issues.some((i) => i.severity === "error" && i.message.includes("missing"))).toBe(true);
    await expect(publishVersion(admin, v1.id, "first")).rejects.toThrow(/Fix the template/);
    await saveDraft(op, v1.id, { body: captionBody, variables: captionVars });
    await expect(publishVersion(op, v1.id, "first")).rejects.toBeInstanceOf(DomainError); // global → admin
    await expect(publishVersion(admin, v1.id, "")).rejects.toThrow(/what changed/);
    await publishVersion(admin, v1.id, "first");
    expect((await db.promptVersion.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("PUBLISHED");
  });

  it("published versions are immutable, also at database level", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const { v1 } = await publishedTemplate(admin);
    await expect(saveDraft(admin, v1.id, { body: "changed {{topic}}", variables: captionVars })).rejects.toThrow(/immutable/);
    await expect(db.promptVersion.update({ where: { id: v1.id }, data: { body: "tampered" } })).rejects.toThrow(/immutable/);
    await expect(db.promptVersion.delete({ where: { id: v1.id } })).rejects.toThrow(/append-only/);
  });

  it("new drafts copy the published version; one draft at a time", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const { template } = await publishedTemplate(admin);
    const v2 = await createDraftVersion(admin, template.id);
    expect(v2).toMatchObject({ version: 2, status: "DRAFT", body: captionBody });
    await expect(createDraftVersion(admin, template.id)).rejects.toThrow(/already has a draft/);
  });
});

describe("rendering and tests", () => {
  it("renders with creator context and appends published safety rules", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const creator = await makeCreator({ name: `Noor ${uid()}` });
    const { v1 } = await publishedTemplate(admin);
    await publishedTemplate(admin, { kind: "SAFETY_RULES", key: `safety.${uid()}`, body: "Never imitate real people. Creator: {{creator_name}}." });
    const r = await renderVersion(v1.id, { topic: "rain" }, { creatorId: creator.id });
    expect(r.text).toBe(`Write a instagram caption for ${creator.name} about rain.`);
    expect(r.safetyRules).toContain(`Never imitate real people. Creator: ${creator.name}.`);
    await expect(renderVersion(v1.id, { topic: "rain" })).rejects.toThrow(/creator/);
  });

  it("records test runs: text kinds via the labelled mock, visual kinds render-only", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const creator = await makeCreator();
    const { v1 } = await publishedTemplate(admin);
    const run = await runPromptTest(admin, { versionId: v1.id, values: { topic: "boots" }, creatorId: creator.id });
    expect(run).toMatchObject({ status: "SUCCEEDED", isMock: true, providerKey: "mock-text", costMicros: 0n, costBasis: "MEASURED" });
    expect(run.output).toMatch(/^\[Mock caption output/);
    expect(run.renderedPrompt).toContain("about boots");

    const image = await publishedTemplate(admin, { kind: "IMAGE", key: `image.${uid()}`, body: "Photo of {{creator_name}}, {{topic}}, {{platform}}" });
    const irun = await runPromptTest(admin, { versionId: image.v1.id, values: { topic: "beach" }, creatorId: creator.id });
    expect(irun).toMatchObject({ status: "RENDERED", isMock: false, output: null, providerKey: null });
    expect(await db.auditLog.count({ where: { action: "prompt.test_run", entityId: { in: [v1.id, image.v1.id] } } })).toBe(2);
  });
});

describe("resolution, pinning and deprecation", () => {
  it("campaign pin > campaign template > creator template > global; template changes do not affect a pinned campaign", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const creator = await makeCreator();
    const campaign = await db.campaign.create({ data: { name: `Camp ${uid()}`, status: "ACTIVE" } });
    const key = `shared.caption.${uid()}`;

    const global = await publishedTemplate(admin, { key });
    expect((await resolvePromptVersion({ templateKey: key, creatorId: creator.id, campaignId: campaign.id }))?.version.id).toBe(global.v1.id);

    await pinVersion(admin, campaign.id, global.v1.id, global.template.id);
    const v2 = await createDraftVersion(admin, global.template.id);
    await saveDraft(admin, v2.id, { body: `${captionBody} Keep it short.`, variables: captionVars });
    await publishVersion(admin, v2.id, "shorter");

    expect(await resolvePromptVersion({ templateKey: key, campaignId: campaign.id })).toMatchObject({ pinned: true, version: { id: global.v1.id } });
    expect(await resolvePromptVersion({ templateKey: key })).toMatchObject({ pinned: false, version: { id: v2.id } });

    await expect(deprecateVersion(admin, global.v1.id)).rejects.toThrow(/Pinned by open campaign/);
    await pinVersion(admin, campaign.id, v2.id, global.template.id);
    await deprecateVersion(admin, global.v1.id);
    await expect(db.promptVersion.update({ where: { id: global.v1.id }, data: { status: "PUBLISHED" } })).rejects.toThrow(/revived/);
    await expect(pinVersion(admin, campaign.id, global.v1.id, global.template.id)).rejects.toThrow(/published/);

    // more specific scopes win when resolving by kind
    const kind = "VOICEOVER" as const;
    const g = await createTemplate(admin, { key: `vo.g.${uid()}`, name: "Global VO", kind, scope: "GLOBAL" });
    const cr = await createTemplate(admin, { key: `vo.c.${uid()}`, name: "Creator VO", kind, scope: "CREATOR", creatorId: creator.id });
    for (const t of [g, cr]) {
      const d = await db.promptVersion.findFirstOrThrow({ where: { templateId: t.id } });
      await saveDraft(admin, d.id, { body: "Voice-over about {{topic}}", variables: [captionVars[0]!] });
      await publishVersion(admin, d.id, "first version");
    }
    const forCreator = await resolvePromptVersion({ kind, creatorId: creator.id });
    expect((await db.promptVersion.findUniqueOrThrow({ where: { id: forCreator!.version.id } })).templateId).toBe(cr.id);
  });

  it("archiving is refused while an open campaign pins the template", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const campaign = await db.campaign.create({ data: { name: `Camp ${uid()}`, status: "DRAFT" } });
    const { template, v1 } = await publishedTemplate(admin);
    await pinVersion(admin, campaign.id, v1.id, template.id);
    await expect(setTemplateArchived(admin, template.id, true)).rejects.toThrow(/Unpin/);
    await pinVersion(admin, campaign.id, null, template.id);
    await setTemplateArchived(admin, template.id, true);
    expect(await resolvePromptVersion({ templateKey: (await db.promptTemplate.findUniqueOrThrow({ where: { id: template.id } })).key })).toBeNull();
  });
});
