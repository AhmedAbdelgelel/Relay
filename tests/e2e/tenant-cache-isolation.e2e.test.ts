
// Tenant isolation for the exact cache (correctness task 1).
//
// The exact cache key must bind the AUTHENTICATED tenant, not just the request
// bytes + provider: two tenants sending byte-identical prompts must never share
// a cached answer (cross-tenant answer leak) and each tenant's replays must stay
// inside its own namespace. Tenant identity is `request.auth.tenant` from the
// gateway key — a client-supplied header such as x-tenant-id is never trusted.
//
// The key version is bumped to v2 for this change: v1 entries were global, so a
// v2 lookup must never reuse them (they would leak across tenants).

import { beforeEach, describe, expect, it } from "vitest";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { buildExactCacheKey } from "../../src/domain/normalize.js";
import { GatewayError } from "../../src/domain/types.js";
import { metrics } from "../../src/observability/metrics.js";
import { issueLane, laneAuth } from "../helpers/lane.js";
import { chat, makeApp, ScriptedProvider } from "./harness.js";

const lanes = await laneAuth("mock");
const tenantA = lanes.laneFor("mock");
const tenantB = await issueLane(lanes.auth, "mock", "tenant-b");

const ask = (content: string) => ({ model: "m", messages: [{ role: "user", content }] });

interface SpyCache extends CacheRepository {
  gets: string[];
  sets: string[];
}

/** CacheRepository wrapper capturing the exact keys the route reads/writes. */
function spyCache(): SpyCache {
  const inner = new InMemoryCache();
  const gets: string[] = [];
  const sets: string[] = [];
  return {
    name: "spy",
    gets,
    sets,
    get: (k) => {
      gets.push(k);
      return inner.get(k);
    },
    set: (k, v, ttl) => {
      sets.push(k);
      return inner.set(k, v, ttl);
    },
    del: (k) => inner.del(k),
    ping: () => inner.ping(),
    close: () => inner.close(),
  };
}

beforeEach(() => metrics.reset());

describe("exact cache tenant isolation", () => {
  it("two tenants with byte-identical requests: both MISS, repeats hit their own entry", async () => {
    const provider = new ScriptedProvider("mock");
    const cache = spyCache();
    const { app } = makeApp({ auth: lanes.auth, provider, cache });

    const a1 = await chat(app, tenantA.key, ask("same prompt"));
    expect(a1.statusCode).toBe(200);
    expect(a1.headers["x-cache"]).toBe("MISS");

    // Before tenant scoping this was a HIT: tenant B served tenant A's answer.
    const b1 = await chat(app, tenantB.key, ask("same prompt"));
    expect(b1.statusCode).toBe(200);
    expect(b1.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);

    const b2 = await chat(app, tenantB.key, ask("same prompt"));
    expect(b2.headers["x-cache"]).toBe("HIT");
    const a2 = await chat(app, tenantA.key, ask("same prompt"));
    expect(a2.headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(2);

    // x-cache-hash stays the tenant-independent canonical hash (browser parity),
    // but the storage keys are namespaced per tenant.
    expect(a2.headers["x-cache-hash"]).toBe(b2.headers["x-cache-hash"]);
    expect(cache.sets).toHaveLength(2);
    expect(cache.sets[0]).toMatch(new RegExp(`^llm:exact:v2:${tenantA.tenant}:mock:[0-9a-f]{64}$`));
    expect(cache.sets[1]).toMatch(new RegExp(`^llm:exact:v2:${tenantB.tenant}:mock:[0-9a-f]{64}$`));
  });

  it("tenant identity comes from the gateway key, never from x-tenant-id", async () => {
    const provider = new ScriptedProvider("mock");
    const cache = spyCache();
    const { app } = makeApp({ auth: lanes.auth, provider, cache });

    // Spoof header claims tenant B while the verified key belongs to tenant A.
    const res = await chat(app, tenantA.key, ask("spoof probe"), { "x-tenant-id": tenantB.tenant });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0]).toMatch(new RegExp(`^llm:exact:v2:${tenantA.tenant}:mock:[0-9a-f]{64}$`));
    expect(cache.gets.some((k) => k.includes(tenantB.tenant))).toBe(false);
    await app.close();
  });

  it("global v1 entries are never reused by a v2 lookup (no pre-existing leak)", async () => {
    const provider = new ScriptedProvider("mock");
    const inner = new InMemoryCache();
    const { app } = makeApp({ auth: lanes.auth, provider, cache: inner });

    const req = { model: "m", messages: [{ role: "user" as const, content: "legacy probe" }], temperature: 1, stream: false };
    const hash = buildExactCacheKey("mock", req, tenantA.tenant).hash;
    await inner.set(`llm:exact:v1:mock:${hash}`, JSON.stringify({ content: "global legacy answer", model: "m" }), 60);

    const res = await chat(app, tenantA.key, ask("legacy probe"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).not.toBe("global legacy answer");
    expect(provider.calls).toBe(1);
    await app.close();
  });

  it("a fallback-served answer is cached under the serving provider AND the requesting tenant", async () => {
    const primary = new ScriptedProvider("mock", {
      chat: async () => {
        throw new GatewayError(502, "provider_error", "primary down", false);
      },
    });
    const alt = new ScriptedProvider("alt");
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const cache = spyCache();
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers, cache });

    const a1 = await chat(app, tenantA.key, ask("fallback tenant"));
    expect(a1.statusCode).toBe(200);
    expect(a1.headers["x-provider"]).toBe("alt");
    expect(a1.headers["x-fallback"]).toBe("true");
    expect(a1.headers["x-cache"]).toBe("MISS");
    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0]).toMatch(new RegExp(`^llm:exact:v2:${tenantA.tenant}:alt:[0-9a-f]{64}$`));

    // Tenant B must not inherit tenant A's fallback entry.
    const b1 = await chat(app, tenantB.key, ask("fallback tenant"));
    expect(b1.statusCode).toBe(200);
    expect(b1.headers["x-cache"]).toBe("MISS");
    expect(b1.headers["x-provider"]).toBe("alt");
    expect(b1.headers["x-fallback"]).toBe("true");

    // Tenant A's replay is a HIT under the serving provider, still marked fallback.
    const a2 = await chat(app, tenantA.key, ask("fallback tenant"));
    expect(a2.headers["x-cache"]).toBe("HIT");
    expect(a2.headers["x-provider"]).toBe("alt");
    expect(a2.headers["x-fallback"]).toBe("true");
    expect(alt.calls).toBe(2);

    // Every exact lookup (including non-primary fallback targets) is tenant-scoped.
    expect(cache.gets.every((k) => k.startsWith("llm:exact:v2:"))).toBe(true);
    expect(cache.gets.some((k) => k.includes(`:${tenantB.tenant}:`))).toBe(true);
    await app.close();
  });
});
