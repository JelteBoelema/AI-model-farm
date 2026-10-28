// Mock adapters for mock mode and tests. Output is deterministic and visibly labelled; cost is a
// known zero (pricing.free), never a missing price.

import { createHash } from "node:crypto";
import { drawText, RgbImage, textWidth } from "../png";
import { mockFromSchema, mockGenerateText } from "../mock-text";
import { ProviderError, type CostEstimate, type GenerationRequest, type GenerationResult, type ModelCapability, type ProviderAdapter } from "../types";

export class MockTextAdapter implements ProviderAdapter {
  readonly key = "mock-text";
  readonly isMock = true;

  async discoverCapabilities(): Promise<ModelCapability[]> {
    return [{ capability: "TEXT", model: "mock", commercialUseAllowed: false }];
  }

  validate(req: GenerationRequest) {
    if (req.capability !== "TEXT") throw new ProviderError("invalid_input", "Mock text adapter only handles text");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty prompt");
  }

  estimate(req: GenerationRequest): CostEstimate {
    return { maxUsage: { input_mtok: Math.ceil(req.prompt.length / 3), output_mtok: 200 }, uncertaintyNote: "Mock provider: no cost" };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    this.validate(req);
    const kind = String(req.params.kind ?? "text");
    const text = req.jsonSchema
      ? JSON.stringify(mockFromSchema(req.jsonSchema, `${kind}\n${req.prompt}`))
      : mockGenerateText(req.system ? `${req.prompt}\n\nRules:\n${req.system}` : req.prompt, kind);
    return {
      outputs: [{ kind: "text", text }],
      attempts: [{ model: "mock", usage: { input_mtok: Math.ceil(req.prompt.length / 4), output_mtok: Math.ceil(text.length / 4) } }],
      servedBy: "mock",
      notes: ["Mock output"],
    };
  }
}

const PALETTE: [number, number, number][] = [
  [109, 93, 252],
  [34, 170, 136],
  [232, 121, 61],
  [52, 132, 201],
  [196, 72, 128],
];

export class MockImageAdapter implements ProviderAdapter {
  readonly key = "mock-image";
  readonly isMock = true;

  async discoverCapabilities(): Promise<ModelCapability[]> {
    return [{ capability: "IMAGE", model: "mock", supportsReferenceImages: true, maxReferenceImages: 8, commercialUseAllowed: false }];
  }

  validate(req: GenerationRequest) {
    if (req.capability !== "IMAGE") throw new ProviderError("invalid_input", "Mock image adapter only handles images");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty prompt");
  }

  estimate(): CostEstimate {
    return { maxUsage: { per_image: 1 }, uncertaintyNote: "Mock provider: no cost" };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    this.validate(req);
    const digest = createHash("sha256").update(`${req.prompt}\n${String(req.params.seed ?? "")}`).digest();
    const [w, h] = String(req.params.size ?? "1024x1536").split("x").map(Number) as [number, number];
    // Shortest side 512 px: large enough for the technical checks, small enough to stay fast.
    const scale = 512 / Math.min(w || 1024, h || 1536);
    const img = new RgbImage(Math.round((w || 1024) * scale), Math.round((h || 1536) * scale));
    const a = PALETTE[digest[0]! % PALETTE.length]!;
    const b = PALETTE[digest[1]! % PALETTE.length]!;
    for (let y = 0; y < img.height; y++) {
      const t = y / img.height;
      const color: [number, number, number] = [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as [number, number, number];
      img.fillRect(0, y, img.width, 1, color);
    }
    // Diagonal stripes make the watermark impossible to crop out of a usable area.
    for (let x = -img.height; x < img.width; x += 48) for (let y = 0; y < img.height; y++) img.fillRect(x + y, y, 6, 1, [255, 255, 255]);
    const label = "MOCK";
    const s = Math.floor(img.width / 30);
    img.fillRect(0, Math.floor(img.height / 2) - 6 * s, img.width, 12 * s, [20, 20, 28]);
    drawText(img, label, Math.floor((img.width - textWidth(label, s)) / 2), Math.floor(img.height / 2) - Math.floor(3.5 * s), s, [255, 255, 255]);
    const id = digest.toString("hex").slice(0, 8);
    drawText(img, id, 10, img.height - 30, 3, [255, 255, 255]);
    return {
      outputs: [{ kind: "image", bytes: img.toPng(), mimeType: "image/png" }],
      attempts: [{ model: "mock", usage: { per_image: 1 } }],
      servedBy: "mock",
      notes: [`Mock image${req.referenceImages?.length ? ` (${req.referenceImages.length} reference image(s) received, not used)` : ""}`],
    };
  }
}

/** Speaking rate used by the mock voice and for planning: ~14 characters per second. */
export const MOCK_SPEECH_MS_PER_CHAR = 70;

/** Mono 16-bit PCM WAV of syllable-like beeps: obviously synthetic, with the length of the text. */
export function mockSpeechWav(text: string, sampleRate = 24_000): { bytes: Buffer; durationMs: number } {
  const durationMs = Math.max(800, Math.min(60_000, text.trim().length * MOCK_SPEECH_MS_PER_CHAR));
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const data = Buffer.alloc(samples * 2);
  const period = Math.round(0.26 * sampleRate);
  const on = Math.round(0.18 * sampleRate);
  for (let i = 0; i < samples; i++) {
    const p = i % period;
    const env = p < on ? Math.min(1, p / 200, (on - p) / 200) : 0;
    const v = env * 0.3 * (Math.sin((2 * Math.PI * 220 * i) / sampleRate) + 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return { bytes: Buffer.concat([header, data]), durationMs };
}

/** Mock video (watermarked FFmpeg clips) and mock speech (beeps). Lip-sync is not offered. */
export class MockVideoAdapter implements ProviderAdapter {
  readonly key = "mock-video";
  readonly isMock = true;

  async discoverCapabilities(): Promise<ModelCapability[]> {
    return [
      { capability: "VIDEO", model: "mock", supportsReferenceImages: true, maxReferenceImages: 3, commercialUseAllowed: false },
      { capability: "SPEECH", model: "mock", commercialUseAllowed: false },
    ];
  }

  validate(req: GenerationRequest) {
    if (req.capability !== "VIDEO" && req.capability !== "SPEECH") throw new ProviderError("invalid_input", "Mock video adapter handles video and speech only");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty prompt");
    if (req.capability === "VIDEO") {
      const s = Number(req.params.durationSeconds);
      if (!Number.isFinite(s) || s < 1 || s > 20) throw new ProviderError("invalid_input", "durationSeconds must be 1–20");
    }
  }

  estimate(req: GenerationRequest): CostEstimate {
    return req.capability === "VIDEO"
      ? { maxUsage: { video_second: Number(req.params.durationSeconds) || 8 }, uncertaintyNote: "Mock provider: no cost" }
      : { maxUsage: { speech_kchar: req.prompt.length }, uncertaintyNote: "Mock provider: no cost" };
  }

  async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    this.validate(req);
    if (req.capability === "SPEECH") {
      const { bytes, durationMs } = mockSpeechWav(req.prompt);
      return { outputs: [{ kind: "audio", bytes, mimeType: "audio/wav", durationMs }], attempts: [{ model: "mock", usage: { speech_kchar: req.prompt.length } }], servedBy: "mock", notes: ["Mock voice (beeps)"] };
    }
    const { renderMockClip } = await import("../../media/ffmpeg");
    const digest = createHash("sha256").update(`${req.prompt}\n${String(req.params.seed ?? "")}`).digest();
    const seconds = Number(req.params.durationSeconds);
    const portrait = req.params.aspectRatio !== "16:9";
    const bytes = await renderMockClip(
      { width: portrait ? 540 : 960, height: portrait ? 960 : 540, durationMs: seconds * 1000, label: String(req.params.label ?? "VIDEO"), colors: [PALETTE[digest[0]! % PALETTE.length]!, PALETTE[digest[1]! % PALETTE.length]!] },
      signal,
    );
    return {
      outputs: [{ kind: "video", bytes, mimeType: "video/mp4", durationMs: seconds * 1000 }],
      attempts: [{ model: "mock", usage: { video_second: seconds } }],
      servedBy: "mock",
      notes: [`Mock clip${req.referenceImages?.length ? ` (${req.referenceImages.length} reference image(s) received, not used)` : ""}`],
    };
  }
}
