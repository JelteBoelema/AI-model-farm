// Live smoke test of the real provider adapters. Makes one tiny paid call per configured provider
// (a few hundred tokens / one low-quality image / one short sentence of speech). Never runs in CI.
//   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… ELEVENLABS_API_KEY=… SMOKE_VOICE_ID=… pnpm test:live --yes
// A video clip costs noticeably more, so Veo only runs with --video (one 4-second clip):
//   GOOGLE_GENAI_API_KEY=… pnpm test:live --yes --video
import { AnthropicAdapter, ANTHROPIC_BULK_MODEL } from "../src/server/providers/adapters/anthropic";
import { OpenAiImagesAdapter, OPENAI_IMAGE_DEFAULT_MODEL } from "../src/server/providers/adapters/openai-images";
import { sniffImage } from "../src/lib/image-meta";
import { ElevenLabsAdapter, ELEVENLABS_DEFAULT_MODEL } from "../src/server/providers/adapters/elevenlabs";
import { VeoAdapter, VEO_DEFAULT_MODEL } from "../src/server/providers/adapters/google-veo";
import { probe } from "../src/server/media/ffmpeg";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.log("This makes real, paid API calls (well under €0.10 in total; a --video clip costs more). Re-run with --yes to proceed.");
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

  if (process.env.ELEVENLABS_API_KEY && process.env.SMOKE_VOICE_ID) {
    const e = new ElevenLabsAdapter({ apiKey: process.env.ELEVENLABS_API_KEY, timeoutMs: 60_000 });
    try {
      const models = await e.discoverCapabilities(signal());
      console.log(`elevenlabs: speech models visible: ${models.map((m) => m.model).join(", ") || "none"}`);
      const model = process.env.SMOKE_ELEVENLABS_MODEL ?? ELEVENLABS_DEFAULT_MODEL;
      const out = await e.generate({ capability: "SPEECH", model, prompt: "This is a short test.", params: { voiceId: process.env.SMOKE_VOICE_ID } }, signal());
      const facts = await probe(out.outputs[0]!.bytes!);
      console.log(`elevenlabs ${model}: ${facts.audio?.codec} ${facts.durationMs} ms`, JSON.stringify(out.attempts));
    } catch (err) {
      failures++;
      console.error("elevenlabs FAILED:", (err as Error).message);
    }
  } else console.log("elevenlabs: skipped (ELEVENLABS_API_KEY and SMOKE_VOICE_ID needed)");

  if (process.env.GOOGLE_GENAI_API_KEY) {
    const v = new VeoAdapter({ apiKey: process.env.GOOGLE_GENAI_API_KEY, timeoutMs: 120_000 });
    try {
      const models = await v.discoverCapabilities(signal());
      console.log(`google-veo: video models visible: ${models.map((m) => m.model).join(", ") || "none"}`);
      if (process.argv.includes("--video")) {
        const model = process.env.SMOKE_VEO_MODEL ?? VEO_DEFAULT_MODEL;
        const req = { capability: "VIDEO" as const, model, prompt: "A slow pan over a plain blue wall", params: { durationSeconds: 4, aspectRatio: "9:16" } };
        const { providerJobId } = await v.submit(req, signal());
        console.log(`google-veo ${model}: submitted ${providerJobId}`);
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 10_000));
          const polled = await v.poll(providerJobId, req, signal());
          if (!polled.done) continue;
          const facts = await probe(polled.result.outputs[0]!.bytes!);
          console.log(`google-veo: ${facts.video?.width}×${facts.video?.height} ${facts.durationMs} ms`, JSON.stringify(polled.result.attempts));
          break;
        }
      } else console.log("google-veo: clip skipped (add --video)");
    } catch (err) {
      failures++;
      console.error("google-veo FAILED:", (err as Error).message);
    }
  } else console.log("google-veo: skipped (GOOGLE_GENAI_API_KEY not set)");

  process.exit(failures ? 1 : 0);
}

void main();
