// Deterministic mock text generation for tests and mock mode. Output is always visibly labelled.

import { createHash } from "node:crypto";

export const MOCK_TEXT_PROVIDER = "mock-text";

export function mockGenerateText(prompt: string, kind: string): string {
  const digest = createHash("sha256").update(`${kind}\n${prompt}`).digest("hex").slice(0, 8);
  const gist = prompt.replace(/\s+/g, " ").trim().slice(0, 160);
  return `[Mock ${kind.toLowerCase()} output ${digest}] This placeholder stands in for a real model response to: "${gist}${prompt.length > 160 ? "…" : ""}"`;
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; maxLength?: number };

/**
 * Deterministic JSON that satisfies a (simple) JSON Schema: every string is visibly labelled as mock
 * output, numbers take the maximum (mock QC verdicts pass, so the pipeline can be exercised end to
 * end), arrays get their minimum length (at least one item).
 */
export function mockFromSchema(schema: Schema, seed: string, path = "value", label = path): unknown {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (schema.enum?.length) return schema.enum[0];
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = mockFromSchema(v, seed, `${path}.${k}`, k);
      return out;
    }
    case "array": {
      const n = Math.max(schema.minItems ?? 1, 1);
      return Array.from({ length: Math.min(n, schema.maxItems ?? n) }, (_, i) => mockFromSchema(schema.items ?? { type: "string" }, seed, `${path}[${i}]`, label));
    }
    case "integer":
    case "number":
      return schema.maximum ?? schema.minimum ?? 1;
    case "boolean":
      return true;
    default: {
      const digest = createHash("sha256").update(`${seed}\n${path}`).digest("hex").slice(0, 6);
      // The digest covers the full path, so array items differ; the label is the field name.
      const text = `[Mock ${label.replaceAll("_", " ")} ${digest}]`;
      return schema.maxLength ? text.slice(0, schema.maxLength) : text;
    }
  }
}
