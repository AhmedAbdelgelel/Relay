import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../../src/domain/types.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";

function provider() {
  return new OpenAICompatibleProvider({
    name: "gemini",
    baseURL: "https://example.invalid",
    apiKey: "k",
    defaultModel: "gemini-2.5-flash",
  });
}

function req() {
  return { model: "gemini-2.5-flash", messages: [{ role: "user" as const, content: "hi" }], temperature: 0.7, stream: false };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error payload inside 200 responses", () => {
  it("non-stream 200 with error body maps to 429", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }), { status: 200 }),
    );
    const err = await provider().chat(req(), new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("provider_rate_limited");
  });

  it("non-stream 200 with NOT_FOUND maps to 502 provider_not_found", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { code: 404, message: "model missing", status: "NOT_FOUND" } }), { status: 200 }),
    );
    const err = await provider().chat(req(), new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("provider_not_found");
  });

  it("stream data chunk carrying error throws instead of yielding nothing", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
    const err = await (async () => {
      try {
        for await (const _ of provider().chatStream({ ...req(), stream: true }, new AbortController().signal)) { /* drain */ }
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(429);
  });

  it("stream with normal deltas still yields text", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`));
        c.enqueue(enc.encode("data: not-json{{{\n\n"));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
    let acc = "";
    for await (const d of provider().chatStream({ ...req(), stream: true }, new AbortController().signal)) acc += d.delta;
    expect(acc).toBe("Hi");
  });

  it("requests include_usage and surfaces the terminal usage frame (D1)", async () => {
    const enc = new TextEncoder();
    const seenBodies: string[] = [];
    const usageStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      seenBodies.push(init?.body ?? "");
      return new Response(usageStream, { status: 200 });
    });
    const chunks: { delta: string; usage?: { prompt_tokens: number; completion_tokens: number } }[] = [];
    for await (const d of provider().chatStream({ ...req(), stream: true }, new AbortController().signal)) chunks.push(d);
    expect(JSON.parse(seenBodies[0]).stream_options).toEqual({ include_usage: true });
    expect(chunks).toEqual([
      { delta: "Hi" },
      { delta: "", usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]);
  });

  it("backend that rejects stream_options with 400 is retried once without it", async () => {
    const enc = new TextEncoder();
    const seenBodies: string[] = [];
    const okStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ?? "";
      seenBodies.push(body);
      if (body.includes("stream_options")) {
        return new Response(JSON.stringify({ error: { message: "Unknown field 'stream_options'" } }), { status: 400 });
      }
      return new Response(okStream, { status: 200 });
    });
    let acc = "";
    for await (const d of provider().chatStream({ ...req(), stream: true }, new AbortController().signal)) acc += d.delta;
    expect(seenBodies).toHaveLength(2);
    expect(seenBodies[1]).not.toContain("stream_options");
    expect(acc).toBe("ok");
  });

  it("unrelated 400 still fails instead of retrying forever", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "invalid model" } }), { status: 400 }));
    const err = await (async () => {
      try {
        for await (const _ of provider().chatStream({ ...req(), stream: true }, new AbortController().signal)) { /* drain */ }
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(502);
  });
});
