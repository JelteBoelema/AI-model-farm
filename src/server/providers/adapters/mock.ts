// Mock adapters for mock mode and tests. Output is deterministic and visibly labelled; cost is a
// known zero (pricing.free), never a missing price.

import { createHash } from "node:crypto";
import { drawText, RgbImage, textWidth } from "../png";
import { mockGenerateText } from "../mock-text";
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
    if (req.jsonSchema) throw new ProviderError("invalid_input", "The mock text provider cannot produce structured output");
  }

  estimate(req: GenerationRequest): CostEstimate {
    return { maxUsage: { input_mtok: Math.ceil(req.prompt.length / 3), output_mtok: 200 }, uncertaintyNote: "Mock provider: no cost" };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    this.validate(req);
    const kind = String(req.params.kind ?? "text");
    const text = mockGenerateText(req.system ? `${req.prompt}\n\nRules:\n${req.system}` : req.prompt, kind);
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
    const digest = createHash("sha256").update(req.prompt).digest();
    const [w, h] = String(req.params.size ?? "1024x1536").split("x").map(Number) as [number, number];
    const scale = 512 / Math.max(w || 1024, h || 1024);
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
