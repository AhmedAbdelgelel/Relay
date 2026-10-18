// Provider connections (BYO key + URL): a registered tenant attaches its own
// upstream key and base URL per provider — `base_url` on POST /v1/register,
// or POST /v1/connections for an existing gateway key. The chat route then
// routes the model's provider to the tenant's endpoint with the tenant's key,
// and the key-binding mismatch no longer blocks providers the tenant has
// connected. Free models (`:free` → openrouter) are the OpenRouter story: a
// keyless gateway fails with an actionable 401 instead of a mystery 502.

import { beforeEach, describe, expect, it } from "vitest";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, json, makeApp, sendJson, startFakeUpstream } from "./harness.js";

const FREE_MODEL = "google/gemma-4-26b-a4b-it:free";

beforeEach(() => metrics.reset());

/** A keyless env OpenRouter adapter: present in the routing map, no credential. */
function keylessOpenRouter(baseURL = "https://openrouter.invalid/api/v1"): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ name: "openrouter", baseURL, apiKey: "", defaultModel: FREE_MODEL });
}

function ask(model: string, content: string) {
  return { model, messages: [{ role: "user", content }] };
}

describe("provider connections (register with base_url)", () => {
  it("register with base_url: :free chats go to the tenant's URL with the tenant's key", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, {
        id: "or-1",
        model: FREE_MODEL,
        choices: [{ message: { content: "free answer" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    });
    const mock = new MockProvider();
    const providers = new Map<string, ProviderAdapter>([
      ["mock", mock],
      ["openrouter", keylessOpenRouter()],
    ]);
    const { app, auth } = makeApp({ provider: mock, providers });

    const reg = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: { name: "free-tier", provider: "openrouter", provider_key: "sk-tenant-openrouter", base_url: upstream.url },
    });
    expect(reg.statusCode).toBe(201);
    const issued = json<{ tenant_id: string; key: string }>(reg);

    // The credential really carries the tenant URL (white-box).
    const stored = await auth.credentials.get(issued.tenant_id, "openrouter");
    expect(stored).toEqual({ status: "ok", providerKey: "sk-tenant-openrouter", baseUrl: upstream.url });

    const first = await chat(app, issued.key, ask(FREE_MODEL, "hello free tier"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-provider"]).toBe("openrouter");
    expect(first.headers["x-lane"]).toBe("registered");
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(upstream.hits.length).toBe(1);
    expect(upstream.hits[0]!.headers.authorization).toBe("Bearer sk-tenant-openrouter");
    expect(json<{ choices: { message: { content: string } }[] }>(first).choices[0]!.message.content).toBe("free answer");

    // Caching still works: the replay never reaches the tenant URL again.
    const second = await chat(app, issued.key, ask(FREE_MODEL, "hello free tier"));
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(upstream.hits.length).toBe(1);

    await upstream.close();
    await app.close();
  });
});

describe("provider connections (POST /v1/connections)", () => {
  it("an existing gateway key connects another provider: the route unlocks", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, {
        id: "oai-1",
        model: "gpt-4o-mini",
        choices: [{ message: { content: "connected openai" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const mock = new MockProvider();
    // The env key makes openai *serveable*: the binding check (403) applies and
    // connecting the tenant key is what unlocks the route on this gateway key.
    const providers = new Map<string, ProviderAdapter>([
      ["mock", mock],
      ["openai", new OpenAICompatibleProvider({ name: "openai", baseURL: "https://api.openai.invalid/v1", apiKey: "sk-env-openai", defaultModel: "gpt-4o-mini" })],
    ]);
    const { app } = makeApp({ provider: mock, providers });

    const reg = await app.inject({ method: "POST", url: "/v1/register", payload: { name: "mix", provider: "mock", provider_key: "sk-mock" } });
    const issued = json<{ key: string }>(reg);
    const authHeader = { authorization: `Bearer ${issued.key}` };

    // Bound to mock: the openai route is blocked with a connect hint.
    const before = await chat(app, issued.key, ask("gpt-4o-mini", "needs my key"));
    expect(before.statusCode).toBe(403);
    const err = json<{ error: { code: string; message: string } }>(before);
    expect(err.error.code).toBe("provider_mismatch");
    expect(err.error.message).toContain("connect 'openai'");
    expect(upstream.hits.length).toBe(0);

    // Connect openai with the tenant key + URL on the same gateway key.
    const connect = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: authHeader,
      payload: { provider: "openai", provider_key: "sk-tenant-openai", base_url: upstream.url },
    });
    expect(connect.statusCode).toBe(201);
    expect(json(connect)).toEqual({ provider: "openai", base_url: upstream.url, endpoint: upstream.url, connected: true });

    const after = await chat(app, issued.key, ask("gpt-4o-mini", "needs my key"));
    expect(after.statusCode).toBe(200);
    expect(after.headers["x-provider"]).toBe("openai");
    expect(upstream.hits[0]!.headers.authorization).toBe("Bearer sk-tenant-openai");

    // The list is metadata-only: provider, URL, effective endpoint, timestamp.
    const listed = await app.inject({ method: "GET", url: "/v1/connections", headers: authHeader });
    expect(listed.statusCode).toBe(200);
    const payload = json<{
      tenant_id: string;
      connections: { provider: string; base_url: string | null; endpoint: string; created_at: string }[];
    }>(listed);
    expect(payload.connections.map((c) => c.provider)).toEqual(["mock", "openai"]);
    expect(payload.connections[0]).toMatchObject({ provider: "mock", base_url: null, endpoint: "in-process" });
    expect(payload.connections[1]).toMatchObject({ provider: "openai", base_url: upstream.url, endpoint: upstream.url });
    expect(payload.connections[1]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listed.body).not.toContain("sk-tenant-openai");

    await upstream.close();
    await app.close();
  });

  it("reconnecting a provider replaces its key + URL (one row per provider)", async () => {
    const upstreamA = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "a", model: "gpt-4o-mini", choices: [{ message: { content: "served by A" } }] });
    });
    const upstreamB = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "b", model: "gpt-4o-mini", choices: [{ message: { content: "served by B" } }] });
    });
    const mock = new MockProvider();
    const providers = new Map<string, ProviderAdapter>([
      ["mock", mock],
      ["openai", new OpenAICompatibleProvider({ name: "openai", baseURL: "https://api.openai.invalid/v1", apiKey: "", defaultModel: "gpt-4o-mini" })],
    ]);
    const { app } = makeApp({ provider: mock, providers });
    const reg = await app.inject({ method: "POST", url: "/v1/register", payload: { name: "reconnect", provider: "openai", provider_key: "sk-first", base_url: upstreamA.url } });
    const issued = json<{ key: string }>(reg);
    const authHeader = { authorization: `Bearer ${issued.key}` };

    const first = await chat(app, issued.key, ask("gpt-4o-mini", "round one"));
    expect(first.statusCode).toBe(200);
    expect(upstreamA.hits[0]!.headers.authorization).toBe("Bearer sk-first");

    const reconnect = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: authHeader,
      payload: { provider: "openai", provider_key: "sk-second", base_url: upstreamB.url },
    });
    expect(reconnect.statusCode).toBe(201);

    const second = await chat(app, issued.key, ask("gpt-4o-mini", "round two"));
    expect(second.statusCode).toBe(200);
    expect(upstreamB.hits[0]!.headers.authorization).toBe("Bearer sk-second");
    expect(upstreamA.hits.length).toBe(1);

    const listed = json<{ connections: { provider: string; base_url: string | null }[] }>(
      await app.inject({ method: "GET", url: "/v1/connections", headers: authHeader }),
    );
    const openaiRows = listed.connections.filter((c) => c.provider === "openai");
    expect(openaiRows).toHaveLength(1);
    expect(openaiRows[0]!.base_url).toBe(upstreamB.url);

    await upstreamA.close();
    await upstreamB.close();
    await app.close();
  });

  it("connection management requires a registered gateway key", async () => {
    const { app } = makeApp();
    const none = await app.inject({ method: "POST", url: "/v1/connections", payload: { provider: "openai", provider_key: "k" } });
    expect(none.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(none).error.code).toBe("missing_api_key");

    const anon = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: { "x-provider-key": "sk-anon" },
      payload: { provider: "openai", provider_key: "k" },
    });
    expect(anon.statusCode).toBe(401);
    expect(anon.body).toContain("registered gateway key");

    const listed = await app.inject({ method: "GET", url: "/v1/connections" });
    expect(listed.statusCode).toBe(401);
    await app.close();
  });

  it("validation: bad provider, key or base_url 400 without store writes", async () => {
    const { app, auth } = makeApp();

    const regBadUrl = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: { name: "v", provider: "openrouter", provider_key: "k", base_url: "ftp://mirror.local/x" },
    });
    expect(regBadUrl.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(regBadUrl).error.code).toBe("invalid_request");

    const regNotUrl = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: { name: "v", provider: "openrouter", provider_key: "k", base_url: "not a url" },
    });
    expect(regNotUrl.statusCode).toBe(400);

    const reg = await app.inject({ method: "POST", url: "/v1/register", payload: { name: "v", provider: "mock", provider_key: "k" } });
    const issued = json<{ tenant_id: string; key: string }>(reg);
    const headers = { authorization: `Bearer ${issued.key}` };

    const badProvider = await app.inject({ method: "POST", url: "/v1/connections", headers, payload: { provider: "nope", provider_key: "k" } });
    expect(badProvider.statusCode).toBe(400);
    const badUrl = await app.inject({ method: "POST", url: "/v1/connections", headers, payload: { provider: "openai", provider_key: "k", base_url: "ws://proxy.internal" } });
    expect(badUrl.statusCode).toBe(400);
    const badKey = await app.inject({ method: "POST", url: "/v1/connections", headers, payload: { provider: "openai", provider_key: "" } });
    expect(badKey.statusCode).toBe(400);

    // Only the register write landed: invalid attempts touched no store.
    const listed = await auth.credentials.list(issued.tenant_id);
    expect(listed.status === "ok" && listed.connections.map((c) => c.provider)).toEqual(["mock"]);
    expect(metrics.snapshot().auth_rejects_total).toBe(0);

    await app.close();
  });
});

describe("OpenRouter free models on a keyless gateway", () => {
  it("fails with an actionable 401, then serves once the tenant connects its key + URL", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, {
        id: "or-2",
        model: FREE_MODEL,
        choices: [{ message: { content: "OPENROUTER_OK" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    });
    const lanes = await laneAuth("openrouter");
    const mock = new MockProvider();
    const providers = new Map<string, ProviderAdapter>([
      ["mock", mock],
      ["openrouter", keylessOpenRouter()],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });
    const key = lanes.laneFor("openrouter").key;

    const denied = await chat(app, key, ask(FREE_MODEL, "free model probe"));
    expect(denied.statusCode).toBe(401);
    const err = json<{ error: { code: string; message: string } }>(denied);
    expect(err.error.code).toBe("provider_key_missing");
    expect(err.error.message).toContain("connect your own key");
    expect(upstream.hits.length).toBe(0);

    const connect = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: { authorization: `Bearer ${key}` },
      payload: { provider: "openrouter", provider_key: "sk-tenant-openrouter", base_url: upstream.url },
    });
    expect(connect.statusCode).toBe(201);

    const served = await chat(app, key, ask(FREE_MODEL, "free model probe"));
    expect(served.statusCode).toBe(200);
    expect(served.headers["x-provider"]).toBe("openrouter");
    expect(json<{ choices: { message: { content: string } }[] }>(served).choices[0]!.message.content).toBe("OPENROUTER_OK");
    expect(upstream.hits[0]!.headers.authorization).toBe("Bearer sk-tenant-openrouter");

    await upstream.close();
    await app.close();
  });

  it("a key bound to another provider gets the actionable 401 (not a mystery 403), then connecting unlocks it", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "or-4", model: FREE_MODEL, choices: [{ message: { content: "unlocked" } }] });
    });
    // The tenant key is bound to 'mock' (the exact reported 403: chat a :free
    // model with a key registered for another provider). With no key anywhere
    // for openrouter, the actionable 401 comes first; connecting the provider
    // then routes it on the same gateway key.
    const lanes = await laneAuth("openrouter", "mock");
    const providers = new Map<string, ProviderAdapter>([
      ["mock", new MockProvider()],
      ["openrouter", keylessOpenRouter()],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: new MockProvider(), providers });
    const mockKey = lanes.laneFor("mock").key;

    const denied = await chat(app, mockKey, ask(FREE_MODEL, "bound elsewhere"));
    expect(denied.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(denied).error.code).toBe("provider_key_missing");

    const connect = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: { authorization: `Bearer ${mockKey}` },
      payload: { provider: "openrouter", provider_key: "sk-tenant-openrouter", base_url: upstream.url },
    });
    expect(connect.statusCode).toBe(201);

    const served = await chat(app, mockKey, ask(FREE_MODEL, "bound elsewhere"));
    expect(served.statusCode).toBe(200);
    expect(served.headers["x-provider"]).toBe("openrouter");
    expect(upstream.hits[0]!.headers.authorization).toBe("Bearer sk-tenant-openrouter");

    await upstream.close();
    await app.close();
  });

  it("without a stored credential the configured env key still serves (fallback preserved)", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "or-3", model: FREE_MODEL, choices: [{ message: { content: "env key served" } }] });
    });
    const lanes = await laneAuth("openrouter");
    const providers = new Map<string, ProviderAdapter>([
      ["mock", new MockProvider()],
      ["openrouter", new OpenAICompatibleProvider({ name: "openrouter", baseURL: upstream.url, apiKey: "sk-env-openrouter", defaultModel: FREE_MODEL })],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: new MockProvider(), providers });

    const served = await chat(app, lanes.laneFor("openrouter").key, ask(FREE_MODEL, "env key probe"));
    expect(served.statusCode).toBe(200);
    expect(upstream.hits[0]!.headers.authorization).toBe("Bearer sk-env-openrouter");

    await upstream.close();
    await app.close();
  });
});
