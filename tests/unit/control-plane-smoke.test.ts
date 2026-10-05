import { afterAll, describe, expect, it, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// The control plane only ships pages that map 1:1 to a real gateway surface:
//   /metrics               -> Overview, Cache
//   /v1/chat/completions   -> Playground
//   /providers             -> Providers
//   last live request      -> Requests
// This suite is the regression net for the whole bundle loading: a single bad
// import in public/js kills module evaluation, which is exactly the "nothing
// happens in the UI" failure this file was written to catch.

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const METRICS = {
  requests_total: 42,
  exact_hits: 12,
  exact_misses: 30,
  semantic_hits: 3,
  semantic_misses: 20,
  provider_requests: 33,
  provider_errors: 1,
  provider_calls_avoided: 14,
  avg_provider_ms: 412.5,
  avg_cache_lookup_ms: 0.8,
  avg_semantic_score: 0.9631,
  cache_lookup_failed: 0,
  cache_write_failed: 0,
  semantic_errors: 0,
  singleflight_coalesced: 2,
  singleflight_leaders: 31,
  semantic_lookups: 23,
  cache_lookups: 42,
  hit_rate: 0.2857,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function mockFetch(input: any) {
  const url = String(input.url || input);
  if (url.endsWith("/health")) {
    return jsonResponse({
      ok: true,
      provider: "gemini",
      cache: "redis",
      semantic: "memory-vector",
      embedder: "mock",
      config: {
        cacheEnabled: true,
        cacheTtlSec: 3600,
        semanticEnabled: true,
        semanticThreshold: 0.92,
        semanticTopK: 3,
        semanticTtlSec: 3600,
        upstreamTimeoutMs: 25000,
      },
    });
  }
  if (url.endsWith("/metrics")) return jsonResponse(METRICS);
  if (url.endsWith("/providers")) {
    return jsonResponse([
      { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", models: ["gpt-4o-mini"], configured: false, active: false },
      { id: "anthropic", label: "Anthropic", endpoint: "https://api.anthropic.com", models: ["claude-4"], configured: false, active: false },
      { id: "gemini", label: "Google", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-3.6-flash"], configured: true, active: true },
      { id: "ollama", label: "Ollama-local", endpoint: "http://localhost:11434/v1", models: ["llama3.1:8b"], configured: true, active: false },
      { id: "mock", label: "Mock", endpoint: "in-process", models: ["mock"], configured: true, active: false },
    ]);
  }
  throw new Error("unexpected fetch: " + url);
}

beforeAll(async () => {
  const html = readFileSync("public/index.html", "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3000/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(true) },
    configurable: true,
  });
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("fetch", mockFetch);
  await import("../../public/js/app.js");
  await flush(120);
});

const goto = async (hash: string) => {
  window.location.hash = hash;
  window.dispatchEvent(new window.Event("hashchange"));
  await flush(80);
};

// These suites replace process-wide globals (window/document/fetch) with a
// JSDOM instance. Without an explicit teardown, whichever file finishes first
// can leave its DOM installed for the next one, which showed up as flaky
// "element is null" failures depending on file execution order.
afterAll(() => {
  vi.unstubAllGlobals();
});
describe("control-plane bundle boots", () => {
  it("module evaluated and routed without a link error", () => {
    // If any import were missing this file would never run: the router is wired
    // on hashchange, so a live listener is the cheapest proof of life.
    expect(typeof (window as any).Event).toBe("function");
    expect(document.querySelector("#view")).toBeTruthy();
  });

  it("nav contains only backend-backed pages, in the send→inspect→cache→config flow", () => {
    const routes = Array.from(document.querySelectorAll("#sideNav a")).map((a) => a.getAttribute("data-route"));
    expect(routes).toEqual(["overview", "playground", "requests", "cache", "providers"]);
  });

  it("playground controls are populated on boot", async () => {
    await goto("#/playground");
    const models = document.querySelector("#modelSel") as HTMLSelectElement;
    expect(models.options.length).toBeGreaterThan(0);
    expect(models.value).toBeTruthy();
    expect(document.querySelector("#thread")!.textContent).toContain("Connected through your gateway");
    expect(document.querySelector("#traceFlow")).toBeTruthy();
  });
});

describe("each page renders its live content", () => {
  it("overview shows real /metrics numbers, not demo values", async () => {
    await goto("#/overview");
    const html = document.querySelector("#view")!.innerHTML;
    expect(html).toContain("LLM Gateway");
    expect(html).toContain("42"); // requests_total
    expect(html).toContain("Exact Hit Rate");
    expect(html).toContain("Semantic Hit Rate");
    expect(html).toContain("Cache lookup pipeline");
    // the deleted fiction must not reappear
    expect(html).not.toContain("Provider Distribution");
    expect(html).not.toContain("Recent Runs");
    expect(html).not.toContain("128,431");
  });

  it("providers shows live configured flags from GET /providers", async () => {
    await goto("#/providers");
    await flush(150);
    const html = document.querySelector("#view")!.innerHTML;
    expect(html).toContain("Providers");
    expect(html).toContain("Google");
    expect(html).toContain("Anthropic");
    expect(html).toContain("Not configured"); // openai/anthropic have no key
    expect(html).toContain("Connected"); // gemini does
    expect(html).not.toContain("48,210"); // removed fake request count
  });

  it("cache shows live hit rates and real server threshold", async () => {
    await goto("#/cache");
    await flush(150);
    const html = document.querySelector("#view")!.innerHTML;
    expect(html).toContain("Cache");
    expect(html).toContain("Exact Hit Rate");
    expect(html).toContain("Provider Calls Avoided");
    expect(html).toContain("SEMANTIC_HIT");
    expect(html).toContain("0.92"); // threshold from /health config, not hardcoded
    expect(html).not.toContain("84,012"); // removed demo miss count
  });

  it("requests inspector shows an honest empty state before any live request", async () => {
    await goto("#/requests");
    const html = document.querySelector("#view")!.innerHTML;
    expect(html).toContain("Request Inspector");
    expect(html).toContain("No live request yet");
    expect(html).toContain("Canonical Request");
    expect(html).toContain("Final Response");
  });
});

describe("removed sections redirect instead of blanking", () => {
  for (const hash of ["#/agents", "#/runs", "#/evals", "#/models", "#/logs", "#/settings", "#/nonsense"]) {
    it(hash + " falls back to the playground", async () => {
      await goto(hash);
      expect(document.querySelector("#thread")).toBeTruthy();
      expect(document.querySelector("#composerInput")).toBeTruthy();
    });
  }
});