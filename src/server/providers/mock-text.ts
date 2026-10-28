// Deterministic mock text generation for tests and mock mode. Output is always visibly labelled.

import { createHash } from "node:crypto";

export const MOCK_TEXT_PROVIDER = "mock-text";

export function mockGenerateText(prompt: string, kind: string): string {
  const digest = createHash("sha256").update(`${kind}\n${prompt}`).digest("hex").slice(0, 8);
  const gist = prompt.replace(/\s+/g, " ").trim().slice(0, 160);
  return `[Mock ${kind.toLowerCase()} output ${digest}] This placeholder stands in for a real model response to: "${gist}${prompt.length > 160 ? "…" : ""}"`;
}
