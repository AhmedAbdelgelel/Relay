
import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import { metrics } from "../../src/observability/metrics.js";
import { AnthropicAdapter } from "../../src/providers/AnthropicAdapter.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, json, joinedDeltas, makeApp, parseSSE, sendJson, startFakeUpstream } from "./harness.js";

const lanes = await laneAuth("openai", "anthropic");
const ask = (model: string, content: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: "user", content }],
  ...extra,
});

beforeEach(() => metrics.reset());

function openAiApp(upstreamUrl: string, apiKey = "env-key", env: Record<string, string> = {}) {
  return makeApp({
    auth: lanes.auth,
    provider: new OpenAICompatibleProvider({ name: "openai", baseURL: upstreamUrl, apiKey, defaultModel: "gpt-default" }),
    env: { OPENAI_BASE_URL: upstreamUrl, OPENAI_API_KEY: apiKey, ...env },
  });
}

function anthropicApp(upstreamUrl: string) {
  return makeApp({
    auth: lanes.auth,
    provider: new AnthropicAdapter({ name: "anthropic", baseURL: upstreamUrl, apiKey: "env-key", defaultModel: "claude-default" }),
    env: { ANTHROPIC_BASE_URL: upstreamUrl, ANTHROPIC_API_KEY: "env-key" },
  });
}

describe("OpenAI-compatible adapter over the wire", () => {
  it("sends the translated request and maps a full response", async () => {
    const upstream = await startFakeUpstream((hit, res) => {
      sendJson(res, 200, {
        id: "oai-1",
        model: hit.body["model"],
        choices: [{ message: { content: "Hello from OpenAI" } }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      });
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "wire probe", { temperature: 0.3, max_tokens: 7 }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("openai");

    expect(upstream.hits.length).toBe(1);
    const hit = upstream.hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/chat/completions");
    expect(hit.headers["authorization"]).toBe("Bearer env-key");
    expect(hit.body).toMatchObject({
      model: "gpt-4o",
      messages: [{ role: "user", content: "wire probe" }],
      temperature: 0.3,
      max_tokens: 7,
      stream: false,
    });

    const body = json<{ id: string; model: string; choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } }>(res);
    expect(body.id).toBe("oai-1");
    expect(body.model).toBe("gpt-4o");
    expect(body.choices[0]!.message.content).toBe("Hello from OpenAI");
    expect(body.usage).toEqual({ prompt_tokens: 9, completion_tokens: 4 });
    await upstream.close();
    await app.close();
  });

  it("absent max_tokens is omitted; absent usage stays absent (never invented)", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "oai-2", model: "gpt-4o", choices: [{ message: { content: "no usage" } }] });
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "usage probe"));
    expect(res.statusCode).toBe(200);
    expect("max_tokens" in upstream.hits[0]!.body).toBe(false);
    expect(json<{ usage?: unknown }>(res).usage).toBeUndefined();
    await upstream.close();
    await app.close();
  });

  it("a 200 body carrying an error object maps by its code (429)", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { error: { code: 429, message: "quota exhausted" } });
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "quota probe"));
    expect(res.statusCode).toBe(429);
    const body = json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("provider_rate_limited");
    expect(body.error.message).toContain("quota exhausted");
    await upstream.close();
    await app.close();
  });

  it("HTTP error statuses map to standardized codes and cap the snippet", async () => {
    let n = 0;
    const longBody = { error: { message: "boom".repeat(120) } };
    const upstream = await startFakeUpstream((_hit, res) => {
      n += 1;
      if (n === 1) return sendJson(res, 401, { error: { message: "bad key material" } });
      if (n === 2) return sendJson(res, 404, { error: { message: "no such model" } });
      sendJson(res, 500, longBody);
    });
    const { app } = openAiApp(upstream.url);
    const lane = lanes.laneFor("openai").key;

    const auth = await chat(app, lane, ask("gpt-4o", "err 401"));
    expect(auth.statusCode).toBe(502);
    expect(json<{ error: { code: string } }>(auth).error.code).toBe("provider_auth_error");
    expect(auth.body).not.toContain("bad key material");

    const notFound = await chat(app, lane, ask("gpt-4o", "err 404"));
    expect(notFound.statusCode).toBe(502);
    expect(json<{ error: { code: string } }>(notFound).error.code).toBe("provider_not_found");

    const server = await chat(app, lane, ask("gpt-4o", "err 500"));
    expect(server.statusCode).toBe(502);
    const serverBody = json<{ error: { code: string; message: string } }>(server);
    expect(serverBody.error.code).toBe("provider_error");
    expect(serverBody.error.message).toContain("boom");
    expect(serverBody.error.message.length).toBeLessThan(400);
    expect(upstream.hits.length).toBe(5);
    await upstream.close();
    await app.close();
  });

  it("an upstream that never answers is aborted by the timeout -> 504", async () => {
    const upstream = await startFakeUpstream(() => undefined);
    const { app } = openAiApp(upstream.url, "env-key", { UPSTREAM_TIMEOUT_MS: "150" });
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "hang please"));
    expect(res.statusCode).toBe(504);
    expect(json<{ error: { code: string } }>(res).error.code).toBe("gateway_timeout");
    expect(res.headers["x-lane"]).toBe("registered");
    await upstream.close();
    await app.close();
  });

  it("streams SSE with stream_options, skips malformed frames, maps the usage frame", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "s1", choices: [{ delta: { content: "Hel" } }] })}\n\n`);
      res.write("data: {not-json-at-all\n\n");
      res.write(`data: ${JSON.stringify({ id: "s1", choices: [{ delta: { content: "lo" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "s1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "stream wire", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(upstream.hits[0]!.body["stream"]).toBe(true);
    expect(upstream.hits[0]!.body["stream_options"]).toMatchObject({ include_usage: true });
    expect(upstream.hits[0]!.headers["accept"]).toBe("text/event-stream");
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(joinedDeltas(frames)).toBe("Hello");
    expect(frames[frames.length - 1]!["usage"]).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    await upstream.close();
    await app.close();
  });

  it("a 400 blaming stream_options is retried once without it", async () => {
    const upstream = await startFakeUpstream((hit, res) => {
      if (hit.body["stream_options"] !== undefined) {
        return sendJson(res, 400, { error: { message: "unknown parameter: stream_options" } });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "s2", choices: [{ delta: { content: "Re" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "retry wire", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(upstream.hits.length).toBe(2);
    expect(upstream.hits[0]!.body["stream_options"]).toBeDefined();
    expect("stream_options" in upstream.hits[1]!.body).toBe(false);
    expect(joinedDeltas(parseSSE(res.body).frames)).toBe("Re");
    await upstream.close();
    await app.close();
  });

  it("an unrelated 400 is NOT retried and surfaces as 502", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 400, { error: { message: "unknown model" } });
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "bad request", { stream: true }));
    expect(res.statusCode).toBe(502);
    expect(json<{ error: { code: string } }>(res).error.code).toBe("provider_error");
    expect(upstream.hits.length).toBe(1);
    await upstream.close();
    await app.close();
  });

  it("an error frame mid-stream closes the SSE with the partial text", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "s3", choices: [{ delta: { content: "part" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ error: { code: 500, message: "died halfway" } })}\n\n`);
      res.end();
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "die mid wire", { stream: true }));
    expect(res.statusCode).toBe(200);
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(false);
    expect(joinedDeltas(frames)).toBe("part");
    await upstream.close();
    await app.close();
  });
});

describe("Anthropic adapter over the wire", () => {
  it("folds system messages, defaults max_tokens, maps content blocks and usage", async () => {
    const upstream = await startFakeUpstream((hit, res) => {
      sendJson(res, 200, {
        id: "ant-1",
        model: hit.body["model"],
        content: [
          { type: "text", text: "hello " },
          { type: "tool_use", text: "ignored" },
          { type: "text", text: "world" },
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
      });
    });
    const { app } = anthropicApp(upstream.url);
    const res = await chat(app, lanes.laneFor("anthropic").key, {
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "be nice" },
        { role: "system", content: "be brief" },
        { role: "user", content: "wire probe" },
      ],
    });
    expect(res.statusCode).toBe(200);
    const hit = upstream.hits[0]!;
    expect(hit.url).toBe("/v1/messages");
    expect(hit.headers["x-api-key"]).toBe("env-key");
    expect(hit.headers["anthropic-version"]).toBe("2023-06-01");
    expect(hit.body).toMatchObject({
      model: "claude-3-5-sonnet",
      max_tokens: 1024,
      system: "be nice\nbe brief",
      messages: [{ role: "user", content: "wire probe" }],
      temperature: 1,
    });
    const body = json<{ id: string; choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } }>(res);
    expect(body.id).toBe("ant-1");
    expect(body.choices[0]!.message.content).toBe("hello world");
    expect(body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 6 });
    await upstream.close();
    await app.close();
  });

  it("passes max_tokens through when the client sets it", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "ant-2", model: "claude-3-5-sonnet", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const { app } = anthropicApp(upstream.url);
    await chat(app, lanes.laneFor("anthropic").key, ask("claude-3-5-sonnet", "max probe", { max_tokens: 7 }));
    expect(upstream.hits[0]!.body["max_tokens"]).toBe(7);
    await upstream.close();
    await app.close();
  });

  it("streams content_block_delta text and the message_delta usage", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}\n\n`);
      res.end();
    });
    const { app } = anthropicApp(upstream.url);
    const res = await chat(app, lanes.laneFor("anthropic").key, ask("claude-3-5-sonnet", "stream wire", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(upstream.hits[0]!.body["stream"]).toBe(true);
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(joinedDeltas(frames)).toBe("Hello");
    expect(frames[frames.length - 1]!["usage"]).toEqual({ prompt_tokens: 0, completion_tokens: 3 });
    await upstream.close();
    await app.close();
  });

  it("maps 401 to provider_auth_error", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 401, { error: { message: "invalid x-api-key", type: "authentication_error" } });
    });
    const { app } = anthropicApp(upstream.url);
    const res = await chat(app, lanes.laneFor("anthropic").key, ask("claude-3-5-sonnet", "auth probe"));
    expect(res.statusCode).toBe(502);
    expect(json<{ error: { code: string } }>(res).error.code).toBe("provider_auth_error");
    expect(res.body).not.toContain("invalid x-api-key");
    await upstream.close();
    await app.close();
  });

  it("an anthropic error event mid-stream closes the SSE with the partial text", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "frag" } })}\n\n`);
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n\n`);
      res.end();
    });
    const { app } = anthropicApp(upstream.url);
    const res = await chat(app, lanes.laneFor("anthropic").key, ask("claude-3-5-sonnet", "die mid wire", { stream: true }));
    expect(res.statusCode).toBe(200);
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(false);
    expect(joinedDeltas(frames)).toBe("frag");
    await upstream.close();
    await app.close();
  });
});

describe("upstream-key resolution", () => {
  it("a registered tenant's stored credential is forwarded (never the env key)", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "k1", model: "gpt-4o", choices: [{ message: { content: "stored" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const { app } = openAiApp(upstream.url);
    const reg = await app.inject({ method: "POST", url: "/v1/register", payload: { name: "k-stored", provider: "openai", provider_key: "sk-stored-secret" } });
    expect(reg.statusCode).toBe(201);
    const issued = json<{ key: string }>(reg);
    const res = await chat(app, issued.key, ask("gpt-4o", "credential probe"));
    expect(res.statusCode).toBe(200);
    expect(upstream.hits[0]!.headers["authorization"]).toBe("Bearer sk-stored-secret");
    await upstream.close();
    await app.close();
  });

  it("a registered lane without a stored credential uses the configured env key", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "k2", model: "gpt-4o", choices: [{ message: { content: "env" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "env probe"));
    expect(res.statusCode).toBe(200);
    expect(upstream.hits[0]!.headers["authorization"]).toBe("Bearer env-key");
    await upstream.close();
    await app.close();
  });

  it("an anonymous try-out forwards the presented x-provider-key and never the env key", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "k3", model: "gpt-4o", choices: [{ message: { content: "anon" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const { app } = openAiApp(upstream.url);
    const res = await chat(app, null, ask("gpt-4o", "anon probe"), { "x-provider-key": "sk-presented" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-lane"]).toBe("anonymous");
    expect(upstream.hits[0]!.headers["authorization"]).toBe("Bearer sk-presented");
    await upstream.close();
    await app.close();
  });

  it("a credential-store outage leaves the configured adapter serving (env key)", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "k4", model: "gpt-4o", choices: [{ message: { content: "degraded" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const down: CredentialStore = {
      name: "down-cred",
      save: async () => ({ status: "unavailable", reason: "db down" }),
      get: async () => ({ status: "unavailable", reason: "db down" }),
      list: async () => ({ status: "unavailable", reason: "db down" }),
      remove: async () => ({ status: "unavailable", reason: "db down" }),
      close: async () => undefined,
    };
    const { app } = makeApp({
      auth: { apiKeys: lanes.auth.apiKeys, credentials: down },
      provider: new OpenAICompatibleProvider({ name: "openai", baseURL: upstream.url, apiKey: "env-key", defaultModel: "gpt-default" }),
      env: { OPENAI_BASE_URL: upstream.url, OPENAI_API_KEY: "env-key" },
    });
    const res = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "outage probe"));
    expect(res.statusCode).toBe(200);
    expect(upstream.hits[0]!.headers["authorization"]).toBe("Bearer env-key");
    await upstream.close();
    await app.close();
  });
});
