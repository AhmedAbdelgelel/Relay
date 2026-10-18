
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { RedisCache } from "../../src/cache/RedisCache.js";
import { buildExactCacheKey } from "../../src/domain/normalize.js";
import { GatewayError } from "../../src/domain/types.js";
import { metrics } from "../../src/observability/metrics.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, json, makeApp, ScriptedProvider, sleep } from "./harness.js";

const lanes = await laneAuth("mock");
const body = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "m",
  messages: [{ role: "user", content }],
  ...extra,
});

beforeEach(() => metrics.reset());

describe("exact cache identity", () => {
  it("MISS -> HIT: same bytes back, provider runs once, hash stable", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const first = await chat(app, lanes.laneFor("mock").key, body("cache me"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");

    const second = await chat(app, lanes.laneFor("mock").key, body("cache me"));
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.headers["x-cache-hash"]).toBe(first.headers["x-cache-hash"]);
    expect(second.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe(
      first.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content,
    );
    expect(provider.calls).toBe(1);
    const m = metrics.snapshot();
    expect(m.exact_misses).toBe(1);
    expect(m.exact_hits).toBe(1);
    expect(m.provider_requests).toBe(1);
    expect(m.provider_calls_avoided).toBe(1);
    await app.close();
  });

  it("canonicalization: content edge-whitespace and model case-trim collapse to the same entry", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const first = await chat(app, lanes.laneFor("mock").key, body("trim me"));
    expect(first.headers["x-cache"]).toBe("MISS");

    const padded = await chat(app, lanes.laneFor("mock").key, body("   trim me   "));
    expect(padded.headers["x-cache"]).toBe("HIT");
    expect(padded.headers["x-cache-hash"]).toBe(first.headers["x-cache-hash"]);

    const routed = await chat(app, lanes.laneFor("mock").key, { model: " m ", messages: [{ role: "user", content: "trim me" }] });
    expect(routed.headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(1);
    await app.close();
  });

  it("temperature is part of identity: drift MISSes, the new temperature gets its own entry", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    expect((await chat(app, lanes.laneFor("mock").key, body("temp identity"))).headers["x-cache"]).toBe("MISS");
    const drift = await chat(app, lanes.laneFor("mock").key, body("temp identity", { temperature: 0.5 }));
    expect(drift.headers["x-cache"]).toBe("MISS");
    const again = await chat(app, lanes.laneFor("mock").key, body("temp identity", { temperature: 0.5 }));
    expect(again.headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("max_tokens and message order are identity: param added or order changed -> MISS", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    expect((await chat(app, lanes.laneFor("mock").key, body("identity rider"))).headers["x-cache"]).toBe("MISS");
    const withMax = await chat(app, lanes.laneFor("mock").key, body("identity rider", { max_tokens: 5 }));
    expect(withMax.headers["x-cache"]).toBe("MISS");
    expect((await chat(app, lanes.laneFor("mock").key, body("identity rider", { max_tokens: 5 }))).headers["x-cache"]).toBe("HIT");

    const ordered = { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
    const swapped = { model: "m", messages: [{ role: "user", content: "u" }, { role: "system", content: "s" }] };
    expect((await chat(app, lanes.laneFor("mock").key, ordered)).headers["x-cache"]).toBe("MISS");
    expect((await chat(app, lanes.laneFor("mock").key, swapped)).headers["x-cache"]).toBe("MISS");
    await app.close();
  });

  it("model is identity: same text under another model -> different hash, no cross-model bleed", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const a = await chat(app, lanes.laneFor("mock").key, body("shared text"));
    const b = await chat(app, lanes.laneFor("mock").key, { model: "m2", messages: [{ role: "user", content: "shared text" }] });
    expect(a.headers["x-cache"]).toBe("MISS");
    expect(b.headers["x-cache"]).toBe("MISS");
    expect(a.headers["x-cache-hash"]).not.toBe(b.headers["x-cache-hash"]);
    expect((await chat(app, lanes.laneFor("mock").key, body("shared text"))).headers["x-cache"]).toBe("HIT");
    expect((await chat(app, lanes.laneFor("mock").key, { model: "m2", messages: [{ role: "user", content: "shared text" }] })).headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("x-cache-hash equals the documented canonical sha256", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, lanes.laneFor("mock").key, body("hash parity"));
    const expected = buildExactCacheKey("mock", { model: "m", messages: [{ role: "user", content: "hash parity" }], temperature: 1, stream: false });
    expect(res.headers["x-cache-hash"]).toBe(expected.hash);
    await app.close();
  });
});

describe("exact cache lifecycle", () => {
  it("TTL expiry: entry serves before the deadline, MISSes after", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, env: { CACHE_TTL_S: "1", SEMANTIC_ENABLED: "false" } });
    expect((await chat(app, lanes.laneFor("mock").key, body("ttl probe"))).headers["x-cache"]).toBe("MISS");
    expect((await chat(app, lanes.laneFor("mock").key, body("ttl probe"))).headers["x-cache"]).toBe("HIT");
    await sleep(1300);
    expect((await chat(app, lanes.laneFor("mock").key, body("ttl probe"))).headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("CACHE_ENABLED=false: DISABLED evidence, hash still reported, nothing written", async () => {
    const sets: string[] = [];
    const inner = new InMemoryCache();
    const cache: CacheRepository = {
      name: "spy",
      get: (k) => inner.get(k),
      set: (k, v, ttl) => {
        sets.push(k);
        return inner.set(k, v, ttl);
      },
      del: (k) => inner.del(k),
      ping: () => inner.ping(),
      close: () => inner.close(),
    };
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, cache, env: { CACHE_ENABLED: "false", SEMANTIC_ENABLED: "false" } });
    const first = await chat(app, lanes.laneFor("mock").key, body("disabled path"));
    expect(first.headers["x-cache"]).toBe("DISABLED");
    expect(first.headers["x-cache-hash"]).toBeTruthy();
    const second = await chat(app, lanes.laneFor("mock").key, body("disabled path"));
    expect(second.headers["x-cache"]).toBe("DISABLED");
    expect(provider.calls).toBe(2);
    expect(sets).toEqual([]);
    await app.close();
  });

  it("malformed stored entry is evicted and served as MISS", async () => {
    const provider = new ScriptedProvider("mock");
    const cache = new InMemoryCache();
    const { app } = makeApp({ auth: lanes.auth, provider, cache });
    const req = { model: "m", messages: [{ role: "user" as const, content: "malformed neighbor" }], temperature: 1 };
    await cache.set(buildExactCacheKey("mock", { ...req, stream: false }).key, "{definitely not json", 60);
    const res = await chat(app, lanes.laneFor("mock").key, { model: req.model, messages: req.messages });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    expect((await chat(app, lanes.laneFor("mock").key, { model: req.model, messages: req.messages })).headers["x-cache"]).toBe("HIT");
    await app.close();
  });

  it("dead cache on read degrades to MISS; dead on write still 200 (never 5xx)", async () => {
    const readDead: CacheRepository = {
      name: "read-dead",
      get: async () => {
        throw new Error("ECONNREFUSED redis");
      },
      set: async () => undefined,
      del: async () => undefined,
      ping: async () => false,
      close: async () => undefined,
    };
    const providerA = new ScriptedProvider("mock");
    const a = makeApp({ auth: lanes.auth, provider: providerA, cache: readDead });
    const resA = await chat(a.app, lanes.laneFor("mock").key, body("read dead"));
    expect(resA.statusCode).toBe(200);
    expect(resA.headers["x-cache"]).toBe("MISS");
    expect(metrics.snapshot().cache_lookup_failed).toBe(1);
    await a.app.close();

    metrics.reset();
    const writeDead: CacheRepository = {
      name: "write-dead",
      get: async () => null,
      set: async () => {
        throw new Error("ECONNREFUSED redis");
      },
      del: async () => undefined,
      ping: async () => false,
      close: async () => undefined,
    };
    const providerB = new ScriptedProvider("mock");
    const b = makeApp({ auth: lanes.auth, provider: providerB, cache: writeDead });
    const resB = await chat(b.app, lanes.laneFor("mock").key, body("write dead"));
    expect(resB.statusCode).toBe(200);
    expect(resB.headers["x-cache"]).toBe("MISS");
    expect(metrics.snapshot().cache_write_failed).toBe(1);
    await b.app.close();
  });

  it("a bounded exact cache evicts the oldest entry (replay -> MISS)", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, cache: new InMemoryCache({ maxEntries: 2 }), env: { SEMANTIC_ENABLED: "false" } });
    for (const content of ["lru one", "lru two", "lru three"]) {
      expect((await chat(app, lanes.laneFor("mock").key, body(content))).headers["x-cache"]).toBe("MISS");
    }
    expect((await chat(app, lanes.laneFor("mock").key, body("lru two"))).headers["x-cache"]).toBe("HIT");
    expect((await chat(app, lanes.laneFor("mock").key, body("lru one"))).headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(4);
    await app.close();
  });

  it("empty and whitespace-only provider replies are served once but never admitted", async () => {
    let n = 0;
    const provider = new ScriptedProvider("mock", {
      chat: async () => {
        n++;
        return { id: `p-${n}`, model: "m", content: n === 1 ? "" : "   ", usage: { prompt_tokens: 1, completion_tokens: 0 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    expect((await chat(app, lanes.laneFor("mock").key, body("empty reply"))).statusCode).toBe(200);
    expect((await chat(app, lanes.laneFor("mock").key, body("empty reply"))).headers["x-cache"]).toBe("MISS");
    expect(n).toBe(2);
    await app.close();
  });

  it("stored replies are the NORMALIZED text: a HIT returns the cleaned answer", async () => {
    const provider = new ScriptedProvider("mock", {
      chat: async () => ({ id: "norm-1", model: "m", content: "**bold** answer", usage: { prompt_tokens: 2, completion_tokens: 3 } }),
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const first = await chat(app, lanes.laneFor("mock").key, body("normalize me"));
    expect(first.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("bold answer");
    const second = await chat(app, lanes.laneFor("mock").key, body("normalize me"));
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("bold answer");
    await app.close();
  });
});

describe("single-flight", () => {
  it("40 concurrent identical misses -> 1 provider call; followers are coalesced", async () => {
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        await sleep(30);
        return { id: "coalesced", model: req.model, content: "slow answer", usage: { prompt_tokens: 4, completion_tokens: 2 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const lane = lanes.laneFor("mock").key;
    const results = await Promise.all(Array.from({ length: 40 }, () => chat(app, lane, body("stampede"))));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(provider.calls).toBe(1);
    const coalesced = results.filter((r) => r.headers["x-coalesced"] === "true");
    expect(coalesced.length).toBe(39);
    expect(results.every((r) => json<{ choices: { message: { content: string } }[] }>(r).choices[0]!.message.content === "slow answer")).toBe(true);
    const m = metrics.snapshot();
    expect(m.singleflight_leaders).toBe(1);
    expect(m.singleflight_coalesced).toBe(39);
    expect(m.provider_requests).toBe(1);
    await app.close();
  });

  it("different prompts do NOT coalesce", async () => {
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        await sleep(25);
        return { id: "own", model: req.model, content: `own: ${req.messages[0]!.content}`, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const lane = lanes.laneFor("mock").key;
    const [a, b] = await Promise.all([chat(app, lane, body("different one")), chat(app, lane, body("different two"))]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(provider.calls).toBe(2);
    expect(metrics.snapshot().singleflight_coalesced).toBe(0);
    await app.close();
  });

  it("provider failure reaches every waiter but never poisons the next retry", async () => {
    let attempts = 0;
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        attempts++;
        await sleep(20);
        if (attempts <= 3) throw new GatewayError(429, "provider_rate_limited", "mock rate limited.", true);
        return { id: "recovered", model: req.model, content: "recovered answer", usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const lane = lanes.laneFor("mock").key;
    const wave = await Promise.all(Array.from({ length: 3 }, () => chat(app, lane, body("flaky upstream"))));
    expect(wave.every((r) => r.statusCode === 429)).toBe(true);
    const retry = await chat(app, lane, body("flaky upstream"));
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("recovered answer");
    expect(metrics.snapshot().provider_errors).toBe(1);
    await app.close();
  });
});

describe("canonical edge equivalence", () => {
  it("field order and an explicit default temperature collapse to one entry", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, env: { SEMANTIC_ENABLED: "false" } });
    const lane = lanes.laneFor("mock").key;

    const first = await chat(app, lane, { model: "m", messages: [{ role: "user", content: "orderless" }] });
    expect(first.headers["x-cache"]).toBe("MISS");

    const reordered = await chat(app, lane, {
      temperature: 1,
      messages: [{ content: "orderless", role: "user" as const }],
      model: "m",
    });
    expect(reordered.headers["x-cache"]).toBe("HIT");
    expect(reordered.headers["x-cache-hash"]).toBe(first.headers["x-cache-hash"]);

    const explicit = await chat(app, lane, { model: "m", messages: [{ role: "user", content: "orderless" }], temperature: 1.0 });
    expect(explicit.headers["x-cache"]).toBe("HIT");
    expect(explicit.headers["x-cache-hash"]).toBe(first.headers["x-cache-hash"]);
    expect(provider.calls).toBe(1);
    expect(metrics.snapshot().exact_hits).toBe(2);
    await app.close();
  });
});

describe("malformed-shape eviction", () => {
  it("valid JSON with the wrong shape is evicted and served as MISS", async () => {
    const provider = new ScriptedProvider("mock");
    const inner = new InMemoryCache();
    const dels: string[] = [];
    const cache: CacheRepository = {
      name: "spy",
      get: (k) => inner.get(k),
      set: (k, v, ttl) => inner.set(k, v, ttl),
      del: (k) => {
        dels.push(k);
        return inner.del(k);
      },
      ping: () => inner.ping(),
      close: () => inner.close(),
    };
    const { app } = makeApp({ auth: lanes.auth, provider, cache, env: { SEMANTIC_ENABLED: "false" } });
    const lane = lanes.laneFor("mock").key;
    const req = { model: "m", messages: [{ role: "user" as const, content: "wrong shape neighbor" }] };
    const key = buildExactCacheKey("mock", { ...req, temperature: 1, stream: false }).key;
    await inner.set(key, JSON.stringify({ content: 5, model: "m" }), 60);

    const res = await chat(app, lane, req);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(dels).toEqual([key]);
    expect(provider.calls).toBe(1);
    expect((await chat(app, lane, req)).headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(1);
    await app.close();
  });
});

describe("real cache transport failure", () => {
  it("RedisCache against a dead port: every request MISSes with a 200 and failure counters", async () => {
    const provider = new ScriptedProvider("mock");
    const cache = new RedisCache({ url: "redis://127.0.0.1:1", commandTimeoutMs: 150 });
    try {
      const { app } = makeApp({ auth: lanes.auth, provider, cache, env: { SEMANTIC_ENABLED: "false" } });
      const lane = lanes.laneFor("mock").key;

      const first = await chat(app, lane, body("redis down probe"));
      expect(first.statusCode).toBe(200);
      expect(first.headers["x-cache"]).toBe("MISS");
      expect(first.headers["x-cache-hash"]).toBeTruthy();

      const second = await chat(app, lane, body("redis down probe"));
      expect(second.statusCode).toBe(200);
      expect(second.headers["x-cache"]).toBe("MISS");
      expect(second.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe(
        first.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content,
      );
      expect(provider.calls).toBe(2);

      const m = metrics.snapshot();
      expect(m.cache_lookup_failed).toBe(2);
      expect(m.cache_write_failed).toBe(2);
      expect(m.provider_errors).toBe(0);
      expect(m.exact_misses).toBe(2);
      await app.close();
    } finally {
      await cache.close();
    }
  }, 15000);
});

describe("error responses never enter the cache (INV-8)", () => {
  it("a 503 wave is never admitted; the recovered answer is admitted exactly once", async () => {
    let down = true;
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        if (down) throw new GatewayError(503, "provider_error", "primary down", true);
        return { id: "inv8", model: req.model, content: "recovered answer", usage: { prompt_tokens: 2, completion_tokens: 3 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider, env: { SEMANTIC_ENABLED: "false" } });
    const lane = lanes.laneFor("mock").key;

    const failed = await chat(app, lane, body("inv8 probe"));
    expect(failed.statusCode).toBe(503);
    expect(failed.headers["x-cache-hash"]).toBeTruthy();
    expect(json<{ error: { code: string } }>(failed).error.code).toBe("provider_error");
    expect(provider.calls).toBe(3);

    down = false;
    const served = await chat(app, lane, body("inv8 probe"));
    expect(served.statusCode).toBe(200);
    expect(served.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(4);

    const replay = await chat(app, lane, body("inv8 probe"));
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(replay.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("recovered answer");
    expect(provider.calls).toBe(4);

    const m = metrics.snapshot();
    expect(m.exact_misses).toBe(2);
    expect(m.exact_hits).toBe(1);
    expect(m.provider_errors).toBe(1);
    expect(m.provider_requests).toBe(2);
    expect(m.provider_calls_avoided).toBe(1);
    await app.close();
  });
});
