import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { buildExactCacheKey } from "../../src/domain/normalize.js";

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const threadText = () => document.querySelector("#thread")!.textContent || "";
const assistantRows = () => Array.from(document.querySelectorAll("#thread .msg.assistant"));
const userRows = () => Array.from(document.querySelectorAll("#thread .msg.user"));
const num = (id: string) => parseInt((document.querySelector(id) as HTMLElement).textContent || "0", 10);
const openCard = (row: Element) => {
  const line = row.querySelector(".metrics") as HTMLElement;
  line.click();
  return row.querySelector(".metrics-card") as HTMLElement;
};

let mode = "ok";
let releaseHang: (() => void) | null = null;
let lastBody: any = null;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// The gateway hashes the canonical request on every validated call (D3), so the
// mock has to do the same with the REAL gateway implementation — that is what
// makes the browser/gateway parity assertion below meaningful.
function hashHeaders(body: any): Record<string, string> {
  if (mode === "badhash") return { "x-cache-hash": "f".repeat(64) };
  try {
    const { hash } = buildExactCacheKey("gemini", {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature ?? 1.0,
      max_tokens: body.max_tokens,
      stream: body.stream ?? false,
    } as any);
    return { "x-cache-hash": hash };
  } catch {
    return {};
  }
}

function sseResponse(chunks: string[], opts: { usage?: boolean; delayMs?: number } = {}) {
  const enc = new TextEncoder();
  const delay = opts.delayMs ?? 0;
  const frames = chunks.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  if (opts.usage) {
    // D1 terminal usage frame, exactly what chat.ts forwards from the provider.
    frames.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 7 } })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  const stream = new ReadableStream({
    start(c) {
      if (!delay) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
        return;
      }
      let i = 0;
      const tick = () => {
        if (i >= frames.length) {
          c.close();
          return;
        }
        c.enqueue(enc.encode(frames[i++]));
        setTimeout(tick, delay);
      };
      tick();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "x-provider": "gemini",
      "x-cache": "BYPASS",
      "x-request-id": "req-stream-1",
      "x-latency-ms": "40",
      ...(lastBody ? hashHeaders(lastBody) : {}),
    },
  });
}

const okBody = {
  id: "gen-1",
  model: "gemini-3.6-flash",
  choices: [{ message: { role: "assistant", content: "Gateway says hello." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 19, completion_tokens: 52 },
};

async function mockFetch(input: any, init?: any) {
  const url = String(input.url || input);
  if (url.endsWith("/health")) return jsonResponse({ ok: true, provider: "gemini", cache: "redis" });
  if (url.endsWith("/v1/chat/completions")) {
    if (mode === "hang") {
      return new Promise((_resolve, reject) => {
        releaseHang = () => reject(new DOMException("aborted", "AbortError"));
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    const body = JSON.parse(String(init?.body || "{}"));
    lastBody = body;
    const hash = hashHeaders(body);
    if (mode === "error") {
      return jsonResponse({ error: { code: "provider_rate_limited", message: "gemini rate limited." } }, 429, { "x-request-id": "req-429", ...hash });
    }
    if (mode === "empty") {
      return jsonResponse(
        { ...okBody, choices: [{ message: { role: "assistant", content: "   " }, finish_reason: "stop" }] },
        200,
        { "x-provider": "gemini", "x-cache": "MISS", "x-request-id": "req-empty", ...hash },
      );
    }
    if (body.stream) {
      if (mode === "stream-usage") return sseResponse(["Hel", "lo."], { usage: true });
      if (mode === "slowstream") return sseResponse(["One ", "two ", "three."], { usage: true, delayMs: 120 });
      return sseResponse(["Hel", "lo."]);
    }
    if (mode === "hit") return jsonResponse(okBody, 200, { "x-provider": "gemini", "x-cache": "HIT", "x-request-id": "req-hit", "x-latency-ms": "5", ...hash });
    return jsonResponse(okBody, 200, { "x-provider": "gemini", "x-cache": "MISS", "x-request-id": "req-1", "x-latency-ms": "120", ...hash });
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
  await flush();
});

beforeEach(async () => {
  mode = "ok";
  window.localStorage.clear();
  for (;;) {
    const items = document.querySelectorAll(".chat-item");
    if (items.length <= 1 && userRows().length === 0) break;
    (items[0].querySelector(".chat-del") as HTMLButtonElement).click();
  }
  const toggle = document.querySelector("#streamToggle") as HTMLButtonElement;
  if (toggle.getAttribute("aria-checked") !== "true") toggle.click();
  const sel = document.querySelector("#modelSel") as HTMLSelectElement;
  if (sel.value !== "gemini-3.6-flash") {
    sel.value = "gemini-3.6-flash";
    sel.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
  }
  (document.querySelector("#newChatBtn") as HTMLButtonElement).click();
  await flush(10);
});

describe("chat boot", () => {
  it("shows greeting, online status, gemini-only models", () => {
    expect(threadText()).toContain("Connected through your gateway");
    expect(document.querySelector("#statusText")!.textContent).toContain("Online");
    const models = Array.from(document.querySelectorAll("#modelSel option")).map((o) => (o as HTMLOptionElement).value);
    expect(models).toEqual(["gemini-3.6-flash", "gemini-3.5-flash-lite"]);
    expect(document.querySelector(".provider-pill")!.textContent).toContain("Gemini");
  });
});

function setStream(on: boolean) {
  const toggle = document.querySelector("#streamToggle") as HTMLButtonElement;
  if ((toggle.getAttribute("aria-checked") === "true") !== on) toggle.click();
}

describe("composer controls", () => {
  it("send button posts user bubble plus assistant reply with metrics", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "Hi there";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].textContent).toContain("Hi there");
    const rows = assistantRows();
    expect(rows).toHaveLength(1);
    const last = rows[rows.length - 1];
    expect(last.textContent).toContain("Gateway says hello.");
    const metrics = last.querySelector(".metrics")!.textContent || "";
    expect(metrics).toContain("19 in");
    expect(metrics).toContain("52 out");
    expect(metrics).toContain("cache MISS");
    expect(metrics).toMatch(/\d+\.\ds/);
    setStream(true);
  });

  it("empty input sends nothing", async () => {
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "   ";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(50);
    expect(userRows()).toHaveLength(0);
  });

  it("Enter sends, Shift+Enter does not", async () => {
    const ta = document.querySelector("#composerInput") as HTMLTextAreaElement;
    ta.value = "first";
    ta.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush(150);
    expect(userRows()).toHaveLength(1);
    ta.value = "second";
    ta.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    await flush(50);
    expect(userRows()).toHaveLength(1);
  });

  it("Cmd+Enter sends", async () => {
    const ta = document.querySelector("#composerInput") as HTMLTextAreaElement;
    ta.value = "cmd send";
    ta.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await flush(150);
    expect(userRows()).toHaveLength(1);
  });

  it("model select changes the model sent", async () => {
    setStream(false);
    const sel = document.querySelector("#modelSel") as HTMLSelectElement;
    sel.value = "gemini-3.5-flash-lite";
    sel.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "which model";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const last = assistantRows().pop()!;
    expect(last.textContent).toContain("Gateway says hello.");
    expect(lastBody.model).toBe("gemini-3.5-flash-lite");
    sel.value = "gemini-3.6-flash";
    sel.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
    setStream(true);
  });

  it("temperature slider updates its label", () => {
    const slider = document.querySelector("#tempInput") as HTMLInputElement;
    slider.value = "0.2";
    slider.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect(document.querySelector("#tempVal")!.textContent).toBe("0.2");
  });

  it("stream toggle flips state", () => {
    const toggle = document.querySelector("#streamToggle") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("streaming", () => {
  it("renders tokens progressively then metrics", async () => {
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "stream me";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(60);
    const before = threadText();
    await flush(200);
    const after = threadText();
    expect(after).toContain("Hello.");
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    const last = assistantRows().pop()!;
    expect(last.querySelector(".metrics")!.textContent).toContain("BYPASS");
  });

  it("send button becomes stop and abort ends the run", async () => {
    mode = "hang";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "slow one";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(30);
    expect(document.querySelector("#sendLabel")!.textContent).toBe("■");
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(100);
    expect(document.querySelector("#sendLabel")!.textContent).toBe("↑");
    expect(threadText()).toContain("Stopped.");
  });
});

describe("message tools", () => {
  it("copy button writes reply to clipboard", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "copy me";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const last = assistantRows().pop()!;
    (last.querySelector(".mini-btn") as HTMLButtonElement).click();
    await flush(20);
    const clipboard = (navigator as any).clipboard;
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Gateway says hello."));
    setStream(true);
  });

  it("new chat clears back to greeting", async () => {
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "temp chat";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(userRows()).toHaveLength(1);
    (document.querySelector("#newChatBtn") as HTMLButtonElement).click();
    await flush(10);
    expect(userRows()).toHaveLength(0);
    expect(threadText()).toContain("Connected through your gateway");
  });
});

describe("sidebar stack", () => {
  it("menu button collapses and expands the sidebar", () => {
    const btn = document.querySelector("#menuBtn") as HTMLButtonElement;
    const before = document.body.classList.contains("collapsed");
    btn.click();
    expect(document.body.classList.contains("collapsed")).toBe(!before);
    btn.click();
    expect(document.body.classList.contains("collapsed")).toBe(before);
  });

  it("sending titles the chat and lists it in the stack", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "a memorable topic";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const titles = Array.from(document.querySelectorAll("#chatStack .chat-item .title")).map((t) => t.textContent);
    expect(titles).toContain("a memorable topic");
    setStream(true);
  });

  it("switching chats restores each thread", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "first topic";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    (document.querySelector("#newChatBtn") as HTMLButtonElement).click();
    await flush(10);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "second topic";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(threadText()).toContain("second topic");
    const items = Array.from(document.querySelectorAll("#chatStack .chat-item")) as HTMLElement[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    items.find((i) => (i.textContent || "").includes("first topic"))!.click();
    await flush(10);
    expect(threadText()).toContain("first topic");
    expect(threadText()).not.toContain("second topic");
    setStream(true);
  });

  it("delete removes the chat", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "doomed chat";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const before = document.querySelectorAll("#chatStack .chat-item").length;
    const target = Array.from(document.querySelectorAll("#chatStack .chat-item")).find((i) => (i.textContent || "").includes("doomed chat"))!;
    (target.querySelector(".chat-del") as HTMLButtonElement).click();
    await flush(10);
    expect(document.querySelectorAll("#chatStack .chat-item").length).toBe(before - 1);
    expect(threadText()).not.toContain("doomed chat");
    setStream(true);
  });
});

describe("empty responses", () => {
  it("blank provider reply renders a notice instead of nothing", async () => {
    setStream(false);
    mode = "empty";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "say nothing";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const last = assistantRows().pop()!;
    expect(last.classList.contains("notice")).toBe(true);
    expect(last.textContent).toContain("empty response");
    expect(last.querySelector(".metrics")!.textContent).toContain("cache MISS");
    setStream(true);
  });
});

describe("session metrics", () => {
  const num = (id: string) => parseInt((document.querySelector(id) as HTMLElement).textContent || "0", 10);

  it("tracks a miss then a hit with rate and token totals", async () => {
    setStream(false);
    const before = num("#statRequests");
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "metric one";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(num("#statRequests")).toBe(before + 1);
    expect(num("#statMisses")).toBeGreaterThan(0);
    mode = "hit";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "metric one";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(num("#statRequests")).toBe(before + 2);
    expect(num("#statHits")).toBeGreaterThan(0);
    expect((document.querySelector("#statRate") as HTMLElement).textContent).toContain("%");
    expect((document.querySelector("#statsSummary") as HTMLElement).textContent).toContain("requests");
    expect(num("#statTokensIn")).toBeGreaterThan(0);
    expect(num("#statTokensOut")).toBeGreaterThan(0);
    setStream(true);
  });

  it("streamed replies count as bypassed, never hits or misses", async () => {
    const reqBefore = num("#statRequests");
    const byBefore = num("#statBypassed");
    const hitsBefore = num("#statHits");
    const missBefore = num("#statMisses");
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "stream metric";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(200);
    expect(num("#statRequests")).toBe(reqBefore + 1);
    expect(num("#statBypassed")).toBe(byBefore + 1);
    expect(num("#statHits")).toBe(hitsBefore);
    expect(num("#statMisses")).toBe(missBefore);
    expect((document.querySelector("#statsSummary") as HTMLElement).textContent).toContain("streamed");
  });

  it("new chat keeps session counters but clears the thread", async () => {
    const before = num("#statRequests");
    (document.querySelector("#newChatBtn") as HTMLButtonElement).click();
    await flush(10);
    expect(num("#statRequests")).toBe(before);
    expect(userRows()).toHaveLength(0);
  });
});

describe("errors", () => {
  it("provider 429 renders quota card with request id and retry", async () => {
    mode = "error";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "over quota";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const last = assistantRows().pop()!;
    expect(last.classList.contains("error")).toBe(true);
    expect(last.textContent).toContain("Quota exhausted · 429");
    expect(last.textContent).toContain("req-429");
    expect(Array.from(last.querySelectorAll(".mini-btn")).some((b) => b.textContent === "Retry")).toBe(true);
  });

  it("quota error offers retry that resends without duplicating the user bubble", async () => {
    setStream(false);
    mode = "error";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "retry me";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const first = assistantRows().pop()!;
    expect(first.textContent).toContain("Quota exhausted");
    const retry = Array.from(first.querySelectorAll(".mini-btn")).find((b) => b.textContent === "Retry") as HTMLButtonElement;
    expect(retry).toBeTruthy();
    mode = "ok";
    retry.click();
    await flush(150);
    expect(userRows()).toHaveLength(1);
    const last = assistantRows().pop()!;
    expect(last.textContent).toContain("Gateway says hello.");
    setStream(true);
  });
});

// ---------------------------------------------------------------------------
// D4: the metrics section. Every number here must be traceable to a gateway
// header, a provider usage frame, or a browser-side measurement — and the
// canonical/hash pair must prove byte-parity with src/domain/normalize.ts.
// ---------------------------------------------------------------------------

describe("metrics card (D4)", () => {
  it("clicking the metric line reveals the cache verdict, key, ids and tokens", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "metrics card";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const last = assistantRows().pop()!;
    const line = last.querySelector(".metrics") as HTMLElement;
    expect(line.getAttribute("role")).toBe("button");
    expect(line.textContent).toContain("cache MISS");
    expect(line.classList.contains("miss")).toBe(true);

    const card = last.querySelector(".metrics-card") as HTMLElement;
    expect(card.hidden).toBe(true);
    line.click();
    expect(card.hidden).toBe(false);

    const text = card.textContent || "";
    expect(text).toContain("MISS");
    expect(text).toContain("No entry for this key");
    expect(text).toContain("llm:exact:v1:gemini:");
    expect(text).toContain("req-1"); // x-request-id
    expect(text).toContain("gemini · gemini-3.6-flash"); // provider + model
    expect(text).toContain("19 in · 52 out"); // provider usage, exact
    expect(text).toContain("gateway 120 ms (whole request)"); // x-latency-ms
    expect(card.querySelector("pre.canonical")).toBeTruthy();
    expect(card.querySelector(".badge.miss")).toBeTruthy();
    setStream(true);
  });

  it("browser canonical + sha256 prove byte-parity with the gateway x-cache-hash", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "  parity probe  ";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const last = assistantRows().pop()!;
    const card = openCard(last);

    // 1. canonical form rebuilt in the browser == gateway canonical string
    const expected = buildExactCacheKey("gemini", {
      model: lastBody.model,
      messages: lastBody.messages,
      temperature: lastBody.temperature,
      max_tokens: lastBody.max_tokens,
      stream: lastBody.stream,
    } as any).canonical;
    expect(card.querySelector("pre.canonical")!.textContent).toBe(expected);
    // whitespace rule: gateway trims content, so the raw payload padding is gone
    expect(expected).toContain('"content":"parity probe"');

    // 2. browser sha256 of that string == x-cache-hash header
    await flush(60);
    const verify = card.querySelector(".verify") as HTMLElement;
    expect(verify.className).toContain("ok");
    expect(verify.textContent).toContain("matches x-cache-hash");
    setStream(true);
  });

  it("a wrong gateway hash is reported as a mismatch, never silently trusted", async () => {
    setStream(false);
    mode = "badhash";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "bad hash";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const card = openCard(assistantRows().pop()!);
    await flush(60);
    const verify = card.querySelector(".verify") as HTMLElement;
    expect(verify.className).toContain("bad");
    expect(verify.textContent).toContain("differs from gateway");
    setStream(true);
  });

  it("canonical preview drops stream and sorts keys (gateway normalize rules)", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "canonical rules";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    const card = openCard(assistantRows().pop()!);
    const pre = card.querySelector("pre.canonical")!.textContent || "";
    expect(pre).not.toContain("stream"); // stream is excluded from identity
    expect(pre.startsWith('{"max_tokens":')).toBe(true); // keys sorted: max_tokens < messages < model < temperature
    expect(pre.indexOf('"content"')).toBeLessThan(pre.indexOf('"role"'));
    setStream(true);
  });
});

describe("stream metrics", () => {
  it("usage frame -> BYPASS badge, TTFT, chunk count and REAL token numbers", async () => {
    mode = "stream-usage";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "stream usage";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(250);
    const last = assistantRows().pop()!;
    const line = last.querySelector(".metrics")!;
    expect(line.textContent).toContain("BYPASS");
    expect(line.textContent).toMatch(/ttft \d+\.\ds/);
    expect(line.textContent).toContain("2 chunks");
    expect(line.textContent).toContain("21 in · 7 out");
    expect(line.textContent).not.toContain("≈"); // provider-reported, not estimated
    expect(line.classList.contains("bypass")).toBe(true);

    const card = openCard(last);
    const text = card.textContent || "";
    expect(card.querySelector(".badge.bypass")).toBeTruthy();
    expect(text).toContain("stream:true bypasses the exact cache");
    expect(text).toContain("TTFT");
    expect(text).toContain("2 chunks · SSE");
    expect(text).toContain("gateway 40 ms (first token)"); // x-latency-ms = TTFT for SSE
    expect(text).not.toContain("estimated (~4 chars/token)");
    mode = "ok";
  });

  it("no usage frame -> clearly labeled ≈ estimate instead of invented facts", async () => {
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "estimate me";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(250);
    const last = assistantRows().pop()!;
    expect(last.querySelector(".metrics")!.textContent).toContain("≈");
    const card = openCard(last);
    expect(card.textContent).toContain("≈ estimated (~4 chars/token) — provider reported no usage");
  });

  it("live metrics line shows chunks + elapsed time while the stream runs", async () => {
    mode = "slowstream";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "slow stream";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(200); // stream takes ~600ms: 3 chunks x 120ms + [DONE]
    const live = document.querySelector("#thread .metrics.live");
    expect(live).toBeTruthy();
    expect(live!.textContent).toContain("streaming ·");
    expect(live!.textContent).toContain("chunks");
    await flush(700);
    expect(document.querySelector("#thread .metrics.live")).toBeNull();
    const last = assistantRows().pop()!;
    expect(last.textContent).toContain("One two three.");
    expect(last.querySelector(".metrics")!.textContent).toContain("3 chunks");
    mode = "ok";
  });
});

describe("session dashboard (extended)", () => {
  it("a HIT adds exactly the cached tokens to 'tokens reused'", async () => {
    setStream(false);
    const before = num("#statReused");
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "reuse me";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150); // MISS: provider called, nothing reused
    expect(num("#statReused")).toBe(before);
    mode = "hit";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "reuse me";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150); // HIT: 19 prompt + 72 completion from okBody
    expect(num("#statReused")).toBe(before + 19 + 52);
    expect(num("#statHits")).toBeGreaterThan(0);
    expect(num("#statSaved")).toBe(num("#statHits")); // provider calls saved == hits
    mode = "ok";
    setStream(true);
  });

  it("streams feed avg TTFT, chunk totals and mark the summary as ≈", async () => {
    const chunksBefore = num("#statChunks");
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "stream dashboard";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(300);
    expect(num("#statChunks")).toBe(chunksBefore + 2);
    expect((document.querySelector("#statTtft") as HTMLElement).textContent).toMatch(/^\d+ms$/);
    expect((document.querySelector("#statsSummary") as HTMLElement).textContent).toContain("≈");
    expect((document.querySelector("#statsSummary") as HTMLElement).textContent).toContain("streamed");
  });

  it("a failed request counts as an error, never as a bypassed stream", async () => {
    const errBefore = num("#statErrors");
    const byBefore = num("#statBypassed");
    mode = "error";
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "will fail";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(num("#statErrors")).toBe(errBefore + 1);
    expect(num("#statBypassed")).toBe(byBefore);
    expect((document.querySelector("#statsSummary") as HTMLElement).textContent).toContain("error");
    mode = "ok";
  });
});

describe("playground UX", () => {
  it("regenerate resends the last payload without a duplicate user bubble", async () => {
    setStream(false);
    (document.querySelector("#composerInput") as HTMLTextAreaElement).value = "regen topic";
    (document.querySelector("#sendBtn") as HTMLButtonElement).click();
    await flush(150);
    expect(userRows()).toHaveLength(1);
    const first = assistantRows().pop()!;
    const regen = Array.from(first.querySelectorAll(".mini-btn")).find((b) => b.textContent === "Regenerate") as HTMLButtonElement;
    expect(regen).toBeTruthy();
    expect(Array.from(first.querySelectorAll(".mini-btn"))[0].textContent).toBe("Copy"); // Copy stays first
    regen.click();
    await flush(200);
    expect(userRows()).toHaveLength(1); // no second bubble
    expect(assistantRows()).toHaveLength(2);
    expect(lastBody.messages[0].content).toBe("regen topic");
    setStream(true);
  });

  it("suggestion chips fill the composer on an empty thread", () => {
    const chips = Array.from(document.querySelectorAll("#thread .chip")) as HTMLButtonElement[];
    expect(chips).toHaveLength(3);
    chips[0].click();
    expect((document.querySelector("#composerInput") as HTMLTextAreaElement).value).toContain("exact cache");
  });

  it("composer shows a live prompt-token estimate", () => {
    const ta = document.querySelector("#composerInput") as HTMLTextAreaElement;
    ta.value = "abcdefgh"; // 8 chars -> ≈ 2 tokens at ~4 chars/token
    ta.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect((document.querySelector("#composerHint") as HTMLElement).textContent).toContain("≈ 2 tokens");
    ta.value = "";
    ta.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect((document.querySelector("#composerHint") as HTMLElement).textContent).toContain("0 tokens");
  });
});
