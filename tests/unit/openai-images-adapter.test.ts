// Contract tests against the documented Images API response format (no network, no key).
import { describe, expect, it } from "vitest";
import { OpenAiImagesAdapter } from "@/server/providers/adapters/openai-images";
import { ProviderError } from "@/server/providers/types";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { fn, calls };
}

const adapter = (f: typeof fetch) => new OpenAiImagesAdapter({ apiKey: "sk-test", timeoutMs: 10_000, fetch: f });
const req = { capability: "IMAGE" as const, model: "gpt-image-2", prompt: "A red bicycle", params: { size: "1024x1536", quality: "medium" } };
const ok = { created: 1, data: [{ b64_json: PNG_1x1 }], usage: { input_tokens: 50, output_tokens: 4000, input_tokens_details: { text_tokens: 40, image_tokens: 10 } } };

describe("OpenAI Images adapter", () => {
  it("generates from text with a JSON request and maps token usage", async () => {
    const { fn, calls } = fakeFetch(200, ok);
    const out = await adapter(fn).generate(req, new AbortController().signal);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ model: "gpt-image-2", prompt: "A red bicycle", size: "1024x1536", quality: "medium", n: 1 });
    expect(new Headers(calls[0]!.init!.headers).get("authorization")).toBe("Bearer sk-test");
    expect(out.outputs[0]!.bytes!.subarray(1, 4).toString()).toBe("PNG");
    expect(out.attempts[0]!.usage).toEqual({ text_input_mtok: 40, image_input_mtok: 10, image_output_mtok: 4000 });
  });

  it("uses the edits endpoint with image[] parts when references are given", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ b64_json: PNG_1x1 }] });
    const ref = { bytes: Buffer.from(PNG_1x1, "base64"), mimeType: "image/png" };
    const out = await adapter(fn).generate({ ...req, referenceImages: [ref, ref] }, new AbortController().signal);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/edits");
    const form = calls[0]!.init!.body as FormData;
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.get("model")).toBe("gpt-image-2");
    expect(out.attempts[0]!.usage).toEqual({ per_image: 1 }); // no usage reported → priced per image
  });

  it.each([
    [401, { error: { message: "bad key", code: "invalid_api_key" } }, {}, "auth"],
    [429, { error: { message: "quota", code: "insufficient_quota" } }, {}, "quota_exceeded"],
    [429, { error: { message: "slow", code: "rate_limit_exceeded" } }, { "retry-after": "3" }, "rate_limited"],
    [400, { error: { message: "Your request was rejected by the safety system", code: "moderation_blocked" } }, {}, "content_policy"],
    [400, { error: { message: "Invalid size", code: "invalid_value" } }, {}, "invalid_input"],
    [503, { error: { message: "down" } }, {}, "transient"],
  ])("maps HTTP %i", async (status, body, headers, kind) => {
    const err = await adapter(fakeFetch(status, body, headers).fn).generate(req, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
  });

  it("rejects unsupported parameters before any request", () => {
    expect(() => adapter(fakeFetch(200, ok).fn).validate({ ...req, params: { size: "800x600" } })).toThrow(/size/);
    expect(() => adapter(fakeFetch(200, ok).fn).validate({ ...req, params: { quality: "ultra" } })).toThrow(/quality/);
  });
});
