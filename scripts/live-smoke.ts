// Live smoke test of the real provider adapters. Makes one tiny paid call per configured provider
// (a few hundred tokens / one low-quality image). Never runs in CI.
//   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… pnpm test:live --yes
import { AnthropicAdapter, ANTHROPIC_BULK_MODEL } from "../src/server/providers/adapters/anthropic";
import { OpenAiImagesAdapter, OPENAI_IMAGE_DEFAULT_MODEL } from "../src/server/providers/adapters/openai-images";
import { sniffImage } from "../src/lib/image-meta";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.log("This makes real, paid API calls (well under €0.10 in total). Re-run with --yes to proceed.");
    process.exit(1);
  }
  let failures = 0;
  const signal = () => AbortSignal.timeout(120_000);

  if (process.env.ANTHROPIC_API_KEY) {
    const a = new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY, timeoutMs: 60_000, effort: "low" });
    try {
      const models = await a.discoverCapabilities(signal());
      console.log(`anthropic: ${models.length} models visible`);
      const model = process.env.SMOKE_ANTHROPIC_MODEL ?? ANTHROPIC_BULK_MODEL;
      const out = await a.generate({ capability: "TEXT", model, prompt: "Reply with the single word: ready", maxOutputTokens: 200, params: {} }, signal());
      console.log(`anthropic ${model}: "${out.outputs[0]?.text?.trim()}"`, JSON.stringify(out.attempts));
    } catch (err) {
      failures++;
      console.error("anthropic FAILED:", (err as Error).message);
    }
  } else console.log("anthropic: skipped (ANTHROPIC_API_KEY not set)");

  if (process.env.OPENAI_API_KEY) {
    const o = new OpenAiImagesAdapter({ apiKey: process.env.OPENAI_API_KEY, timeoutMs: 180_000 });
    try {
      const model = process.env.SMOKE_OPENAI_IMAGE_MODEL ?? OPENAI_IMAGE_DEFAULT_MODEL;
      const models = await o.discoverCapabilities(signal());
      console.log(`openai: image models visible: ${models.map((m) => m.model).join(", ") || "none"}`);
      const out = await o.generate({ capability: "IMAGE", model, prompt: "A plain blue square", params: { size: "1024x1024", quality: "low" } }, signal());
      console.log(`openai ${model}: image`, JSON.stringify(sniffImage(out.outputs[0]!.bytes!)), JSON.stringify(out.attempts));
    } catch (err) {
      failures++;
      console.error("openai FAILED:", (err as Error).message);
    }
  } else console.log("openai: skipped (OPENAI_API_KEY not set)");

  process.exit(failures ? 1 : 0);
}

void main();
