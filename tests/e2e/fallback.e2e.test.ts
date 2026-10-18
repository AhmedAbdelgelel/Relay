
import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import { GatewayError } from "../../src/domain/types.js";
import { metrics } from "../../src/observability/metrics.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, makeApp, ScriptedProvider, sendJson, startFakeUpstream } from "./harness.js";

const lanes = await laneAuth(
  "mock",
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "openrouter",
);
const ask = (model: string, content: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: "user", content }],
  ...extra,
});

beforeEach(() => metrics.reset());

function failing(name: string, status: number, retryable: boolean): ScriptedProvider {
  return new ScriptedProvider(name, {
    chat: async () => {
      throw new GatewayError(status, status === 429 ? "provider_rate_limited" : "provider_error", `${name} down`, retryable);
    },
  });
}

describe("model-prefix routing", () => {
  it("gpt-/claude-/gemini-/llama-/openrouter signals route to their adapters", async () => {
    const openai = new ScriptedProvider("openai");
    const anthropic = new ScriptedProvider("anthropic");
    const gemini = new ScriptedProvider("gemini");
    const ollama = new ScriptedProvider("ollama");
    const openrouter = new ScriptedProvider("openrouter");
    const mock = new ScriptedProvider("mock");
    const providers = new Map([
      ["mock", mock],
      ["openai", openai],
      ["anthropic", anthropic],
      ["gemini", gemini],
      ["ollama", ollama],
      ["openrouter", openrouter],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });

    const cases: [string, string, ScriptedProvider][] = [
      ["gpt-4o-mini", "openai", openai],
      ["claude-3-5-sonnet", "anthropic", anthropic],
      ["gemini-2.0-flash", "gemini", gemini],
      ["llama3.2", "ollama", ollama],
      ["qwen/qwen3.8-27b:free", "openrouter", openrouter],
      ["openrouter/meta-llama/llama-3-8b", "openrouter", openrouter],
      ["m", "mock", mock],
    ];
    for (const [model, providerName, double] of cases) {
      const before = double.calls;
      const res = await chat(app, lanes.laneFor(providerName).key, ask(model, `route probe ${model}`));
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-provider"]).toBe(providerName);
      expect(double.calls).toBe(before + 1);
    }
    await app.close();
  });

  it("a prefix with no configured adapter falls back to the default provider", async () => {
    const mock = new ScriptedProvider("mock");
    const providers = new Map([["mock", mock]]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });
    const res = await chat(app, lanes.laneFor("mock").key, ask("gpt-4o-mini", "no openai configured"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("mock");
    expect(mock.calls).toBe(1);
    await app.close();
  });

  it("cache entries are provider-scoped: each adapter serves only its own replays", async () => {
    const mock = new ScriptedProvider("mock");
    const openai = new ScriptedProvider("openai");
    const providers = new Map([
      ["mock", mock],
      ["openai", openai],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });

    const local = await chat(app, lanes.laneFor("mock").key, ask("m", "same bytes"));
    const routed = await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "same bytes"));
    expect(local.headers["x-cache"]).toBe("MISS");
    expect(routed.headers["x-cache"]).toBe("MISS");
    expect(local.headers["x-cache-hash"]).not.toBe(routed.headers["x-cache-hash"]);

    expect((await chat(app, lanes.laneFor("mock").key, ask("m", "same bytes"))).headers["x-cache"]).toBe("HIT");
    expect((await chat(app, lanes.laneFor("openai").key, ask("gpt-4o", "same bytes"))).headers["x-cache"]).toBe("HIT");
    expect(mock.calls).toBe(1);
    expect(openai.calls).toBe(1);
    await app.close();
  });
});

describe("fallback chain", () => {
  it("retryable primary failure: retried inside the target, then the fallback serves", async () => {
    const primary = failing("mock", 503, true);
    const alt = new ScriptedProvider("alt");
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const res = await chat(app, lanes.laneFor("mock").key, ask("m", "failover retryable"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("alt");
    expect(res.headers["x-fallback"]).toBe("true");
    expect(primary.calls).toBe(3);
    expect(alt.calls).toBe(1);
    expect(metrics.snapshot().fallback_count).toBe(1);
    await app.close();
  });

  it("non-retryable primary failure: one attempt, then the fallback serves", async () => {
    const primary = failing("mock", 502, false);
    const alt = new ScriptedProvider("alt");
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const res = await chat(app, lanes.laneFor("mock").key, ask("m", "failover nonretryable"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-fallback"]).toBe("true");
    expect(primary.calls).toBe(1);
    expect(alt.calls).toBe(1);
    await app.close();
  });

  it("a fallback-served answer is admitted under the serving key and replays with x-fallback", async () => {
    const primary = new ScriptedProvider("mock", {
      chat: async () => {
        throw new GatewayError(502, "provider_error", "primary down", false);
      },
    });
    const alt = new ScriptedProvider("alt", {
      chat: async (req) => ({ id: "alt-1", model: req.model, content: "fallback answer", usage: { prompt_tokens: 2, completion_tokens: 3 } }),
    });
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });

    const first = await chat(app, lanes.laneFor("mock").key, ask("m", "fallback admission"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-provider"]).toBe("alt");
    expect(first.headers["x-fallback"]).toBe("true");
    const replay = await chat(app, lanes.laneFor("mock").key, ask("m", "fallback admission"));
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(replay.headers["x-provider"]).toBe("alt");
    expect(replay.headers["x-fallback"]).toBe("true");
    expect(replay.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("fallback answer");
    expect(alt.calls).toBe(1);
    await app.close();
  });

  it("breaker: 3 failing requests open the primary; the 4th skips it and metrics count once", async () => {
    const primary = failing("mock", 503, true);
    const alt = new ScriptedProvider("alt");
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const lane = lanes.laneFor("mock").key;
    for (let i = 0; i < 3; i++) {
      const res = await chat(app, lane, ask("m", `breaker probe ${i}`));
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-fallback"]).toBe("true");
    }
    expect(primary.calls).toBe(9);
    expect(metrics.snapshot().breaker_open).toBe(1);

    const fourth = await chat(app, lane, ask("m", "breaker probe skipped"));
    expect(fourth.statusCode).toBe(200);
    expect(fourth.headers["x-fallback"]).toBe("true");
    expect(primary.calls).toBe(9);
    expect(alt.calls).toBe(4);
    expect(metrics.snapshot().fallback_count).toBe(4);
    await app.close();
  });

  it("all breakers open -> 502 all-targets-unavailable without leaking internals", async () => {
    const primary = failing("mock", 502, false);
    const alt = failing("alt", 502, false);
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const lane = lanes.laneFor("mock").key;
    for (let i = 0; i < 3; i++) {
      const res = await chat(app, lane, ask("m", `open all ${i}`));
      expect(res.statusCode).toBe(502);
      expect(res.headers["x-lane"]).toBe("registered");
    }
    const stopped = await chat(app, lane, ask("m", "open all final"));
    expect(stopped.statusCode).toBe(502);
    const body = JSON.parse(stopped.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("provider_error");
    expect(body.error.message).toContain("all targets unavailable");
    expect(body.error.message).not.toContain("mock down");
    expect(body.error.message).not.toContain("alt down");
    expect(primary.calls).toBe(3);
    expect(alt.calls).toBe(3);
    await app.close();
  });

  it("single-provider mode never fails over: the routed target's error is final", async () => {
    const only = failing("mock", 503, true);
    const { app } = makeApp({ auth: lanes.auth, provider: only });
    const res = await chat(app, lanes.laneFor("mock").key, ask("m", "no fallback configured"));
    expect(res.statusCode).toBe(503);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe("provider_error");
    expect(only.calls).toBe(3);
    await app.close();
  });

  it("anonymous lane never borrows env-keyed fallback adapters", async () => {
    const upstream = await startFakeUpstream((_hit, res) => sendJson(res, 500, { error: { message: "boom" } }));
    const openai = new ScriptedProvider("openai");
    const alt = new ScriptedProvider("alt");
    const providers = new Map([
      ["openai", openai],
      ["alt", alt],
    ]);
    const { app } = makeApp({
      auth: lanes.auth,
      provider: openai,
      providers,
      env: { OPENAI_BASE_URL: upstream.url, OPENAI_API_KEY: "env-key", UPSTREAM_TIMEOUT_MS: "2000" },
    });
    const res = await chat(app, null, ask("gpt-x", "try-out"), { "x-provider-key": "sk-try-out" });
    expect(res.statusCode).toBe(502);
    expect(res.headers["x-lane"]).toBe("anonymous");
    expect(upstream.hits.length).toBe(3);
    expect(alt.calls).toBe(0);
    expect(openai.calls).toBe(0);
    await upstream.close();
    await app.close();
  });

  it("a credential-store outage keeps the configured adapter serving", async () => {
    const mock = new ScriptedProvider("mock");
    const downCredentials: CredentialStore = {
      name: "down-cred",
      save: async () => ({ status: "unavailable", reason: "db down" }),
      get: async () => ({ status: "unavailable", reason: "db down" }),
      list: async () => ({ status: "unavailable", reason: "db down" }),
      remove: async () => ({ status: "unavailable", reason: "db down" }),
      close: async () => undefined,
    };
    const { app } = makeApp({ auth: { apiKeys: lanes.auth.apiKeys, credentials: downCredentials }, provider: mock });
    const res = await chat(app, lanes.laneFor("mock").key, ask("m", "credential store down"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("mock");
    expect(mock.calls).toBe(1);
    await app.close();
  });
});
