import { describe, expect, it } from "vitest";
import { sniffImage } from "@/lib/image-meta";
import { MockImageAdapter, MockTextAdapter } from "@/server/providers/adapters/mock";

const req = { capability: "IMAGE" as const, model: "mock", prompt: "A beach at sunset", params: { size: "1024x1536" } };

describe("mock adapters", () => {
  it("renders a valid, deterministic, watermarked PNG in the requested aspect ratio", async () => {
    const a = await new MockImageAdapter().generate(req);
    const b = await new MockImageAdapter().generate(req);
    const bytes = a.outputs[0]!.bytes!;
    expect(sniffImage(bytes)).toMatchObject({ mimeType: "image/png", width: 512, height: 768 });
    expect(bytes.equals(b.outputs[0]!.bytes!)).toBe(true);
    const other = await new MockImageAdapter().generate({ ...req, prompt: "Something else" });
    expect(bytes.equals(other.outputs[0]!.bytes!)).toBe(false);
  });

  it("labels mock text", async () => {
    const out = await new MockTextAdapter().generate({ capability: "TEXT", model: "mock", prompt: "Write a caption", params: { kind: "CAPTION" } });
    expect(out.outputs[0]!.text).toMatch(/^\[Mock caption output/);
  });

  it("produces labelled, deterministic JSON that matches the requested schema", async () => {
    const jsonSchema = {
      type: "object",
      properties: {
        caption: { type: "string", maxLength: 40 },
        hashtags: { type: "array", items: { type: "string" }, minItems: 3 },
        score: { type: "integer", minimum: 0, maximum: 100 },
        pass: { type: "boolean" },
        tone: { type: "string", enum: ["calm", "loud"] },
      },
    };
    const req = { capability: "TEXT" as const, model: "mock", prompt: "Caption please", params: { kind: "CAPTION" }, jsonSchema };
    const out = JSON.parse((await new MockTextAdapter().generate(req)).outputs[0]!.text!);
    expect(out.caption).toMatch(/^\[Mock caption [0-9a-f]{6}\]$/);
    expect(out.hashtags).toHaveLength(3);
    expect(out).toMatchObject({ score: 100, pass: true, tone: "calm" });
    expect((await new MockTextAdapter().generate(req)).outputs[0]!.text).toBe(JSON.stringify(out));
  });
});
