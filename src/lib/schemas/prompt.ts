// Prompt template variables. Stored in prompt_versions.variables_schema as { version: 1, variables }.

import { z } from "zod";

export const PROMPT_KINDS = ["IDEATION", "CREATOR_WIZARD", "SCRIPT", "IMAGE", "VIDEO", "VOICEOVER", "CAPTION", "QUALITY_RULES", "SAFETY_RULES"] as const;
export const PROMPT_SCOPES = ["GLOBAL", "CREATOR", "CAMPAIGN"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

/** Kinds a text model can execute in a test run. Visual kinds render only until phase 4/6. */
export const TEXT_KINDS: readonly PromptKind[] = ["IDEATION", "CREATOR_WIZARD", "SCRIPT", "VOICEOVER", "CAPTION"];
export const RULE_KINDS: readonly PromptKind[] = ["QUALITY_RULES", "SAFETY_RULES"];

export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** Filled automatically from the selected creator / campaign; cannot be declared by templates. */
export const CONTEXT_VARIABLES = {
  creator_name: "Creator name",
  creator_niche: "Creator niche",
  creator_audience: "Target audience",
  creator_language: "Language tag",
  creator_tone: "Tone of voice",
  creator_personality: "Personality",
  creator_identity_prompt: "Identity prompt of the approved character version",
  creator_negative_prompt: "Negative prompt of the approved character version",
  campaign_name: "Campaign name",
  campaign_objective: "Campaign objective",
  campaign_brief: "Campaign brief",
} as const;

export type ContextVariable = keyof typeof CONTEXT_VARIABLES;
export const isContextVariable = (name: string): name is ContextVariable => Object.hasOwn(CONTEXT_VARIABLES, name);

export const VARIABLE_TYPES = ["text", "longtext", "number", "enum", "boolean"] as const;

export const variableDefSchema = z
  .object({
    name: z.string().regex(VARIABLE_NAME, "Variable names use lowercase letters, digits and _ and start with a letter"),
    label: z.string().trim().max(80).default(""),
    type: z.enum(VARIABLE_TYPES),
    required: z.boolean().default(true),
    description: z.string().trim().max(280).default(""),
    options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.string().max(10_000).optional(),
  })
  .refine((v) => !isContextVariable(v.name), { message: "This name is reserved for creator/campaign context", path: ["name"] })
  .refine((v) => v.type !== "enum" || v.options.length >= 2, { message: "Enum variables need at least two options", path: ["options"] })
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, { message: "min must be ≤ max", path: ["min"] });

export type VariableDef = z.infer<typeof variableDefSchema>;

export const variableDefsSchema = z
  .array(variableDefSchema)
  .max(40)
  .refine((defs) => new Set(defs.map((d) => d.name)).size === defs.length, "Variable names must be unique");

/** Reads stored definitions; also accepts the JSON-Schema-like shape used by the phase-1 seed. */
export function parseVariableDefs(stored: unknown): VariableDef[] {
  if (stored && typeof stored === "object" && "variables" in stored) return variableDefsSchema.parse((stored as { variables: unknown }).variables);
  if (stored && typeof stored === "object" && "properties" in stored) {
    const legacy = stored as { properties?: Record<string, unknown>; required?: string[] };
    return variableDefsSchema.parse(
      Object.keys(legacy.properties ?? {})
        .filter((name) => !isContextVariable(name))
        .map((name) => ({ name, type: "text", required: (legacy.required ?? []).includes(name) })),
    );
  }
  return [];
}

export function serializeVariableDefs(defs: VariableDef[]) {
  return { version: 1, variables: defs };
}

export type VariableValues = Record<string, string | number | boolean>;

/** Zod schema for user-supplied values of a template; raw form input arrives as strings. */
export function valuesSchema(defs: VariableDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const d of defs) {
    const label = d.label || d.name;
    let s: z.ZodType;
    switch (d.type) {
      case "number": {
        let n = z.coerce.number({ message: `${label} must be a number` });
        if (d.min !== undefined) n = n.min(d.min, `${label} must be ≥ ${d.min}`);
        if (d.max !== undefined) n = n.max(d.max, `${label} must be ≤ ${d.max}`);
        s = n;
        break;
      }
      case "boolean":
        s = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
        break;
      case "enum":
        s = z.enum(d.options as [string, ...string[]], { message: `${label} must be one of: ${d.options.join(", ")}` });
        break;
      default:
        s = z
          .string()
          .trim()
          .max(d.maxLength ?? (d.type === "longtext" ? 10_000 : 500), `${label} is too long`)
          .min(d.required ? 1 : 0, `${label} is required`);
    }
    const fallback = d.default ?? (d.type === "boolean" ? "false" : undefined);
    if (fallback !== undefined) s = z.preprocess((v) => (v === undefined || v === "" ? fallback : v), s);
    else if (!d.required) s = z.preprocess((v) => (v === undefined ? "" : v), d.type === "number" ? z.union([z.literal(""), s]) : s);
    shape[d.name] = s;
  }
  return z.object(shape).strict();
}
