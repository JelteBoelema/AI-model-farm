import { describe, expect, it } from "vitest";
import { sniffImage } from "@/lib/image-meta";
import { MockImageAdapter, MockTextAdapter } from "@/server/providers/adapters/mock";

const req = { capability: "IMAGE" as const, model: "mock", prompt: "A beach at sunset", params: { size: "1024x1536" } };

describe("mock adapters", () => {
  it("renders a valid, deterministic, watermarked PNG in the requested aspect ratio", async () => {
    const a = await new MockImageAdapter().generate(req);
    const b = await new MockImageAdapter().generate(req);
    const bytes = a.outputs[0]!.bytes!;
    expect(sniffImage(bytes)).toMatchObject({ mimeType: "image/png", width: 341, height: 512 });
    expect(bytes.equals(b.outputs[0]!.bytes!)).toBe(true);
    const other = await new MockImageAdapter().generate({ ...req, prompt: "Something else" });
    expect(bytes.equals(other.outputs[0]!.bytes!)).toBe(false);
  });

  it("labels mock text and refuses structured output", async () => {
    const out = await new MockTextAdapter().generate({ capability: "TEXT", model: "mock", prompt: "Write a caption", params: { kind: "CAPTION" } });
    expect(out.outputs[0]!.text).toMatch(/^\[Mock caption output/);
    expect(() => new MockTextAdapter().validate({ capability: "TEXT", model: "mock", prompt: "x", params: {}, jsonSchema: {} })).toThrow(/structured/);
  });
});
