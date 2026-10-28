// Contract tests against recorded response shapes of the Messages API (no network, no key).
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "@/server/providers/adapters/anthropic";
import { ProviderError } from "@/server/providers/types";

type Call = { url: string; body: Record<string, unknown>; headers: Headers };

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {}, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test", ...headers } });
  }) as typeof fetch;
  return { fn, calls };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});

const request = (model = "claude-opus-5-5") => ({ capability: "TEXT" as const, model, prompt: "Say hello", system: "Be brief", params: {} });
const adapter = (f: typeof fetch) => new AnthropicAdapter({ apiKey: "sk-test", timeoutMs: 10_000, effort: "medium", fetch: f });
const signal = () => new AbortController().signal;

describe("Anthropic adapter", () => {
  it("sends the expected request with refusal fallback and maps text and usage", async () => {
    const { fn, calls } = fakeFetch(200, message());
    const out = await adapter(fn).generate(request(), signal());
    expect(out.outputs[0]!.text).toBe("Hello world");
    expect(out.attempts).toEqual([{ model: "claude-opus-5-5", usage: { input_mtok: 120, output_mtok: 40, cache_write_mtok: 0, cache_read_mtok: 0 } }]);
    const call = calls[0]!;
    expect(call.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/); // pinned, ignores ANTHROPIC_BASE_URL
    expect(call.body).toMatchObject({ model: "claude-opus-5-5", system: "Be brief", fallbacks: "default", output_config: { effort: "medium" } });
    expect(call.body).not.toHaveProperty("thinking"); // always-on thinking: never send a disabled config
    expect(call.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call.headers.get("authorization") ?? call.headers.get("x-api-key")).toMatch(/sk-test$/);
  });

  it("does not request fallbacks for Haiku and prices long prompts on the long-context tier", async () => {
    const { fn, calls } = fakeFetch(200, message({ model: "claude-haiku-5-5", usage: { input_tokens: 150_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    const out = await adapter(fn).generate(request("claude-haiku-5-5"), signal());
    expect(calls[0]!.body).not.toHaveProperty("fallbacks");
    expect(out.attempts[0]!.usage).toEqual({ long_input_mtok: 150_000, long_output_mtok: 10 });
  });

  it("bills every attempt when a refusal fallback served the request", async () => {
    const { fn } = fakeFetch(
      200,
      message({
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          iterations: [
            { type: "message", input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
            { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
          ],
        },
      }),
    );
    const out = await adapter(fn).generate(request(), signal());
    expect(out.attempts.map((a) => a.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(out.servedBy).toBe("claude-sonnet-5-5");
    expect(out.notes).toContain("Served by fallback model claude-sonnet-5-5");
  });

  it("turns a refusal into a non-retryable content_policy error that still carries billed attempts", async () => {
    const { fn } = fakeFetch(200, message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }));
    const err = await adapter(fn).generate(request(), signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "content_policy", retryable: false });
    expect((err as { attempts: unknown[] }).attempts).toHaveLength(1);
  });

  it.each([
    [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, {}, "auth", false],
    [403, { type: "error", error: { type: "permission_error", message: "no" } }, {}, "auth", false],
    [404, { type: "error", error: { type: "not_found_error", message: "model" } }, {}, "invalid_input", false],
    [400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, {}, "invalid_input", false],
    [402, { type: "error", error: { type: "billing_error", message: "credit" } }, {}, "quota_exceeded", false],
    [429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "7" }, "rate_limited", true],
    [529, { type: "error", error: { type: "overloaded_error", message: "busy" } }, {}, "transient", true],
  ])("maps HTTP %i", async (status, body, headers, kind, retryable) => {
    const { fn } = fakeFetch(status, body, headers);
    const err = await adapter(fn).generate(request(), signal()).catch((e) => e);
    expect(err).toMatchObject({ kind, retryable });
    if (status === 429) expect((err as ProviderError).options.retryAfterMs).toBe(7000);
  });

  it("validates and estimates conservatively before spending", () => {
    const a = adapter(fakeFetch(200, {}).fn);
    expect(() => a.validate({ ...request(), prompt: " " })).toThrow(/Empty prompt/);
    expect(() => a.validate({ ...request(), capability: "IMAGE" })).toThrow(/text/);
    const e = a.estimate({ ...request(), maxOutputTokens: 1000 });
    expect(e.maxUsage.output_mtok).toBe(1000);
    expect(e.maxUsage.input_mtok).toBeGreaterThanOrEqual(Math.ceil("Say helloBe brief".length / 3));
  });
});
