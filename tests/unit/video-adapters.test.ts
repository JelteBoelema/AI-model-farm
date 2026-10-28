// Contract tests for the long-running video adapter and the speech adapter (fake fetch, no network).
import { describe, expect, it } from "vitest";
import { ElevenLabsAdapter } from "@/server/providers/adapters/elevenlabs";
import { VeoAdapter } from "@/server/providers/adapters/google-veo";

type Call = { url: string; method: string; body: unknown; headers: Headers };

function fakeFetch(responses: ((url: string) => Response)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null, headers: new Headers(init?.headers) });
    return responses[Math.min(i++, responses.length - 1)]!(url);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = () => new AbortController().signal;
const videoReq = { capability: "VIDEO" as const, model: "veo-3.1-generate-preview", prompt: "A walk in the park", params: { durationSeconds: 8, aspectRatio: "9:16" } };

describe("Veo adapter", () => {
  it("submits a long-running job with the key header and reference images", async () => {
    const { fn, calls } = fakeFetch([json(200, { name: "models/veo-3.1-generate-preview/operations/abc123" })]);
    const veo = new VeoAdapter({ apiKey: "g-key", timeoutMs: 10_000, fetch: fn });
    const res = await veo.submit({ ...videoReq, referenceImages: [{ bytes: Buffer.from([1, 2]), mimeType: "image/png" }] }, signal());
    expect(res.providerJobId).toBe("models/veo-3.1-generate-preview/operations/abc123");
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe("g-key");
    expect(calls[0]!.body).toMatchObject({
      instances: [{ prompt: "A walk in the park", referenceImages: [{ image: { bytesBase64Encoded: "AQI=", mimeType: "image/png" }, referenceType: "asset" }] }],
      parameters: { aspectRatio: "9:16", durationSeconds: 8 },
    });
  });

  it("polls until done, then downloads the clip and reports billed seconds", async () => {
    const op = "models/veo/operations/abc123";
    const { fn, calls } = fakeFetch([
      json(200, { name: op, done: false }),
      json(200, { name: op, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media" } }] } } }),
      () => new Response(Buffer.from("MP4DATA"), { status: 200 }),
    ]);
    const veo = new VeoAdapter({ apiKey: "g-key", timeoutMs: 10_000, fetch: fn });
    expect(await veo.poll(op, videoReq, signal())).toEqual({ done: false });
    const done = await veo.poll(op, videoReq, signal());
    expect(done.done && done.result.outputs[0]!.bytes!.toString()).toBe("MP4DATA");
    expect(done.done && done.result.attempts).toEqual([{ model: "veo-3.1-generate-preview", usage: { video_second: 8 } }]);
    expect(calls[1]!.url).toBe(`https://generativelanguage.googleapis.com/v1beta/${op}`);
    expect(calls[2]!.headers.get("x-goog-api-key")).toBe("g-key");
  });

  it("maps filtered output to content_policy and refuses foreign download hosts", async () => {
    const op = "models/veo/operations/abc";
    const filtered = new VeoAdapter({ apiKey: "k", timeoutMs: 10_000, fetch: fakeFetch([json(200, { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["person"] } } })]).fn });
    await expect(filtered.poll(op, videoReq, signal())).rejects.toMatchObject({ kind: "content_policy" });
    const evil = new VeoAdapter({ apiKey: "k", timeoutMs: 10_000, fetch: fakeFetch([json(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://evil.example.com/v.mp4" } }] } } })]).fn });
    await expect(evil.poll(op, videoReq, signal())).rejects.toThrow(/Unexpected video host/);
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [400, "invalid_input"],
    [503, "transient"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const veo = new VeoAdapter({ apiKey: "k", timeoutMs: 10_000, fetch: fakeFetch([json(status, { error: { message: "x", status: "S" } })]).fn });
    await expect(veo.submit(videoReq, signal())).rejects.toMatchObject({ kind });
  });

  it("validates clip length before spending", () => {
    const veo = new VeoAdapter({ apiKey: "k", timeoutMs: 10_000 });
    expect(() => veo.validate({ ...videoReq, params: { durationSeconds: 5 } })).toThrow(/4, 6, 8/);
    expect(veo.estimate(videoReq).maxUsage).toEqual({ video_second: 8 });
  });
});

describe("ElevenLabs adapter", () => {
  const req = { capability: "SPEECH" as const, model: "eleven_multilingual_v2", prompt: "Hello there", params: { voiceId: "Voice12345" } };

  it("sends text to the voice endpoint and bills characters", async () => {
    const { fn, calls } = fakeFetch([() => new Response(Buffer.from("ID3audio"), { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "r1" } })]);
    const out = await new ElevenLabsAdapter({ apiKey: "e-key", timeoutMs: 10_000, fetch: fn }).generate(req, signal());
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/Voice12345?output_format=mp3_44100_128");
    expect(calls[0]!.headers.get("xi-api-key")).toBe("e-key");
    expect(calls[0]!.body).toEqual({ text: "Hello there", model_id: "eleven_multilingual_v2" });
    expect(out).toMatchObject({ attempts: [{ usage: { speech_kchar: 11 } }], providerRequestId: "r1" });
    expect(out.outputs[0]).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
  });

  it("requires a configured voice and maps quota errors", async () => {
    const a = new ElevenLabsAdapter({ apiKey: "k", timeoutMs: 10_000, fetch: fakeFetch([json(401, { detail: { message: "quota exceeded" } })]).fn });
    expect(() => a.validate({ ...req, params: {} })).toThrow(/voice/);
    await expect(a.generate(req, signal())).rejects.toMatchObject({ kind: "auth" });
    const q = new ElevenLabsAdapter({ apiKey: "k", timeoutMs: 10_000, fetch: fakeFetch([json(400, { detail: { message: "You have exceeded your quota" } })]).fn });
    await expect(q.generate(req, signal())).rejects.toMatchObject({ kind: "quota_exceeded" });
  });
});
