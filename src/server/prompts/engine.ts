// Strict prompt templating on top of Handlebars. Templates may only use plain variables
// ({{name}}) and {{#if}}/{{#unless}}/{{else}} blocks. No helpers, partials, paths or data
// variables, so a template cannot reach anything but the values we pass in, and every
// referenced variable is known before rendering.

import Handlebars from "handlebars";
import { isContextVariable, VARIABLE_NAME, valuesSchema, type VariableDef, type VariableValues } from "@/lib/schemas/prompt";

export const MAX_TEMPLATE_CHARS = 20_000;
export const MAX_RENDERED_CHARS = 40_000;
const BLOCK_HELPERS = new Set(["if", "unless"]);

export interface TemplateIssue {
  severity: "error" | "warning";
  message: string;
  line?: number;
}

export class TemplateError extends Error {
  constructor(readonly issues: TemplateIssue[]) {
    super(issues.map((i) => (i.line ? `line ${i.line}: ${i.message}` : i.message)).join("; "));
    this.name = "TemplateError";
  }
}

type Node = hbs.AST.Node;

function line(node: Node): number | undefined {
  return node.loc?.start.line;
}

/** Walks the AST, collecting referenced variable names and any disallowed construct. */
export function analyzeTemplate(body: string): { references: string[]; issues: TemplateIssue[] } {
  const issues: TemplateIssue[] = [];
  const refs = new Set<string>();
  if (body.length > MAX_TEMPLATE_CHARS) return { references: [], issues: [{ severity: "error", message: `Template exceeds ${MAX_TEMPLATE_CHARS} characters` }] };

  let ast: hbs.AST.Program;
  try {
    ast = Handlebars.parse(body);
  } catch (err) {
    const msg = (err as Error).message.split("\n");
    const m = /line (\d+)/i.exec(msg[0] ?? "");
    return { references: [], issues: [{ severity: "error", message: `Syntax error: ${msg.slice(-1)[0] ?? msg[0]}`, line: m ? Number(m[1]) : undefined }] };
  }

  const variable = (expr: hbs.AST.Expression, where: Node) => {
    if (expr.type !== "PathExpression") {
      issues.push({ severity: "error", message: "Only variable names are allowed here", line: line(where) });
      return;
    }
    const p = expr as hbs.AST.PathExpression;
    if (p.data || p.depth > 0 || p.parts.length !== 1 || !VARIABLE_NAME.test(p.original)) {
      issues.push({ severity: "error", message: `"${p.original}" is not a valid variable reference (use lowercase names without dots)`, line: line(where) });
      return;
    }
    refs.add(p.original);
  };

  const walk = (program: hbs.AST.Program | undefined) => {
    for (const node of program?.body ?? []) {
      switch (node.type) {
        case "ContentStatement":
        case "CommentStatement":
          break;
        case "MustacheStatement": {
          const m = node as hbs.AST.MustacheStatement;
          if (m.params.length || (m.hash && m.hash.pairs.length)) {
            issues.push({ severity: "error", message: "Helpers are not allowed; use {{variable}}", line: line(node) });
            break;
          }
          variable(m.path as hbs.AST.Expression, node);
          break;
        }
        case "BlockStatement": {
          const b = node as hbs.AST.BlockStatement;
          const name = (b.path as hbs.AST.PathExpression).original;
          if (!BLOCK_HELPERS.has(name)) {
            issues.push({ severity: "error", message: `Block "{{#${name}}}" is not allowed; only {{#if}} and {{#unless}}`, line: line(node) });
            break;
          }
          if (b.params.length !== 1 || (b.hash && b.hash.pairs.length)) {
            issues.push({ severity: "error", message: `{{#${name}}} takes exactly one variable`, line: line(node) });
            break;
          }
          variable(b.params[0]!, node);
          walk(b.program);
          walk(b.inverse);
          break;
        }
        default:
          issues.push({ severity: "error", message: `${node.type.replace("Statement", "").toLowerCase()}s are not allowed`, line: line(node) });
      }
    }
  };
  walk(ast);
  return { references: [...refs].sort(), issues };
}

/** Checks a template against its declared variables. */
export function validateTemplate(body: string, defs: VariableDef[]): { references: string[]; issues: TemplateIssue[] } {
  const { references, issues } = analyzeTemplate(body);
  if (body.trim().length === 0) issues.push({ severity: "error", message: "The template is empty" });
  const declared = new Set(defs.map((d) => d.name));
  for (const ref of references) {
    if (!declared.has(ref) && !isContextVariable(ref))
      issues.push({ severity: "error", message: `Variable "${ref}" is used but not declared` });
  }
  for (const d of defs) {
    if (!references.includes(d.name)) issues.push({ severity: "warning", message: `Variable "${d.name}" is declared but never used` });
  }
  return { references, issues };
}

const env = Handlebars.create();

export interface RenderResult {
  text: string;
  values: VariableValues;
  references: string[];
}

/**
 * Renders a template. User values are validated against the declared variables; context values
 * (creator_*, campaign_*) come from the database. A referenced context variable that is not
 * available is an error, never an empty string.
 */
export function renderTemplate(body: string, defs: VariableDef[], rawValues: Record<string, unknown>, context: Partial<Record<string, string>>): RenderResult {
  const { references, issues } = validateTemplate(body, defs);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) throw new TemplateError(errors);

  const parsed = valuesSchema(defs).safeParse(rawValues);
  if (!parsed.success) throw new TemplateError(parsed.error.issues.map((i) => ({ severity: "error", message: i.message })));
  const values = parsed.data as VariableValues;

  const missingContext = references.filter((r) => isContextVariable(r) && !context[r]);
  if (missingContext.length)
    throw new TemplateError(missingContext.map((r) => ({ severity: "error", message: `"${r}" needs a ${r.startsWith("creator") ? "creator (with an approved character for prompts)" : "campaign"} context` })));

  const data: Record<string, unknown> = { ...values };
  for (const r of references) if (isContextVariable(r)) data[r] = context[r];

  const template = env.compile(body, { strict: true, noEscape: true, knownHelpersOnly: true, knownHelpers: { if: true, unless: true } });
  const text = template(data, { allowProtoPropertiesByDefault: false, allowProtoMethodsByDefault: false }).replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_RENDERED_CHARS) throw new TemplateError([{ severity: "error", message: `Rendered prompt exceeds ${MAX_RENDERED_CHARS} characters` }]);
  return { text, values, references };
}
