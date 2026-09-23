// tests/integration/ui-live.test.ts — run the actual playground UI against a
// real gateway. tests/unit/chat-ui.test.ts mocks fetch entirely; this file
// boots the server on a real socket and drives the real public/ JS with Node's
// real fetch, so routing, validation, exact-cache, SSE framing, x-cache-hash
// and the terminal usage frame are all exercised end-to-end (loop.md §7:
// "manual curl if HTTP" — automated, and through the UI layer itself).
//
// Provider = mock (arch §5: sanctioned zero-setup provider, no Gemini quota),
// cache = in-memory (works with or without a local Redis).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const threadText = () => document.querySelector("#thread")!.textContent || "";
const assistantRows = () => Array.from(document.querySelectorAll("#thread .msg.assistant")) as HTMLElement[];
const userRows = () => Array.from(document.querySelectorAll("#thread .msg.user"));
const num = (id: string) => parseInt((document.querySelector(id) as HTMLElement).textContent || "0", 10);
const lastAssistant = () => assistantRows()[assistantRows().length - 1];

let app: FastifyInstance;
let address = "";
const realFetch = globalThis.fetch.bind(globalThis);

function setStream(on: boolean) {
  const toggle = document.querySelector("#streamToggle") as HTMLButtonElement;
  if ((toggle.getAttribute("aria-checked") === "true") !== on) toggle.click();
}

/** Type into the real composer, click send, wait until the reply row settles. */
async function typeAndSend(text: string): Promise<HTMLElement> {
  const before = userRows().length;
  (document.querySelector("#composerInput") as HTMLTextAreaElement).value = text;
  (document.querySelector("#sendBtn") as HTMLButtonElement).click();
  for (let i = 0; i < 80; i++) {
    await flush(50);
    const rows = assistantRows();
    const last = rows[rows.length - 1];
    const sent = userRows().length > before;
    // settled = user bubble exists and the final row has its metric line
    if (sent && last && last.querySelector(".metrics") && !last.querySelector(".content.streaming")) return last;
  }
  throw new Error(`no reply for: ${threadText().slice(0, 120)}`);
}

function openCard(row: HTMLElement): HTMLElement {
  const line = row.querySelector(".metrics") as HTMLElement;
  line.click();
  return row.querySelector(".metrics-card") as HTMLElement;
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

beforeAll(async () => {
  // Overrides must happen before buildServer() reads config. server.js (and
  // its dotenv import) already ran, so these assignments win over .env.
  process.env.PROVIDER = "mock";
  process.env.REDIS_URL = "";
  const built = buildServer();
  app = built.app;
  address = await app.listen({ port: 0, host: "127.0.0.1" });

  const html = readFileSync("public/index.html", "utf8");
  const dom = new JSDOM(html, { url: address + "/" });
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
  // The UI issues relative URLs ("/v1/chat/completions") — a browser resolves
  // them against its origin, so do the same against the live socket. Everything
  // else (headers, SSE, abort signals) is the real thing.
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const raw = String((input as { url?: string })?.url ?? input);
    return realFetch(/^https?:/.test(raw) ? raw : address + raw, init);
  });
  await import("../../public/js/app.js");
  await flush(300);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

beforeEach(() => {
  // Fresh conversation per test; unique prompts keep exact-cache state unambiguous.
  (document.querySelector("#newChatBtn") as HTMLButtonElement).click();
  setStream(true);
  (document.querySelector("#modelSel") as HTMLSelectElement).value = "gemini-3.6-flash";
});

describe("live UI against a real gateway", () => {
  it("boots: online status from real /health and playground assets served", async () => {
    expect(threadText()).toContain("Connected through your gateway");
    expect((document.querySelector("#statusText") as HTMLElement).textContent).toContain("Online");
    expect((document.querySelector("#statusText") as HTMLElement).textContent).toContain("mock");

    const root = await realFetch(address + "/");
    expect(root.status).toBe(200);
    const page = await root.text();
    expect(page).toContain('id="composerHint"'); // new session/composer chrome
    expect(page).toContain('id="statReused"'); // extended session dashboard

    const css = await realFetch(address + "/styles.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toContain(".metrics-card");

    const js = await realFetch(address + "/js/app.js");
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("buildMetricsCard");
  });

  it("non-stream: MISS -> HIT, and the browser sha256 matches the REAL gateway hash", async () => {
    setStream(false);
    const hitsBefore = num("#statHits");
    const missesBefore = num("#statMisses");
    const reusedBefore = num("#statReused");
    const prompt = "ui-live parity " + nonce();

    // --- first call: MISS, provider called ---
    const first = await typeAndSend(prompt);
    expect(first.querySelector(".content")!.textContent).toContain("mock echo (");
    const line1 = first.querySelector(".metrics")!.textContent || "";
    expect(line1).toContain("cache MISS");
    expect(line1).toContain("10 in"); // provider usage, exact
    expect(line1).toContain("5 out");
    expect(line1).not.toContain("≈");
    expect(num("#statHits")).toBe(hitsBefore);
    expect(num("#statMisses")).toBe(missesBefore + 1);

    const card = openCard(first);
    expect(card.hidden).toBe(false);
    const text = card.textContent || "";
    expect(text).toContain("MISS");
    expect(text).toContain("No entry for this key");
    expect(text).toContain("llm:exact:v1:mock:"); // real key, real provider name
    expect(text).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/); // real request id
    expect(text).toContain("mock · gemini-3.6-flash");
    // flagship: browser-rebuilt canonical hashed with crypto.subtle equals the
    // gateway's x-cache-hash computed in src/domain/normalize.ts
    await flush(120);
    const verify = card.querySelector(".verify") as HTMLElement;
    expect(verify.className).toContain("ok");
    expect(verify.textContent).toContain("matches x-cache-hash");

    // --- identical call: HIT from the real cache, provider NOT called ---
    const second = await typeAndSend(prompt);
    const line2 = second.querySelector(".metrics")!.textContent || "";
    expect(line2).toContain("cache HIT");
    expect(second.querySelector(".metrics")!.classList.contains("hit")).toBe(true);
    expect(second.querySelector(".content")!.textContent).toBe(first.querySelector(".content")!.textContent);
    expect(num("#statHits")).toBe(hitsBefore + 1);
    expect(num("#statReused")).toBe(reusedBefore + 10 + 5); // cached tokens counted as reused
    expect(num("#statSaved")).toBe(num("#statHits"));
    const card2 = openCard(second);
    expect(card2.querySelector(".badge.hit")).toBeTruthy();
    expect(card2.textContent).toContain("provider was NOT called");
    expect((document.querySelector("#statRate") as HTMLElement).textContent).toMatch(/%$/);
  });

  it("stream: BYPASS with TTFT, chunk count and real usage from the terminal frame", async () => {
    const bypassedBefore = num("#statBypassed");
    const chunksBefore = num("#statChunks");

    const row = await typeAndSend("ui-live stream " + nonce());
    const line = row.querySelector(".metrics")!.textContent || "";
    expect(line).toContain("cache BYPASS");
    expect(line).toContain("3 chunks"); // mock provider yields 3 deltas
    expect(line).toMatch(/ttft \d+\.\ds/);
    expect(line).toContain("10 in · 5 out"); // real usage frame, so no ≈
    expect(line).not.toContain("≈");

    const card = openCard(row);
    const text = card.textContent || "";
    expect(card.querySelector(".badge.bypass")).toBeTruthy();
    expect(text).toContain("stream:true bypasses the exact cache");
    expect(text).toContain("llm:exact:v1:mock:"); // the would-be key
    expect(text).toContain("TTFT");
    expect(text).toMatch(/\(first token\)/); // x-latency-ms header read as TTFT
    expect(text).toContain("3 chunks · SSE");
    expect(text).not.toContain("estimated (~4 chars/token)");

    expect(num("#statBypassed")).toBe(bypassedBefore + 1);
    expect(num("#statChunks")).toBe(chunksBefore + 3);
    expect((document.querySelector("#statTtft") as HTMLElement).textContent).toMatch(/^\d+ms$/);
    expect((document.querySelector("#statsSummary") as HTMLElement).textContent).toContain("streamed");
  });

  it("history survives a reload of the thread (persist + re-render with metrics)", async () => {
    setStream(false);
    const prompt = "ui-live persist " + nonce();
    const row = await typeAndSend(prompt);
    const beforeText = row.querySelector(".content")!.textContent;
    // switch away and back: thread is rebuilt from localStorage, metrics card included
    (document.querySelector("#newChatBtn") as HTMLButtonElement).click();
    expect(threadText()).toContain("Connected through your gateway");
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "second chat";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(400);
    const items = Array.from(document.querySelectorAll("#chatStack .chat-item")) as HTMLElement[];
    items.find((i) => (i.textContent || "").includes(prompt))!.click();
    await flush(50);
    const restored = lastAssistant();
    expect(restored.querySelector(".content")!.textContent).toBe(beforeText);
    const card = openCard(restored); // stored meta must rebuild a full card
    expect(card.querySelector("pre.canonical")).toBeTruthy();
    expect(card.textContent).toContain("llm:exact:v1:mock:");
  });
});
