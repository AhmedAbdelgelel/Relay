
import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import { buildProviderStatus } from "../../src/api/routes/providers.js";
import { GatewayError } from "../../src/domain/types.js";
import { loadConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { createProviderFromEnv, createProvidersFromEnv } from "../../src/providers/factory.js";
import { buildChain } from "../../src/routing/fallback.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, makeApp, ScriptedProvider, sendJson, startFakeUpstream, TEST_ENV, withEnv } from "./harness.js";

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

  it("an unknown model prefix falls back to the default provider", async () => {
    const mock = new ScriptedProvider("mock");
    const providers = new Map([["mock", mock]]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });
    const res = await chat(app, lanes.laneFor("mock").key, ask("mystery-model-9000", "no prefix"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("mock");
    expect(mock.calls).toBe(1);
    await app.close();
  });

  it("a known prefix whose provider is not configured falls back to the default adapter", async () => {
    // Documented zero-setup behavior the legacy UI relies on: the mock
    // gateway serves a gemini-* selection with the default adapter. When the
    // routed provider IS configured but keyless, the provider_key_missing
    // pre-check still fires (feature-contract D2 note). Only an absent
    // adapter falls back.
    const mock = new ScriptedProvider("mock");
    const providers = new Map([["mock", mock]]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });
    const res = await chat(app, lanes.laneFor("mock").key, ask("gpt-4o-mini", "no openai configured"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("mock");
    expect(mock.calls).toBe(1);
    await app.close();
  });

  it("a connected tenant credential still serves a routed provider without an env key", async () => {
    const mock = new ScriptedProvider("mock");
    const providers = new Map([["mock", mock]]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });
    const lane = lanes.laneFor("openrouter");
    const upstream = await startFakeUpstream((_hit, res) =>
      sendJson(res, 200, { id: "or-1", model: "x/y:free", choices: [{ message: { content: "connected ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const saved = await lanes.auth.credentials.save(lane.tenant, "openrouter", "sk-tenant", upstream.url);
    expect(saved.status).toBe("ok");
    const res = await chat(app, lane.key, ask("x/y:free", "connected route"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("openrouter");
    expect(upstream.hits.length).toBe(1);
    expect(mock.calls).toBe(0);
    await lanes.auth.credentials.remove(lane.tenant, "openrouter");
    await upstream.close();
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

describe("production composition (fake-fallback regression)", () => {
  const compose = (env: Record<string, string>) => {
    const cfg = withEnv({ ...TEST_ENV, ...env }, () => loadConfig());
    return { cfg, providers: createProvidersFromEnv(cfg) };
  };

  it("a non-mock default never exposes the in-process mock adapter", () => {
    // Regression: the fallback chain walks createProvidersFromEnv(); a mock
    // entry in a real deployment turned provider failures into fabricated 200s.
    const { providers } = compose({ PROVIDER: "openrouter", OPEN_ROUTER_KEY: "sk-or-test" });
    expect(providers.has("mock")).toBe(false);
    expect(providers.has("openrouter")).toBe(true);
  });

  it("a provider-specific model id never fails over to another provider (429 stays 429)", async () => {
    // Live-reproduced: an OpenRouter :free 429 was retried, then the same
    // openrouter-only model id was sent to ollama/gemini, ending as a
    // misleading "gemini 404 provider_not_found". The routed id is
    // provider-specific, so the chain must stay on that provider.
    const openrouter = failing("openrouter", 429, true);
    const gemini = new ScriptedProvider("gemini");
    const providers = new Map([
      ["openrouter", openrouter],
      ["gemini", gemini],
    ]);
    const localLanes = await laneAuth("openrouter");
    const { app } = makeApp({ auth: localLanes.auth, provider: openrouter, providers });
    const res = await chat(app, localLanes.laneFor("openrouter").key, ask("x/y:free", "provider specific 429"));
    expect(res.statusCode).toBe(429);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe("provider_rate_limited");
    expect(openrouter.calls).toBe(3); // two transient retries, same provider
    expect(gemini.calls).toBe(0);
    expect(metrics.snapshot().fallback_count).toBe(0);
    await app.close();
  });

  it("the zero-setup mock default still exposes mock", () => {
    const { providers } = compose({ PROVIDER: "mock" });
    expect(providers.has("mock")).toBe(true);
  });

  it("a keyless OpenRouter deployment reports it unconfigured and keeps it out of the map", () => {
    const { cfg, providers } = compose({ PROVIDER: "openai", OPENAI_API_KEY: "sk-openai-test", OPEN_ROUTER_KEY: "" });
    expect(providers.has("openrouter")).toBe(false);
    const status = buildProviderStatus(cfg, providers).find((p) => p.id === "openrouter")!;
    expect(status.configured).toBe(false);
  });

  it("buildChain lists each provider once even when a tenant credential shadows the env adapter", async () => {
    // A tenant BYO credential is a providerWithKey() adapter — same name as the
    // operator's env adapter but not the same object. Listing both would mix
    // breaker state and silently retry a tenant's failing key on the operator's
    // env key/endpoint.
    const tenantAdapter = new ScriptedProvider("openrouter");
    const envAdapter = new ScriptedProvider("openrouter");
    const alt = new ScriptedProvider("alt");
    const chain = buildChain(tenantAdapter, new Map([
      ["mock", new ScriptedProvider("mock")],
      ["openrouter", envAdapter],
      ["alt", alt],
    ]));
    expect(chain.map((t) => t.name)).toEqual(["openrouter", "mock", "alt"]);
    expect(chain[0]!.adapter).toBe(tenantAdapter);
  });

  it("a failed real provider returns a clean 502 instead of a fabricated mock 200", async () => {
    // Live-reproduced before the fix: PROVIDER=openrouter + unreachable upstream
    // -> chain fell through to the in-process mock and answered 200
    // `x-fallback:true` with "mock echo (...)" content. Both remaining targets
    // are dead here, so the only honest outcome is an exhausted-chain 502.
    const env = {
      PROVIDER: "openrouter",
      OPEN_ROUTER_KEY: "sk-or-test",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/v1",
      OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
      UPSTREAM_TIMEOUT_MS: "1500",
    };
    const cfg = withEnv({ ...TEST_ENV, ...env }, () => loadConfig());
    const provider = createProviderFromEnv(cfg);
    const providers = createProvidersFromEnv(cfg);
    const { app } = makeApp({ auth: lanes.auth, provider, providers, env });
    const res = await chat(app, lanes.laneFor("openrouter").key, ask("qwen/qwen3.8-27b:free", "fake fallback probe"));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("mock echo");
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe("provider_error");
    await app.close();
  });
});
