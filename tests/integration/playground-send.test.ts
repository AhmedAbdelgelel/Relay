// tests/integration/playground-send.test.ts — regression test for the "dead
// playground" incident: the control-plane bundle (public/js/app.js) failed to
// link (a named import with no matching export), leaving the static fallback
// visible — empty #modelSel, topbar stuck at "connecting", Send doing nothing.
// This test boots the real server (PROVIDER=mock, no user keys touched),
// loads the real bundle in jsdom, navigates to #/playground, and sends a real
// streamed request through POST /v1/chat/completions. Any bundle-link failure
// fails this file at import time; any dead-send fails the assertions below.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const threadText = () => document.querySelector("#thread")!.textContent || "";
const assistantRows = () => Array.from(document.querySelectorAll("#thread .msg.assistant")) as HTMLElement[];
const userRows = () => Array.from(document.querySelectorAll("#thread .msg.user"));

let app: FastifyInstance;
let address = "";
const realFetch = globalThis.fetch.bind(globalThis);

async function typeAndSend(text: string): Promise<HTMLElement> {
  const before = userRows().length;
  (document.querySelector("#composerInput") as HTMLTextAreaElement).value = text;
  (document.querySelector("#sendBtn") as HTMLButtonElement).click();
  for (let i = 0; i < 100; i++) {
    await flush(50);
    const rows = assistantRows();
    const last = rows[rows.length - 1];
    const sent = userRows().length > before;
    if (sent && last && last.querySelector(".metrics") && !last.querySelector(".content.streaming")) return last;
  }
  throw new Error(`no reply for: ${threadText().slice(0, 120)}`);
}

beforeAll(async () => {
  // Mock provider only — never touches the user's Gemini key. Keys must be
  // cleared (not just PROVIDER=mock): model-prefix routing would otherwise
  // send gemini-*/gpt-*/claude-* straight to live providers and burn quota.
  process.env.PROVIDER = "mock";
  process.env.REDIS_URL = "";
  process.env.GEMINI_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
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
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const raw = String((input as { url?: string })?.url ?? input);
    return realFetch(/^https?:/.test(raw) ? raw : address + raw, init);
  });
  // Bundle-link failure (e.g. a named import with no matching export) throws
  // here and fails the whole file — that is the point.
  await import("../../public/js/app.js");
  await flush(300);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe("playground send regression (bundle loads + Send streams a reply)", () => {
  it("bundle boots: model select populated, gateway online", async () => {
    window.location.hash = "#/playground";
    window.dispatchEvent(new window.Event("hashchange"));
    await flush(120);
    // Empty #modelSel = bundle never ran (static fallback). This is the
    // dead-playground signature.
    const models = Array.from(document.querySelectorAll("#modelSel option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain("gemini-3.6-flash");
    expect(threadText()).toContain("Connected through your gateway");
    // Connection state lives on the workspace row (dot + tooltip), not a text line.
    expect(document.querySelector("#statusDot")!.classList.contains("on")).toBe(true);
    expect((document.querySelector("#wsUrl") as HTMLElement).title).toContain("mock");
  });

  it("Send Request streams a mock reply with metrics + x-provider", async () => {
    window.location.hash = "#/playground";
    window.dispatchEvent(new window.Event("hashchange"));
    await flush(120);
    (document.querySelector("#modelSel") as HTMLSelectElement).value = "gemini-3.6-flash";
    const row = await typeAndSend("playground-send probe " + Math.random().toString(36).slice(2, 8));
    // Streamed mock reply body carries the mock signature, never Gemini text.
    expect(row.querySelector(".content")!.textContent).toContain("mock");
    const line = row.querySelector(".metrics")!.textContent || "";
    expect(line).toContain("BYPASS"); // streams bypass the exact cache
    expect(line).toMatch(/ttft \d+\.\ds/);
    // Metrics card proves the reply came through the gateway as x-provider mock.
    (row.querySelector(".metrics") as HTMLElement).click();
    const card = row.querySelector(".metrics-card") as HTMLElement;
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("mock");
  });
});
