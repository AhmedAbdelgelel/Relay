
import { beforeEach, describe, expect, it } from "vitest";
import type { SemanticCacheStore, SemanticHit } from "../../src/cache/SemanticCacheStore.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { metrics } from "../../src/observability/metrics.js";
import { POLICY_VERSION, systemFingerprint } from "../../src/policy/reuse.js";
import { issueLane, laneAuth } from "../helpers/lane.js";
import { chat, KeywordEmbedder, LeakyVectorStore, makeApp, ScriptedProvider, unit } from "./harness.js";

const lanes = await laneAuth("mock");
const lane = lanes.laneFor("mock");
const other = await issueLane(lanes.auth, "mock", "tenant-other");

const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "m",
  messages: [{ role: "user", content }],
  ...extra,
});

beforeEach(() => metrics.reset());

function spyStore(inner: SemanticCacheStore): { store: SemanticCacheStore; calls: { finds: number; saves: number } } {
  const calls = { finds: 0, saves: 0 };
  const store: SemanticCacheStore = {
    name: inner.name,
    findSimilar: (e, f, o) => {
      calls.finds++;
      return inner.findSimilar(e, f, o);
    },
    save: (entry) => {
      calls.saves++;
      return inner.save(entry);
    },
    recordHit: (id) => inner.recordHit(id),
    ping: () => inner.ping(),
    close: () => inner.close(),
  };
  return { store, calls };
}

describe("semantic reuse", () => {
  it("paraphrase hits the seeded answer without an upstream call; similarity is 4dp", async () => {
    const provider = new ScriptedProvider("mock");
    const embedder = new KeywordEmbedder();
    const { app } = makeApp({ auth: lanes.auth, provider, embedder });
    const seed = await chat(app, lane.key, ask("What is an LLM gateway?"));
    expect(seed.statusCode).toBe(200);
    expect(seed.headers["x-cache"]).toBe("MISS");

    const reworded = await chat(app, lane.key, ask("Explain what an LLM gateway does"));
    expect(reworded.statusCode).toBe(200);
    expect(reworded.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(reworded.headers["x-semantic-similarity"]).toBe("1.0000");
    expect(reworded.headers["x-cache-hash"]).toBeTruthy();
    expect(reworded.headers["x-provider"]).toBe("mock");
    expect(provider.calls).toBe(1);
    expect(reworded.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe(
      seed.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content,
    );
    const m = metrics.snapshot();
    expect(m.semantic_hits).toBe(1);
    expect(m.provider_requests).toBe(1);
            expect(m.provider_calls_avoided).toBe(0);
    await app.close();
  });

  it("unrelated content never false-hits", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder() });
    await chat(app, lane.key, ask("What is an LLM gateway?"));
    const unrelated = await chat(app, lane.key, ask("Give me a recipe for bread"));
    expect(unrelated.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    expect(metrics.snapshot().semantic_hits).toBe(0);
    await app.close();
  });

  it("threshold decides: cosine 0.8 misses at 0.92, hits at 0.75", async () => {
    const strictProvider = new ScriptedProvider("mock");
    const strict = makeApp({ auth: lanes.auth, provider: strictProvider, embedder: new KeywordEmbedder() });
    await chat(strict.app, lane.key, ask("gateway basics"));
    const below = await chat(strict.app, lane.key, ask("blend question"));
    expect(below.headers["x-cache"]).toBe("MISS");
    expect(strictProvider.calls).toBe(2);
    await strict.app.close();

    const looseProvider = new ScriptedProvider("mock");
    const loose = makeApp({ auth: lanes.auth, provider: looseProvider, embedder: new KeywordEmbedder(), env: { SEMANTIC_THRESHOLD: "0.75" } });
    await chat(loose.app, lane.key, ask("gateway basics"));
    const above = await chat(loose.app, lane.key, ask("blend question"));
    expect(above.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(above.headers["x-semantic-similarity"]).toBe("0.8000");
    expect(looseProvider.calls).toBe(1);
    await loose.app.close();
  });

  it("policy: requests with top_p skip semantic lookup AND admission; exact cache still covers them", async () => {
    const provider = new ScriptedProvider("mock");
    const embedder = new KeywordEmbedder();
    const { store, calls } = spyStore(new InMemoryVectorStore());
    const { app } = makeApp({ auth: lanes.auth, provider, embedder, semanticStore: store });

    // No embedding is computed, no vector lookup, no row admitted: the policy
    // cannot verify the stored row's top_p, so the semantic layer is skipped.
    const tuned = await chat(app, lane.key, ask("gateway sampling", { top_p: 0.5 }));
    expect(tuned.statusCode).toBe(200);
    expect(tuned.headers["x-cache"]).toBe("MISS");
    expect(calls.finds).toBe(0);
    expect(calls.saves).toBe(0);
    expect(embedder.calls).toBe(0);

    // Exact caching still works: top_p is part of the exact identity.
    expect((await chat(app, lane.key, ask("gateway sampling", { top_p: 0.5 }))).headers["x-cache"]).toBe("HIT");

    // The same prompt without top_p is a different exact request and now
    // DOES use the semantic layer (which is empty, so it MISSes and admits).
    const plain = await chat(app, lane.key, ask("gateway sampling"));
    expect(plain.headers["x-cache"]).toBe("MISS");
    expect(calls.finds).toBe(1);
    expect(calls.saves).toBe(1);
    expect(provider.calls).toBe(2);

    // A paraphrase that WOULD hit semantically is still skipped when it sets
    // top_p: the lookup counter stays put and no SEMANTIC_HIT is emitted.
    const paraphrase = await chat(app, lane.key, ask("gateway sampling reworded", { top_p: 0.5 }));
    expect(paraphrase.statusCode).toBe(200);
    expect(paraphrase.headers["x-cache"]).toBe("MISS");
    expect(paraphrase.headers["x-semantic-similarity"]).toBeUndefined();
    expect(calls.finds).toBe(1);
    expect(provider.calls).toBe(3);
    await app.close();
  });

  it("policy: requests with stop skip semantic reuse too (a seeded paraphrase is never served)", async () => {
    const provider = new ScriptedProvider("mock");
    const embedder = new KeywordEmbedder();
    const { store, calls } = spyStore(new InMemoryVectorStore());
    const { app } = makeApp({ auth: lanes.auth, provider, embedder, semanticStore: store });

    // Seed a reusable row with a plain request.
    const seed = await chat(app, lane.key, ask("gateway stop policy"));
    expect(seed.headers["x-cache"]).toBe("MISS");
    expect(calls.saves).toBe(1);
    const findsAfterSeed = calls.finds;

    // Same family, but `stop` is set: semantic lookup is skipped.
    const withStop = await chat(app, lane.key, ask("gateway stop policy reworded", { stop: "END" }));
    expect(withStop.statusCode).toBe(200);
    expect(withStop.headers["x-cache"]).toBe("MISS");
    expect(withStop.headers["x-semantic-similarity"]).toBeUndefined();
    expect(calls.finds).toBe(findsAfterSeed);
    expect(provider.calls).toBe(2);

    // Without stop the same paraphrase is a normal semantic hit.
    const plainParaphrase = await chat(app, lane.key, ask("gateway stop policy reworded"));
    expect(plainParaphrase.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(calls.finds).toBe(findsAfterSeed + 1);
    await app.close();
  });

  it("policy: temperature drift blocks reuse; the drifted request admits its own row", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder() });
    await chat(app, lane.key, ask("gateway temperature"));
    const drift = await chat(app, lane.key, ask("gateway temperature please", { temperature: 0.5 }));
    expect(drift.headers["x-cache"]).toBe("MISS");
    const replay = await chat(app, lane.key, ask("gateway temperature again", { temperature: 0.5 }));
    expect(replay.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("policy: a different system prompt blocks reuse even with identical user text", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder() });
    await chat(app, lane.key, ask("gateway instructions"));
    const drifted = await chat(app, lane.key, {
      model: "m",
      messages: [
        { role: "system", content: "Always answer in French" },
        { role: "user", content: "gateway instructions" },
      ],
    });
    expect(drifted.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("policy: another model is a filter miss (no cross-model reuse)", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder() });
    await chat(app, lane.key, ask("gateway models"));
    const otherModel = await chat(app, lane.key, { model: "m2", messages: [{ role: "user", content: "gateway models" }] });
    expect(otherModel.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("top-K scan: a non-reusable top candidate is skipped, the next reusable one serves", async () => {
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => ({ id: "row", model: req.model, content: `answer for: ${req.messages[req.messages.length - 1]!.content}`, usage: { prompt_tokens: 2, completion_tokens: 2 } }),
    });
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder() });
    await chat(app, lane.key, ask("gateway alpha", { temperature: 0.2 }));
    const second = await chat(app, lane.key, ask("gateway beta"));
    expect(second.headers["x-cache"]).toBe("MISS");

    const query = await chat(app, lane.key, ask("gateway gamma"));
    expect(query.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(query.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("answer for: gateway beta");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("tenant isolation: another tenant's paraphrase never reuses", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder() });
    await chat(app, lane.key, ask("gateway secrets"));
    const foreign = await chat(app, other.key, ask("gateway secrets revealed"));
    expect(foreign.headers["x-cache"]).toBe("MISS");
    const own = await chat(app, lane.key, ask("gateway secrets explained"));
    expect(own.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("policy re-checks tenant even when the store leaks rows across tenants", async () => {
    const provider = new ScriptedProvider("mock");
    const leaky = new LeakyVectorStore();
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: leaky });
    await chat(app, lane.key, ask("gateway leak probe"));
    const foreign = await chat(app, other.key, ask("gateway leak probe from elsewhere"));
    expect(foreign.headers["x-cache"]).toBe("MISS");
    const own = await chat(app, lane.key, ask("gateway leak probe reworded"));
    expect(own.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("semantic TTL: rows expire, then the paraphrase re-admits and serves again", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), env: { SEMANTIC_TTL_S: "1" } });
    await chat(app, lane.key, ask("gateway ttl seed"));
    expect((await chat(app, lane.key, ask("gateway ttl first reword"))).headers["x-cache"]).toBe("SEMANTIC_HIT");
    await new Promise((r) => setTimeout(r, 1300));
    expect((await chat(app, lane.key, ask("gateway ttl second reword"))).headers["x-cache"]).toBe("MISS");
    expect((await chat(app, lane.key, ask("gateway ttl third reword"))).headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });

  it("embedding reuse: one embed call per request, admission reuses the lookup vector", async () => {
    const provider = new ScriptedProvider("mock");
    const embedder = new KeywordEmbedder();
    const { app } = makeApp({ auth: lanes.auth, provider, embedder });
    await chat(app, lane.key, ask("gateway embed reuse"));
    expect(embedder.calls).toBe(1);
    await chat(app, lane.key, ask("gateway embed reuse reworded"));
    expect(embedder.calls).toBe(2);
    await app.close();
  });
});

describe("semantic degradation and toggles", () => {
  it("store lookup failure -> MISS with semantic_errors, request still 200", async () => {
    const provider = new ScriptedProvider("mock");
    const failing: SemanticCacheStore = {
      name: "failing-find",
      findSimilar: async () => {
        throw new Error("vector db down");
      },
      save: async () => undefined,
      recordHit: async () => undefined,
      ping: async () => false,
      close: async () => undefined,
    };
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: failing });
    const res = await chat(app, lane.key, ask("gateway down probe"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    expect(metrics.snapshot().semantic_errors).toBe(1);
    await app.close();
  });

  it("store save failure never breaks the response; the row just is not reusable", async () => {
    const provider = new ScriptedProvider("mock");
    const failing: SemanticCacheStore = {
      name: "failing-save",
      findSimilar: async () => [] as SemanticHit[],
      save: async () => {
        throw new Error("vector db read-only");
      },
      recordHit: async () => undefined,
      ping: async () => false,
      close: async () => undefined,
    };
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: failing });
    const first = await chat(app, lane.key, ask("gateway save probe"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    const reworded = await chat(app, lane.key, ask("gateway save probe reworded"));
    expect(reworded.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    expect(metrics.snapshot().semantic_errors).toBe(2);
    await app.close();
  });

  it("embedder failure degrades to MISS (lookup + admission both fail soft)", async () => {
    const provider = new ScriptedProvider("mock");
    const broken = {
      name: "broken-embedder",
      dimension: 768,
      embed: async (): Promise<number[]> => {
        throw new Error("onnx exploded");
      },
    };
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: broken });
    const res = await chat(app, lane.key, ask("gateway embed fail"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    expect(metrics.snapshot().semantic_errors).toBe(2);
    await app.close();
  });

  it("SEMANTIC_ENABLED=false: paraphrases MISS, store untouched, no similarity header", async () => {
    const provider = new ScriptedProvider("mock");
    const { store, calls } = spyStore(new InMemoryVectorStore());
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: store, env: { SEMANTIC_ENABLED: "false" } });
    await chat(app, lane.key, ask("gateway off seed"));
    const reworded = await chat(app, lane.key, ask("gateway off reworded"));
    expect(reworded.headers["x-cache"]).toBe("MISS");
    expect(reworded.headers["x-semantic-similarity"]).toBeUndefined();
    expect(calls.finds).toBe(0);
    expect(calls.saves).toBe(0);
    await app.close();
  });

  it("anonymous lanes never read or write the semantic store", async () => {
    const provider = new ScriptedProvider("mock");
    const { store, calls } = spyStore(new InMemoryVectorStore());
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: store });
    const res = await chat(app, null, ask("gateway anonymous"), { "x-provider-key": "sk-anon" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(calls.finds).toBe(0);
    expect(calls.saves).toBe(0);
    await app.close();
  });

  it("streaming never consults or writes the semantic layer", async () => {
    const provider = new ScriptedProvider("mock");
    const { store, calls } = spyStore(new InMemoryVectorStore());
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: store });
    const res = await chat(app, lane.key, ask("gateway streamed", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(calls.finds).toBe(0);
    expect(calls.saves).toBe(0);
    await app.close();
  });

  it("the layer toggles are independent: exact disabled still serves semantic hits", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), env: { CACHE_ENABLED: "false" } });
    const seed = await chat(app, lane.key, ask("gateway disabled exact"));
    expect(seed.headers["x-cache"]).toBe("DISABLED");
    const reworded = await chat(app, lane.key, ask("gateway disabled exact reworded"));
    expect(reworded.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(1);
    await app.close();
  });
});

describe("seeded-row policy guards (e2e)", () => {
  const seedFingerprint = systemFingerprint({ model: "m", messages: [{ role: "user", content: "seed" }], temperature: 1, stream: false });

  it("a row admitted under an older policy version is skipped; the request re-admits at the current version", async () => {
    const provider = new ScriptedProvider("mock");
    const store = new InMemoryVectorStore();
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: store });
    await store.save({
      tenant: lane.tenant,
      provider: "mock",
      model: "m",
      promptHash: "stale-policy-row",
      promptText: "user: seed",
      temperature: 1,
      embedding: unit(0),
      content: "stale answer",
      usage: { prompt_tokens: 9, completion_tokens: 9 },
      ttlSeconds: 3600,
      systemFingerprint: seedFingerprint,
      policyVersion: POLICY_VERSION - 1,
    });

    const first = await chat(app, lane.key, ask("gateway policy probe"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    expect(metrics.snapshot().semantic_misses).toBe(1);

    const second = await chat(app, lane.key, ask("gateway policy probe reworded"));
    expect(second.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(1);
    const m = metrics.snapshot();
    expect(m.semantic_hits).toBe(1);
    expect(m.provider_calls_avoided).toBe(0);
    await app.close();
  });

  it("a row whose system fingerprint no longer matches is skipped even at similarity 1.0", async () => {
    const provider = new ScriptedProvider("mock");
    const store = new InMemoryVectorStore();
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: store });
    await store.save({
      tenant: lane.tenant,
      provider: "mock",
      model: "m",
      promptHash: "wrong-fingerprint-row",
      promptText: "user: seed",
      temperature: 1,
      embedding: unit(0),
      content: "fingerprint answer",
      usage: { prompt_tokens: 3, completion_tokens: 4 },
      ttlSeconds: 3600,
      systemFingerprint: "f".repeat(64),
      policyVersion: POLICY_VERSION,
    });

    const first = await chat(app, lane.key, ask("gateway fingerprint probe"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);

    const second = await chat(app, lane.key, ask("gateway fingerprint probe reworded"));
    expect(second.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(provider.calls).toBe(1);
    await app.close();
  });

  it("a seeded row with blank content is never served", async () => {
    const provider = new ScriptedProvider("mock");
    const store = new InMemoryVectorStore();
    const { app } = makeApp({ auth: lanes.auth, provider, embedder: new KeywordEmbedder(), semanticStore: store });
    await store.save({
      tenant: lane.tenant,
      provider: "mock",
      model: "m",
      promptHash: "blank-content-row",
      promptText: "user: seed",
      temperature: 1,
      embedding: unit(0),
      content: "   ",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      ttlSeconds: 3600,
      systemFingerprint: seedFingerprint,
      policyVersion: POLICY_VERSION,
    });

    const res = await chat(app, lane.key, ask("gateway blank probe"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    expect(metrics.snapshot().semantic_misses).toBe(1);
    await app.close();
  });
});
