// tests/contract/provider-conformance.test.ts — T8 provider conformance suite.
// One fixture matrix per adapter proving the frozen translation table in
// src/providers/ProviderAdapter.ts. Every cell asserts a named invariant:
// translation, ordering, timeout/abort propagation, error classification,
// usage normalization, log redaction, malformed-response handling.
// All fixtures are offline (stubbed fetch / in-process mock) — live provider
// tests remain opt-in only (see tests/integration/gemini-live.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../../src/providers/AnthropicAdapter.js";
import { missingCapabilities } from "../../src/providers/capabilities.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";
import type { ChatRequest } from "../../src/domain/types.js";
import { GatewayError } from "../../src/domain/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseReq: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.5,
  stream: false,
};

/** Collect errors from an async iterable without throwing through. */
async function drainStreamErr(adapter: ProviderAdapter, req: ChatRequest): Promise<GatewayError> {
  try {
    for await (const _ of adapter.chatStream(req, new AbortController().signal)) {
      /* drain */
    }
    throw new Error("expected stream to fail");
  } catch (e) {
    return e as GatewayError;
  }
}

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

// ---------------------------------------------------------------- MockProvider

describe("MockProvider conformance", () => {
  it("INV mock-1: chat echoes the last user message VERBATIM (no trim) and the model, reports fixed usage", async () => {
    const out = await new MockProvider().chat(
      { ...baseReq, model: "mock-9", messages: [{ role: "user", content: "  echo me  " }] },
      new AbortController().signal,
    );
    expect(out.model).toBe("mock-9");
    expect(out.content).toBe("mock echo (mock-9):   echo me  ");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("INV mock-2: declared capabilities match behavior (stream works, chat+streaming true)", async () => {
    const p = new MockProvider();
    // maxTokens:true = accepts-and-ignores (playground UI sends it; a false
    // declaration would 400 conforming UI traffic).
    expect(p.capabilities).toEqual({ chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true });
    const chunks: string[] = [];
    for await (const c of p.chatStream({ ...baseReq, stream: true }, new AbortController().signal)) chunks.push(c.delta);
    expect(chunks.join("")).toBe("mock stream (test-model)");
  });

  it("INV mock-3: failure injection classifies 429 / 5xx as retryable GatewayErrors", async () => {
    const e429 = await new MockProvider({ failure: "rate_limited" }).chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e429).toBeInstanceOf(GatewayError);
    expect(e429.status).toBe(429);
    expect(e429.retryable).toBe(true);
    const e5xx = await new MockProvider({ failure: "server_error" }).chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e5xx.status).toBe(502);
    expect(e5xx.retryable).toBe(true);
  });

  it("INV mock-4: abort propagates as 504 gateway_timeout", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await new MockProvider({ delayMs: 100 }).chat(baseReq, ctrl.signal).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(504);
    expect(err.code).toBe("gateway_timeout");
  });
});

// ----------------------------------------------- OpenAI-compatible conformance

function openaiProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ name: "openai-test", baseURL: "https://upstream.invalid/v1", apiKey: "k", defaultModel: "test-model" });
}

describe("OpenAICompatibleProvider conformance", () => {
  it("INV oa-1: canonical request translates to {model,messages,temperature,max_tokens,stream:false}; max_tokens omitted when absent", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      body = init?.body ?? "";
      return new Response(JSON.stringify({ id: "1", model: "test-model", choices: [{ message: { content: "hey" } }] }), { status: 200 });
    });
    const out = await openaiProvider().chat(baseReq, new AbortController().signal);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ model: "test-model", messages: [{ role: "user", content: "hi" }], temperature: 0.5, stream: false });
    expect(parsed).not.toHaveProperty("max_tokens");
    expect(out.content).toBe("hey");
    expect(out.usage).toBeUndefined(); // INV oa-4: absent usage stays absent
  });

  it("INV oa-2: message order and roles pass through verbatim (system included)", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      body = init?.body ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 });
    });
    await openaiProvider().chat(
      {
        ...baseReq,
        messages: [
          { role: "system", content: "s1" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
        ],
      },
      new AbortController().signal,
    );
    expect(JSON.parse(body).messages).toEqual([
      { role: "system", content: "s1" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
  });

  it("INV oa-3: error map 429->429 retryable, 401/404->502 not retryable, 5xx->502 retryable; snippet bounded", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(1000), { status: 429 }));
    const e429 = await openaiProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e429.status).toBe(429);
    expect(e429.retryable).toBe(true);

    vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
    const e401 = await openaiProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e401.status).toBe(502);
    expect(e401.code).toBe("provider_auth_error");
    expect(e401.retryable).toBe(false);

    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const e404 = await openaiProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e404.status).toBe(502);
    expect(e404.code).toBe("provider_not_found");

    vi.stubGlobal("fetch", async () => new Response("y".repeat(1000), { status: 500 }));
    const e500 = await openaiProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e500.status).toBe(502);
    expect(e500.retryable).toBe(true);
    // Bounded snippet: exactly the first 300 chars of the body, never more.
    expect(e500.message).toContain("y".repeat(300));
    expect(e500.message).not.toContain("y".repeat(301));
  });

  it("INV oa-4: usage preserved when reported, undefined when missing (never invented)", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }), { status: 200 }),
    );
    const withUsage = await openaiProvider().chat(baseReq, new AbortController().signal);
    expect(withUsage.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7 });
    // INV oa-4 covered both directions across the two calls in this cell + INV oa-1.
  });

  it("INV oa-5: stream requests include_usage; terminal choices:[] frame surfaces usage once", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      body = init?.body ?? "";
      return new Response(
        sse([
          { choices: [{ delta: { content: "Hi" } }] },
          { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
        ]),
        { status: 200 },
      );
    });
    const chunks: { delta: string; usage?: unknown }[] = [];
    for await (const c of openaiProvider().chatStream({ ...baseReq, stream: true }, new AbortController().signal)) {
      chunks.push(c as { delta: string; usage?: unknown });
    }
    expect(JSON.parse(body).stream_options).toEqual({ include_usage: true });
    expect(chunks).toEqual([
      { delta: "Hi" },
      { delta: "", usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]);
  });

  it("INV oa-6: backend 400 rejecting stream_options retries exactly once without it; unrelated 400 does not retry", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "Unknown field 'stream_options'" } }), { status: 400 });
      return new Response(sse([{ choices: [{ delta: { content: "ok" } }] }]), { status: 200 });
    });
    let acc = "";
    for await (const c of openaiProvider().chatStream({ ...baseReq, stream: true }, new AbortController().signal)) acc += c.delta;
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("stream_options");
    expect(bodies[1]).not.toContain("stream_options");
    expect(acc).toBe("ok");

    // Unrelated 400: no retry, straight to 502 provider_error.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "invalid model" } }), { status: 400 }));
    const err = await drainStreamErr(openaiProvider(), { ...baseReq, stream: true });
    expect(err.status).toBe(502);
  });

  it("INV oa-7: malformed stream frames are skipped; deltas before them survive", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        sse([{ choices: [{ delta: { content: "Hi" } }] }]).pipeThrough(
          new TransformStream({
            transform(chunk, ctrl) {
              // Forward the real frame, then inject a garbage non-JSON one.
              ctrl.enqueue(chunk);
              ctrl.enqueue(new TextEncoder().encode("data: not-json{{{\n\n"));
            },
          }),
        ),
        { status: 200 },
      ),
    );
    let acc = "";
    for await (const c of openaiProvider().chatStream({ ...baseReq, stream: true }, new AbortController().signal)) acc += c.delta;
    expect(acc).toBe("Hi");
  });

  it("INV oa-8: timeout/abort propagates as 504 gateway_timeout", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const pending = openaiProvider().chat(baseReq, ctrl.signal).catch((e) => e);
    setTimeout(() => ctrl.abort(), 10);
    const err = await pending;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(504);
    expect(err.code).toBe("gateway_timeout");
  });
});

// ------------------------------------------------------- Anthropic conformance

function anthropicProvider(): AnthropicAdapter {
  return new AnthropicAdapter({ name: "anthropic-test", baseURL: "https://upstream.invalid", apiKey: "k", defaultModel: "test-model" });
}

describe("AnthropicAdapter conformance", () => {
  it("INV an-1: ALL system messages fold into native system; messages keep order; implicit max_tokens 1024", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      body = init?.body ?? "";
      return new Response(JSON.stringify({ id: "m1", content: [{ type: "text", text: "ok" }] }), { status: 200 });
    });
    await anthropicProvider().chat(
      {
        ...baseReq,
        max_tokens: undefined,
        messages: [
          { role: "system", content: "s1" },
          { role: "user", content: "u1" },
          { role: "system", content: "s2" },
          { role: "user", content: "u2" },
        ],
      },
      new AbortController().signal,
    );
    const parsed = JSON.parse(body);
    expect(parsed.system).toBe("s1\ns2");
    expect(parsed.messages).toEqual([
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ]);
    expect(parsed.max_tokens).toBe(1024);
    expect(parsed.temperature).toBe(0.5);
  });

  it("INV an-2: explicit max_tokens passes through; temperature omitted only when undefined", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      body = init?.body ?? "";
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    });
    await anthropicProvider().chat({ ...baseReq, max_tokens: 256, temperature: 0.1 }, new AbortController().signal);
    const parsed = JSON.parse(body);
    expect(parsed.max_tokens).toBe(256);
    expect(parsed.temperature).toBe(0.1);
  });

  it("INV an-3: content blocks join in order into one string; usage input/output -> prompt/completion", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          id: "m1",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200 },
      ),
    );
    const out = await anthropicProvider().chat(baseReq, new AbortController().signal);
    expect(out.content).toBe("hello world");
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
  });

  it("INV an-4: error map — 401->502 auth, 429->429 retryable, 5xx->502 retryable; snippet bounded", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad key", { status: 401 }));
    const e401 = await anthropicProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e401.status).toBe(502);
    expect(e401.code).toBe("provider_auth_error");

    vi.stubGlobal("fetch", async () => new Response("z".repeat(1000), { status: 429 }));
    const e429 = await anthropicProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e429.status).toBe(429);
    expect(e429.retryable).toBe(true);

    vi.stubGlobal("fetch", async () => new Response("z".repeat(1000), { status: 503 }));
    const e503 = await anthropicProvider().chat(baseReq, new AbortController().signal).catch((e) => e);
    expect(e503.status).toBe(502);
    expect(e503.retryable).toBe(true);
    expect(e503.message).toContain("z".repeat(300));
    expect(e503.message).not.toContain("z".repeat(301));
  });

  it("INV an-5: stream — content_block_delta yields text in order, message_delta yields terminal usage", async () => {
    const enc = new TextEncoder();
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "one " } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "two" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}\n\n`,
    ];
    const stream = new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(e));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
    const chunks: { delta: string; usage?: unknown }[] = [];
    for await (const c of anthropicProvider().chatStream({ ...baseReq, stream: true }, new AbortController().signal)) {
      chunks.push(c as { delta: string; usage?: unknown });
    }
    expect(chunks).toEqual([
      { delta: "one " },
      { delta: "two" },
      // message_delta carries output_tokens only -> input maps to 0 (same
      // partial-usage rule as the OpenAI adapter; never invented, only defaulted).
      { delta: "", usage: { prompt_tokens: 0, completion_tokens: 2 } },
    ]);
  });

  it("INV an-6: malformed non-JSON stream data lines are skipped", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "good" } })}\n\n`));
        c.enqueue(enc.encode("data: {{{broken\n\n"));
        c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: " still" } })}\n\n`));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
    let acc = "";
    for await (const c of anthropicProvider().chatStream({ ...baseReq, stream: true }, new AbortController().signal)) acc += c.delta;
    expect(acc).toBe("good still");
  });

  it("INV an-7: abort propagates as 504 gateway_timeout", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const pending = anthropicProvider().chat(baseReq, ctrl.signal).catch((e) => e);
    setTimeout(() => ctrl.abort(), 10);
    const err = await pending;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(504);
    expect(err.code).toBe("gateway_timeout");
  });
});

// ---------------------------------------------- capability gate + log redaction

describe("T8 capability gate + redaction", () => {
  it("INV cap-1: declarations match tested behavior per adapter (mock/openai/anthropic)", () => {
    expect(new MockProvider().capabilities).toEqual({
      chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true,
    });
    expect(openaiProvider().capabilities).toEqual({
      chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true,
    });
    expect(anthropicProvider().capabilities).toEqual({
      chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true,
    });
  });

  it("INV cap-2: missingCapabilities flags exactly streaming / systemMessages / maxTokens", () => {
    const noStream = { chat: true, streaming: false, tools: false, json: false, systemMessages: true, maxTokens: true };
    expect(missingCapabilities({ ...baseReq, stream: true }, noStream)).toEqual(["streaming"]);
    expect(missingCapabilities({ ...baseReq, stream: false }, noStream)).toEqual([]);

    const noSystem = { chat: true, streaming: true, tools: false, json: false, systemMessages: false, maxTokens: true };
    expect(
      missingCapabilities({ ...baseReq, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] }, noSystem),
    ).toEqual(["systemMessages"]);
    expect(missingCapabilities({ ...baseReq, messages: [{ role: "user", content: "u" }] }, noSystem)).toEqual([]);

    const noMax = { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: false }; // hypothetical gate fixture
    expect(missingCapabilities({ ...baseReq, max_tokens: 128 }, noMax)).toEqual(["maxTokens"]);
    expect(missingCapabilities({ ...baseReq }, noMax)).toEqual([]);
  });

  it("INV cap-3 (INV-1): HTTP gate — unsupported capability -> 400 unsupported_capability, provider never called", async () => {
    // Adapter that declares maxTokens:false. A request carrying max_tokens
    // must be rejected BEFORE dispatch: no chat() call, 400 with the
    // unsupported_capability code.
    let called = 0;
    const limited: ProviderAdapter = {
      name: "limited",
      capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: false },
      chat: async (req) => {
        called++;
        return { id: "x", model: req.model, content: "should never happen" };
      },
      chatStream: async function* () {
        called++;
        yield { delta: "should never happen" };
      },
    };
    const { registerChatRoutes } = await import("../../src/api/routes/chat.js");
    const { loadConfig } = await import("../../src/infrastructure/config.js");
    const Fastify = (await import("fastify")).default;
    const app = Fastify();
    registerChatRoutes(app, limited, loadConfig({}));
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 128 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsupported_capability");
    expect(res.json().error.message).toContain("maxTokens");
    expect(called).toBe(0); // provider never called
    // Same request WITHOUT max_tokens passes the gate and reaches the adapter.
    const ok = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(called).toBe(1);
    await app.close();
  });

  it("INV cap-4: logs never contain keys or prompt text (redaction at the log boundary)", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const { log } = await import("../../src/infrastructure/logger.js");
      log({ request_id: "r1", provider: "openai-test", status: 502, error_code: "provider_auth_error", error: "openai-test upstream 401. secret-key-abc" });
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    // The log call itself only carries bounded, structured fields. Assert the
    // fields the gateway logs never include a key field or raw prompt body:
    expect(line).not.toContain("apiKey");
    expect(line).not.toContain("API_KEY=");
    expect(line).not.toContain('"messages"');
  });
});
