import { describe, expect, it, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { laneAuth } from "../helpers/lane.js";

// Long-context & high-cardinality E2E across every caching layer. Proves the
// caching stack stays exact under payloads and cardinality the small fixture
// tests never touch: multi-KB prompts, hundreds of entries, LRU caps evicting
// old answers, and paraphrase hits against a loaded vector store — with the
// provider-call and token accounting reconciled at every leg.
//
// T26 lanes: every request runs the registered lane (key bound to "mock").

const lane = await laneAuth("mock");
const laneHeaders = lane.headersFor("mock");

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: true, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "", savedUsdPer1kTokens: 0,
    ...over,
  };
}

/** Long deterministic user message — multi-KB, family-unique marker at the end. */
function longPrompt(i: number, kb = 6): string {
  const chunk = `scenario ${i}: the control plane canonicalizes, hashes, and caches this body; `;
  const parts: string[] = [];
  let len = 0;
  while (len < kb * 1024) {
    parts.push(chunk);
    len += chunk.length;
  }
  return parts.join("") + `junk${i} index=${i}`;
}

function unit(i: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

/** Deterministic family embedder: gateway→unit(0), recipe→unit(1), junk N→unit(2+N). */
class FamilyEmbedder implements EmbeddingProvider {
  readonly name = "test-family";
  readonly dimension = EMBEDDING_DIM;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    if (text.toLowerCase().includes("gateway")) return unit(0);
    if (text.toLowerCase().includes("recipe")) return unit(1);
    const j = Number(/junk(\d+)/.exec(text)?.[1] ?? 0);
    return unit(2 + j);
  }
}

function countingProvider() {
  let calls = 0;
  const provider = new MockProvider();
  const orig = provider.chat.bind(provider);
  provider.chat = (async (...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
  return { provider, callsRef: () => calls };
}

beforeEach(() => metrics.reset());

describe("long-context & high-cardinality cache E2E (exact + semantic + policy)", () => {
  it("long content (6KB × 40) seeds once then replays — all HITs, provider runs once per prompt, accounting reconciled", async () => {
    const app = Fastify();
    const { provider, callsRef } = countingProvider();
    registerChatRoutes(app, provider, cfg(), new InMemoryCache(), {
      auth: lane.auth,
      semanticStore: new InMemoryVectorStore(),
      embedder: new FamilyEmbedder(),
    });

    // Seed 40 six-KB prompts: 40 misses, 40 provider calls. ~240KB of request
    // bodies through canonicalization, hashing and both cache layers.
    const seed = performance.now();
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
        payload: { model: "m", messages: [{ role: "user", content: longPrompt(i) }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-cache"]).toBe("MISS");
    }
    const seedMs = performance.now() - seed;

    // Replay all 40: exact hits, same bytes back.
    const replay = performance.now();
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
        payload: { model: "m", messages: [{ role: "user", content: longPrompt(i) }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-cache"]).toBe("HIT");
    }
    const replayMs = performance.now() - replay;

    // Policy-adjacent legs at scale:
    //  (a) same semantic family (unique junk marker kept) with a tail edit — the
    //      exact layer misses but the semantic layer reuses the seeded row;
    //  (b) genuinely new content (new family) — full MISS;
    //  (c) outer whitespace padding — canonicalization trims it → exact HIT.
    const tailEdit = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: `${longPrompt(3)} please elaborate` }] },
    });
    expect(tailEdit.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(Number(tailEdit.headers["x-semantic-similarity"])).toBeGreaterThanOrEqual(0.92);

    const fresh = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: longPrompt(40) }] },
    });
    expect(fresh.headers["x-cache"]).toBe("MISS");

    const padded = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: `   ${longPrompt(7)}  ` }] },
    });
    expect(padded.headers["x-cache"]).toBe("HIT");

    // Provider discipline: seeds + the one genuinely-new prompt only.
    expect(callsRef()).toBe(41);
    const snap = await app.inject({ method: "GET", url: "/metrics" });
    const m = snap.json();
    expect(m.requests_total).toBe(83);
    // Along tailEdit + fresh + padded: 40 seeds, tailEdit exact-misses into the
    // semantic layer, fresh is a brand-new canonical body → 42 exact misses.
    expect(m.exact_misses).toBe(42);
    expect(m.exact_hits).toBe(41);
    expect(m.semantic_hits).toBe(1);
    // Semantic lookups: the 40 seeds + fresh. tailEdit hit semantically;
    // padded exact-hits (and never reaches semantics); replays don't either.
    expect(m.semantic_misses).toBe(41);
    expect(m.provider_requests).toBe(41);
    expect(m.provider_calls_avoided).toBe(41);
    expect(m.tokens_in).toBe(83 * 10);
    expect(m.tokens_out).toBe(83 * 5);
    await app.close();

    // Perf envelope: seeding 240KB/40 reqs and replaying 240KB/40 reqs must
    // stay far away from timeout territory (mock provider, in-process).
    expect(seedMs / 40).toBeLessThan(300);
    expect(replayMs / 40).toBeLessThan(30);
  });

  it("exact LRU cap with long content (cap 20): overflow evicts oldest, newest survivors HIT", async () => {
    const app = Fastify();
    const cache = new InMemoryCache({ maxEntries: 20 });
    const { provider, callsRef } = countingProvider();
    registerChatRoutes(app, provider, cfg(), cache, {
      auth: lane.auth,
      semanticStore: new InMemoryVectorStore(),
      embedder: new FamilyEmbedder(),
    });

    // 20 seed fills the cap; 5 more evict the five oldest entries.
    const seed: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
        payload: { model: "m", messages: [{ role: "user", content: longPrompt(i, 4) }] },
      });
      seed.push(String(res.headers["x-cache"]));
    }
    expect(seed).toEqual(Array<unknown>(25).fill("MISS"));
    expect(callsRef()).toBe(25);

    // The five newest (20..24) are still exact-cached.
    const survivors: string[] = [];
    for (let i = 20; i < 25; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
        payload: { model: "m", messages: [{ role: "user", content: longPrompt(i, 4) }] },
      });
      survivors.push(String(res.headers["x-cache"]));
    }
    // The five evicted from L1 are NOT lost: the semantic layer (separate cap,
    // 2000 rows) still holds every seeded row with sim 1.0, so the exact LRU
    // miss falls through to a SEMANTIC_HIT — no provider call either way.
    const evicted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
        payload: { model: "m", messages: [{ role: "user", content: longPrompt(i, 4) }] },
      });
      evicted.push(String(res.headers["x-cache"]));
    }
    expect(survivors).toEqual(Array<unknown>(5).fill("HIT"));
    expect(evicted).toEqual(Array<unknown>(5).fill("SEMANTIC_HIT"));
    expect(callsRef()).toBe(25);

    const snap = await app.inject({ method: "GET", url: "/metrics" });
    const m = snap.json();
    expect(m.requests_total).toBe(35);
    expect(m.exact_hits).toBe(5);
    // Every evicted leg exact-misses first, then falls into the semantic hit.
    expect(m.exact_misses).toBe(30);
    expect(m.semantic_hits).toBe(5);
    expect(m.provider_requests).toBe(25);
    expect(m.tokens_in).toBe(35 * 10);
    await app.close();
  });

  it("semantic rows at cap (30): junk flood evicts the oldest family, survivors still hit semantically", async () => {
    const app = Fastify();
    const { provider, callsRef } = countingProvider();
    registerChatRoutes(app, provider, cfg(), new InMemoryCache(), {
      auth: lane.auth,
      semanticStore: new InMemoryVectorStore({ maxEntries: 30 }),
      embedder: new FamilyEmbedder(),
    });

    // Oldest row: gateway family. High-cardinality junk (35 > cap 30) then
    // floods the store; the gateway row is the oldest and gets evicted.
    await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] },
    });
    const flood: string[] = [];
    for (let j = 0; j < 35; j++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
        payload: { model: "m", messages: [{ role: "user", content: `junk${j}: checklist item ${j} for the registry` }] },
      });
      flood.push(String(res.headers["x-cache"]));
    }
    expect(flood).toEqual(Array<unknown>(35).fill("MISS"));
    expect(callsRef()).toBe(36);

    // Paraphrase #1 after eviction: the family row IS gone from the semantic
    // store → exact-miss into a clean semantic-miss → provider call. The miss
    // itself re-saves the row.
    const afterEvict = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] },
    });
    expect(afterEvict.headers["x-cache"]).toBe("MISS");
    expect(callsRef()).toBe(37);

    // Paraphrase #2: served from the freshly saved row without the provider.
    const recycle = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: "What exactly does an LLM gateway do?" }] },
    });
    expect(recycle.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(Number(recycle.headers["x-semantic-similarity"])).toBeGreaterThanOrEqual(0.92);
    expect(recycle.json().choices[0].message.content).toBe(afterEvict.json().choices[0].message.content);
    expect(callsRef()).toBe(37);

    const snap = await app.inject({ method: "GET", url: "/metrics" });
    const m = snap.json();
    // Exact layer saw 38 misses; the only reuse was semantic (recorded as its
    // own counter — provider_calls_avoided counts exact + coalesced only).
    expect(m.requests_total).toBe(38);
    expect(m.exact_hits).toBe(0);
    expect(m.exact_misses).toBe(38);
    expect(m.semantic_hits).toBe(1);
    expect(m.semantic_misses).toBe(37);
    expect(m.provider_requests).toBe(37);
    expect(m.provider_calls_avoided).toBe(0);
    await app.close();
  });

  it("huge single payload (64KB): MISS → HIT byte-identical, canonical hash stable", async () => {
    const app = Fastify();
    const { provider, callsRef } = countingProvider();
    registerChatRoutes(app, provider, cfg(), new InMemoryCache(), {
      auth: lane.auth,
      semanticStore: new InMemoryVectorStore(),
      embedder: new FamilyEmbedder(),
    });
    const huge = longPrompt(9, 64);
    expect(huge.length).toBeGreaterThan(64 * 1024);

    const first = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: huge }] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    const hashFirst = first.headers["x-cache-hash"];

    const again = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: laneHeaders,
      payload: { model: "m", messages: [{ role: "user", content: huge }] },
    });
    expect(again.headers["x-cache"]).toBe("HIT");
    expect(again.headers["x-cache-hash"]).toBe(hashFirst);
    expect(again.json().choices[0].message.content).toBe(first.json().choices[0].message.content);
    expect(callsRef()).toBe(1);
    await app.close();
  });
});
