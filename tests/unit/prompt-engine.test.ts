import { describe, expect, it } from "vitest";
import { diffLines } from "@/lib/diff";
import { parseVariableDefs, variableDefsSchema, type VariableDef } from "@/lib/schemas/prompt";
import { analyzeTemplate, renderTemplate, TemplateError, validateTemplate } from "@/server/prompts/engine";

const defs = (d: unknown[]): VariableDef[] => variableDefsSchema.parse(d);

describe("template analysis", () => {
  it("collects variables from mustaches and if/unless blocks", () => {
    const r = analyzeTemplate("Hi {{name}}{{#if topic}} about {{topic}}{{else}} in general{{/if}}{{#unless short}}!{{/unless}}");
    expect(r.issues).toEqual([]);
    expect(r.references).toEqual(["name", "short", "topic"]);
  });

  it.each([
    ["helpers", "{{lookup this 'x'}}", /Helpers are not allowed/],
    ["each blocks", "{{#each items}}{{this}}{{/each}}", /only \{\{#if\}\}/],
    ["with blocks", "{{#with a}}{{b}}{{/with}}", /only/],
    ["partials", "{{> header}}", /partials are not allowed/],
    ["paths", "{{user.name}}", /not a valid variable/],
    ["parent paths", "{{../secret}}", /not a valid variable/],
    ["data vars", "{{@root}}", /not a valid variable/],
    ["prototype access", "{{constructor}}", /not a valid variable|not declared/],
    ["subexpressions", "{{#if (eq a b)}}x{{/if}}", /Only variable names/],
    ["syntax errors", "{{#if a}}unclosed", /Syntax error/],
  ])("rejects %s", (_n, body, msg) => {
    const { issues } = validateTemplate(body, []);
    expect(issues.some((i) => i.severity === "error" && msg.test(i.message))).toBe(true);
  });

  it("reports undeclared variables as errors and unused ones as warnings", () => {
    const { issues } = validateTemplate("{{a}} {{creator_name}}", defs([{ name: "b", type: "text" }]));
    expect(issues).toContainEqual({ severity: "error", message: 'Variable "a" is used but not declared' });
    expect(issues).toContainEqual({ severity: "warning", message: 'Variable "b" is declared but never used' });
    expect(issues.some((i) => i.message.includes("creator_name"))).toBe(false);
  });
});

describe("rendering", () => {
  const d = defs([
    { name: "topic", type: "text", required: true },
    { name: "tone", type: "enum", options: ["calm", "energetic"], default: "calm" },
    { name: "seconds", type: "number", min: 5, max: 60 },
    { name: "hook", type: "boolean", required: false },
    { name: "extra", type: "longtext", required: false },
  ]);
  const body = "{{creator_name}} talks about {{topic}} ({{tone}}, {{seconds}}s).{{#if hook}} Start with a hook.{{/if}}{{#if extra}}\n\n\n\nNote: {{extra}}{{/if}}";

  it("renders with validated values, defaults and context", () => {
    const r = renderTemplate(body, d, { topic: "rain jackets", seconds: "30", hook: "true" }, { creator_name: "Lena" });
    expect(r.text).toBe("Lena talks about rain jackets (calm, 30s). Start with a hook.");
    expect(r.values).toMatchObject({ topic: "rain jackets", tone: "calm", seconds: 30, hook: true });
  });

  it("does not HTML-escape and collapses blank lines", () => {
    const r = renderTemplate(body, d, { topic: "R&D <tips>", seconds: 10, extra: "x" }, { creator_name: "Lena" });
    expect(r.text).toContain("R&D <tips>");
    expect(r.text).toContain(").\n\nNote: x");
  });

  it("rejects missing, invalid and unknown values", () => {
    expect(() => renderTemplate(body, d, { seconds: 10 }, { creator_name: "L" })).toThrow(TemplateError);
    expect(() => renderTemplate(body, d, { topic: "x", seconds: 99 }, { creator_name: "L" })).toThrow(/≤ 60/);
    expect(() => renderTemplate(body, d, { topic: "x", seconds: 10, tone: "angry" }, { creator_name: "L" })).toThrow(/one of/);
    expect(() => renderTemplate(body, d, { topic: "x", seconds: 10, injected: "y" }, { creator_name: "L" })).toThrow();
  });

  it("requires context instead of rendering an empty value", () => {
    expect(() => renderTemplate(body, d, { topic: "x", seconds: 10 }, {})).toThrow(/creator_name.*creator/);
  });
});

describe("variable definitions", () => {
  it("reserves context names and requires enum options", () => {
    expect(variableDefsSchema.safeParse([{ name: "creator_name", type: "text" }]).success).toBe(false);
    expect(variableDefsSchema.safeParse([{ name: "x", type: "enum", options: ["one"] }]).success).toBe(false);
    expect(variableDefsSchema.safeParse([{ name: "x", type: "text" }, { name: "x", type: "text" }]).success).toBe(false);
    expect(variableDefsSchema.safeParse([{ name: "Bad-Name", type: "text" }]).success).toBe(false);
  });

  it("reads the legacy phase-1 shape and drops context names", () => {
    const parsed = parseVariableDefs({ type: "object", required: ["scene"], properties: { scene: { type: "string" }, creator_name: { type: "string" }, camera: {} } });
    expect(parsed.map((p) => [p.name, p.required])).toEqual([["scene", true], ["camera", false]]);
  });
});

describe("diffLines", () => {
  it("marks added and removed lines", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "x" },
      { op: "same", text: "c" },
    ]);
    expect(diffLines("", "new").filter((l) => l.op !== "same")).toHaveLength(2);
  });
});

describe("starter templates", () => {
  it("are valid templates with valid variables", async () => {
    const { STARTER_PROMPTS } = await import("../../prisma/starter-prompts");
    for (const p of STARTER_PROMPTS) {
      const defs = variableDefsSchema.parse(p.variables);
      const errors = validateTemplate(p.body, defs).issues.filter((i) => i.severity === "error");
      expect(errors, p.key).toEqual([]);
      const warnings = validateTemplate(p.body, defs).issues.filter((i) => i.severity === "warning");
      expect(warnings, p.key).toEqual([]);
    }
  });
});
