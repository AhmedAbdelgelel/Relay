import { GATEWAY, PROVIDERS, DEFAULTS, TRACE_STEPS } from "./config.js";
import { GatewayClient } from "./api.js";
import {
  defaultForm,
  buildPayload,
  formatTokens,
  canonicalRequest,
  sha256Hex,
  estimateTokens,
  estimateUsage,
  tokensPerSecond,
  copyText,
  estimateCost,
  formatCost,
  formatLatency,
} from "./state.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CHATS_KEY = "llm-gateway-chats-v1";
// Gateway connection comes from the "Connect via API" fields (localStorage).
const API_KEY_KEY = "llm-gateway-api-v1";
function loadApiConfig() {
  try { return JSON.parse(localStorage.getItem(API_KEY_KEY)) || {}; } catch { return {}; }
}
let apiConfig = loadApiConfig();
let client = new GatewayClient(apiConfig.baseUrl || "", apiConfig.apiKey || "");
const form = defaultForm();
let aborter = null;
let lastPayload = null;
let chats = [];
let activeId = null;
let health = { ok: false, provider: null, cache: null };
let metricsCache = null;
// Live GET /metrics snapshot. Zeros are the honest cold-start value: the
// pages below must never show invented traffic, so they read 0 until the
// gateway has actually served requests.
const EMPTY_METRICS = {
  requests_total: 0, exact_hits: 0, exact_misses: 0,
  singleflight_coalesced: 0, singleflight_leaders: 0,
  provider_requests: 0, provider_errors: 0,
  cache_lookup_failed: 0, cache_write_failed: 0,
  semantic_hits: 0, semantic_misses: 0, semantic_errors: 0,
  semantic_lookups: 0, avg_semantic_score: 0,
  cache_lookups: 0, avg_cache_lookup_ms: 0,
  avg_provider_ms: 0, hit_rate: 0, provider_calls_avoided: 0,
};
let gatewayMetrics = { ...EMPTY_METRICS };
let gatewayConfig = null;

function pct(part, whole) {
  return whole > 0 ? (part / whole) * 100 : 0;
}
function fmtRate(p) {
  return (Math.round(p * 100) / 100).toFixed(2) + "%";
}
async function refreshMetrics() {
  try {
    const r = await fetch((apiConfig.baseUrl || "") + "/metrics");
    if (r.ok) gatewayMetrics = { ...EMPTY_METRICS, ...(await r.json()) };
  } catch {
    /* offline-safe: keep the last known snapshot */
  }
  return gatewayMetrics;
}

const SUGGESTIONS = [
  "What does an exact cache guarantee?",
  "Explain canonical request hashing",
  "Why does stream:true bypass the cache?",
];

// Session dashboard counters (D4). `estimated` marks totals that include a
// ≈ client-side token estimate because the provider reported no usage.
// semanticHits is separate from exact hits: a semantic hit saved a provider
// call on an exact MISS, so it must never inflate the exact hit rate.
const session = {
  requests: 0, hits: 0, misses: 0, bypassed: 0, disabled: 0, errors: 0,
  semanticHits: 0, semanticMisses: 0, semanticDisabled: 0,
  prompt: 0, completion: 0, latency: 0,
  reused: 0, chunks: 0, ttftSum: 0, ttftCount: 0, estimated: false,
  lastIO: null,
};

function uid() {
  return "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Small ring of gateway events observed by this browser session (request ids,
// cache verdicts, errors). Bounded so a long session cannot grow forever.
const sessionEvents = [];
function pushLog(level, message, requestId) {
  sessionEvents.push({
    ts: new Date().toISOString().slice(11, 19),
    level,
    request_id: requestId || ("req-" + Math.random().toString(16).slice(2, 10)),
    message,
  });
  if (sessionEvents.length > 200) sessionEvents.shift();
}

/* ── workspaces + theme ────────────────────────────────────────────── */
// A workspace is a named gateway connection. The first is always this origin;
// any URL typed in "Connect via API" is saved as a workspace so the switcher
// can move the whole UI between gateways (metrics, providers, cache) at once.
const WS_KEY = "llm-gateway-workspaces-v1";
function loadWorkspaces() {
  const base = { id: "local", name: "dev-workspace", baseUrl: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(WS_KEY));
    const list = Array.isArray(saved) ? saved.filter((w) => w && w.id !== "local") : [];
    return [base, ...list];
  } catch { return [base]; }
}
function saveWorkspaces(list) {
  try { localStorage.setItem(WS_KEY, JSON.stringify(list.filter((w) => w.id !== "local"))); } catch { }
}
function activeWorkspace() {
  const list = loadWorkspaces();
  return list.find((w) => w.baseUrl === (apiConfig.baseUrl || "")) || list[0];
}
function ensureWorkspaceFor(baseUrl, apiKey) {
  const list = loadWorkspaces();
  if (!baseUrl) return;
  let hit = list.find((w) => w.baseUrl === baseUrl);
  if (hit) { hit.apiKey = apiKey; }
  else { hit = { id: "w-" + Math.random().toString(36).slice(2, 8), name: baseUrl.replace(/^https?:\/\//, ""), baseUrl, apiKey }; list.push(hit); }
  saveWorkspaces(list);
}
function renderWorkspace() {
  const ws = activeWorkspace();
  const name = $("#wsName");
  if (name) name.textContent = ws.name;
  const url = $("#wsUrl");
  if (url) url.textContent = ws.baseUrl || "same origin";
  const avatar = $("#wsAvatar");
  if (avatar) avatar.textContent = (ws.name[0] || "D").toUpperCase();
  const menu = $("#wsMenu");
  if (!menu) return;
  menu.innerHTML = loadWorkspaces().map((w) =>
    '<button class="ws-item' + (w.baseUrl === ws.baseUrl ? " active" : "") + '" type="button" role="menuitem" data-ws-id="' + esc(w.id) + '">' +
    '<span class="status-dot" aria-hidden="true"></span><span class="ws-item-text"><span>' + esc(w.name) + "</span>" +
    '<span class="ws-item-url">' + esc(w.baseUrl || "same origin") + "</span></span></button>"
  ).join("");
}
function toggleWorkspaceMenu(force) {
  const btn = $("#workspaceBtn");
  const menu = $("#wsMenu");
  if (!btn || !menu) return;
  const open = force === undefined ? menu.hidden : force;
  renderWorkspace();
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}
function bindWorkspaceSwitcher() {
  const btn = $("#workspaceBtn");
  const menu = $("#wsMenu");
  if (!btn || !menu) return;
  btn.addEventListener("click", (e) => { e.stopPropagation(); toggleWorkspaceMenu(); });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".ws-item");
    if (!item) return;
    const ws = loadWorkspaces().find((w) => w.id === item.dataset.wsId);
    if (!ws) return;
    apiConfig = { baseUrl: ws.baseUrl || "", apiKey: ws.apiKey || "" };
    try { localStorage.setItem(API_KEY_KEY, JSON.stringify(apiConfig)); } catch { }
    client = new GatewayClient(apiConfig.baseUrl, apiConfig.apiKey);
    const baseInput = $("#apiBaseInput");
    const keyInput = $("#apiKeyInput");
    if (baseInput) baseInput.value = apiConfig.baseUrl;
    if (keyInput) keyInput.value = apiConfig.apiKey;
    toggleWorkspaceMenu(false);
    renderWorkspace();
    checkHealth();
    render();
  });
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) toggleWorkspaceMenu(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleWorkspaceMenu(false); });
  renderWorkspace();
}
function bindThemeToggle() {
  const btn = $("#themeBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("llm-gateway-theme", next); } catch { }
  });
}

/* ── health / metrics ─────────────────────────────────────────────── */
function setStatus(online, text) {
  const dot = $("#statusDot");
  if (dot) { dot.classList.remove("on", "off"); dot.classList.add(online ? "on" : "off"); }
  const pip = $("#tbPip");
  if (pip) { pip.classList.remove("on", "off"); pip.classList.add(online ? "on" : "off"); }
  const tb = $("#tbStatus");
  if (tb) tb.textContent = online ? ("live · " + (health.provider || "gateway")) : "offline";
  const cache = $("#tbCache");
  if (cache) cache.textContent = "cache " + (health.cache || "—");
  // The footer no longer prints a status sentence; the dot + workspace url carry it.
  const url = $("#wsUrl");
  if (url && health.ok) url.title = text || "";
}

async function checkHealth() {
  try {
    const h = await client.health();
    health = {
      ok: true,
      provider: h.provider || "gateway",
      cache: h.cache || "—",
      semantic: h.semantic || "none",
      embedder: h.embedder || "none",
    };
    // Cache tuning the gateway is actually running with. Read-only, no secrets:
    // lets the Cache page show the real policy instead of guessing.
    gatewayConfig = h.config || null;
    setStatus(true, "Online · " + health.provider);
  } catch {
    health = { ok: false, provider: null, cache: null, semantic: null, embedder: null };
    setStatus(false, "Offline");
  }
  await refreshMetrics();
  metricsCache = gatewayMetrics;
}

/* ── chats ────────────────────────────────────────────────────────── */
function loadChats() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    chats = Array.isArray(list) ? list : [];
  } catch { chats = []; }
}
function saveChats() {
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 30))); } catch { }
}
function activeChat() { return chats.find((c) => c.id === activeId) || null; }

function renderStats() {
  const total = session.prompt + session.completion;
  const decided = session.hits + session.misses;
  const rate = decided ? Math.round((session.hits / decided) * 100) + "%" : "—";
  const avg = session.requests ? (session.latency / session.requests / 1000).toFixed(1) + "s" : "—";
  const avgTtft = session.ttftCount ? Math.round(session.ttftSum / session.ttftCount) + "ms" : "—";
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("#statRequests", String(session.requests));
  set("#statHits", String(session.hits));
  set("#statMisses", String(session.misses));
  set("#statBypassed", String(session.bypassed));
  set("#statDisabled", String(session.disabled));
  set("#statErrors", String(session.errors));
  set("#statRate", rate);
  set("#statTokensIn", session.prompt.toLocaleString("en-US"));
  set("#statTokensOut", session.completion.toLocaleString("en-US"));
  set("#statReused", session.reused.toLocaleString("en-US"));
  set("#statChunks", session.chunks.toLocaleString("en-US"));
  set("#statAvgLatency", avg);
  set("#statTtft", avgTtft);
  set("#statSaved", String(session.hits));
  const sh = $("#statSemanticHits"); if (sh) sh.textContent = String(session.semanticHits);
  const sr = $("#statSemanticRate"); if (sr) sr.textContent = "—";
  const sum = $("#statsSummary");
  if (sum) sum.textContent = session.requests
    ? (session.estimated ? "≈ " : "") +
      session.requests + " requests (" + session.bypassed + " streamed) · " + rate + " HIT · " +
      total.toLocaleString("en-US") + " tokens" +
      (session.errors ? " · " + session.errors + " error" + (session.errors > 1 ? "s" : "") : "")
    : "No requests yet";
}

// cache: HIT | MISS | BYPASS | DISABLED | null (null = request failed before
// the gateway could classify it, e.g. 429/504 -> counted as an error).
function recordStats(cache, tokens, latencyMs, extra = {}) {
  session.requests++;
  if (extra.error) session.errors++;
  else if (cache === "HIT") {
    session.hits++;
    if (tokens) session.reused += tokens.prompt + tokens.completion; // provider NOT called
  } else if (cache === "MISS") session.misses++;
  else if (cache === "DISABLED") session.disabled++;
  else session.bypassed++;
  if (tokens) {
    session.prompt += tokens.prompt;
    session.completion += tokens.completion;
    if (extra.estimated) session.estimated = true;
  }
  if (extra.ttftMs) { session.ttftSum += extra.ttftMs; session.ttftCount++; }
  if (extra.chunks) session.chunks += extra.chunks;
  session.latency += latencyMs;
  renderStats();
}

function scrollBottom() {
  const t = $("#thread");
  if (!t) return;
  const scroller = t.closest(".app-main") || t.parentElement;
  if (scroller && scroller.scrollTo) { try { scroller.scrollTop = scroller.scrollHeight; } catch { } }
  try { t.lastElementChild?.scrollIntoView({ block: "nearest" }); } catch { }
}

function wireCopy(btn, getText) {
  btn.addEventListener("click", async () => {
    const ok = await copyText(getText());
    btn.textContent = ok ? "Copied" : "Copy";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  });
}

function buildUserRow(text) {
  const row = document.createElement("div");
  row.className = "msg user";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "You";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  row.appendChild(who);
  row.appendChild(bubble);
  return row;
}

const CACHE_HINT = {
  HIT: "Exact match found for this canonical key — served from cache, the provider was NOT called.",
  MISS: "No entry for this key — provider called, response stored under the key for the TTL.",
  BYPASS: "stream:true bypasses the exact cache (an SSE stream cannot replay a stored blob).",
  DISABLED: "Cache turned off on this gateway (CACHE_ENABLED=0) — every request reaches the provider.",
};

function mrow(key) {
  const row = document.createElement("div");
  row.className = "mrow";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = key;
  const v = document.createElement("span");
  v.className = "v";
  row.appendChild(k);
  row.appendChild(v);
  return { row, value: v };
}

function subLine(value, text) {
  const s = document.createElement("span");
  s.className = "sub";
  s.textContent = text;
  value.appendChild(s);
}

function buildMetricsCard(m) {
  const card = document.createElement("div");
  card.className = "metrics-card";
  card.hidden = true;

  // 1. Cache verdict — the answer to "did this hit, and why".
  const cache = mrow("Cache");
  if (m.cache) {
    const badge = document.createElement("span");
    badge.className = "badge " + String(m.cache).toLowerCase();
    badge.textContent = m.cache;
    cache.value.appendChild(badge);
    if (CACHE_HINT[m.cache]) subLine(cache.value, CACHE_HINT[m.cache]);
  } else {
    cache.value.className = "v dim";
    cache.value.textContent = "not classified (request failed)";
  }
  card.appendChild(cache.row);

  // 2. The exact Redis key (D3 evidence).
  const key = mrow("Cache key");
  if (m.hash) {
    const full = "llm:exact:v1:" + (m.provider || "unknown") + ":" + m.hash;
    key.value.textContent = full;
    const copyKey = document.createElement("button");
    copyKey.className = "card-copy";
    copyKey.type = "button";
    copyKey.textContent = "copy";
    copyKey.addEventListener("click", async () => {
      copyKey.textContent = (await copyText(full)) ? "copied" : "failed";
      setTimeout(() => { copyKey.textContent = "copy"; }, 1200);
    });
    key.value.appendChild(copyKey);
  } else {
    key.value.className = "v dim";
    key.value.textContent = "— (no x-cache-hash header)";
  }
  card.appendChild(key.row);

  // 3. Canonical request + byte-for-byte verification against the gateway.
  const canon = mrow("Canonical");
  if (m.canonical) {
    const verify = document.createElement("span");
    verify.className = "verify idle";
    verify.textContent = "sha256…";
    canon.value.appendChild(verify);
    const pre = document.createElement("pre");
    pre.className = "canonical";
    pre.textContent = m.canonical;
    canon.value.appendChild(pre);
    if (m.hash) {
      sha256Hex(m.canonical).then((local) => {
        if (!local) {
          verify.className = "verify idle";
          verify.textContent = "sha256 unavailable in this context";
        } else if (local === m.hash) {
          verify.className = "verify ok";
          verify.textContent = "✓ browser sha256 matches x-cache-hash";
        } else {
          verify.className = "verify bad";
          verify.textContent = "✗ browser sha256 differs from gateway";
        }
      });
    } else {
      verify.className = "verify idle";
      verify.textContent = "gateway sent no hash to compare";
    }
  } else {
    canon.value.className = "v dim";
    canon.value.textContent = "—";
  }
  card.appendChild(canon.row);

  // 4. Latency: what the browser measured vs what the gateway measured.
  const latency = mrow("Latency");
  latency.value.textContent = Math.round(m.latencyMs || 0) + " ms";
  if (m.gwMs !== null && m.gwMs !== undefined) {
    subLine(latency.value, "gateway " + m.gwMs + " ms" + (m.streamed ? " (first token)" : " (whole request)"));
  }
  card.appendChild(latency.row);

  // 5. TTFT — streaming-only, first token on screen.
  if (m.streamed) {
    const ttft = mrow("TTFT");
    ttft.value.textContent = m.ttftMs ? Math.round(m.ttftMs) + " ms" : "—";
    subLine(ttft.value, "time to first token, measured in the browser");
    card.appendChild(ttft.row);
  }

  // 6. Token I/O — real (provider) or ≈ (browser estimate).
  const tokens = mrow("Tokens");
  if (m.tokens) {
    tokens.value.textContent = m.tokens.prompt + " in · " + m.tokens.completion + " out";
    if (m.tokensEstimated) subLine(tokens.value, "≈ estimated (~4 chars/token) — provider reported no usage");
  } else {
    tokens.value.className = "v dim";
    tokens.value.textContent = "— (no usage reported)";
  }
  card.appendChild(tokens.row);

  // 7. Generation speed.
  const rate = tokensPerSecond(m.tokens, m.latencyMs, m.ttftMs);
  if (rate !== null) {
    const speed = mrow("Speed");
    speed.value.textContent = rate + " tok/s";
    subLine(speed.value, "completion tokens / generating time");
    card.appendChild(speed.row);
  }

  // 8. Streaming specifics.
  if (m.streamed) {
    const stream = mrow("Stream");
    stream.value.textContent = (m.chunks ?? 0) + " chunks · SSE";
    subLine(stream.value, "cache bypassed — the numbers above come from this connection only");
    card.appendChild(stream.row);
  }

  // 9. Who answered.
  const who = mrow("Provider");
  who.value.textContent = (m.provider || "—") + " · " + (m.model || "—");
  card.appendChild(who.row);

  // 10. Correlation id — paste into the gateway JSON logs to find this request.
  const req = mrow("Request");
  if (m.requestId) {
    req.value.textContent = m.requestId;
    const stamp = m.at ? new Date(m.at).toLocaleTimeString() : "";
    if (stamp) subLine(req.value, stamp);
  } else {
    req.value.className = "v dim";
    req.value.textContent = "—";
  }
  card.appendChild(req.row);

  return card;
}

function toggleMetrics(line, card) {
  const open = card.hidden;
  card.hidden = !open;
  line.classList.toggle("open", open);
}

function metricsLine(m) {
  const line = document.createElement("div");
  line.className = "metrics";
  line.setAttribute("role", "button");
  line.setAttribute("tabindex", "0");
  line.title = "Request metrics — click for the full breakdown";
  const approx = m.tokensEstimated ? "≈" : "";
  const parts = [];
  parts.push((m.latencyMs / 1000).toFixed(1) + "s");
  if (m.streamed && m.ttftMs) parts.push("ttft " + (m.ttftMs / 1000).toFixed(1) + "s");
  if (m.tokens) parts.push(approx + m.tokens.prompt + " in · " + approx + m.tokens.completion + " out");
  if (m.streamed && m.chunks) parts.push(m.chunks + " chunks");
  if (m.cache) parts.push("cache " + m.cache);
  parts.push(m.model);
  line.textContent = parts.join(" · ");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  line.appendChild(caret);
  if (m.cache === "HIT") line.classList.add("hit");
  else if (m.cache === "MISS") line.classList.add("miss");
  else if (m.cache) line.classList.add("bypass");
  return line;
}

function buildAssistantRow(text, meta, opts = {}) {
  const row = document.createElement("div");
  row.className = "msg assistant";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = providerLabel();
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = text;
  row.appendChild(who);
  row.appendChild(content);
  if (meta) {
    const line = metricsLine(meta);
    const card = buildMetricsCard(meta);
    line.addEventListener("click", () => toggleMetrics(line, card));
    line.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMetrics(line, card); }
    });
    row.appendChild(line);
    row.appendChild(card);
  }
  const tools = document.createElement("div");
  tools.className = "tools";
  const copy = document.createElement("button");
  copy.className = "mini-btn";
  copy.type = "button";
  copy.textContent = "Copy";
  wireCopy(copy, () => content.textContent);
  tools.appendChild(copy);
  if (opts.regenerate && lastPayload) {
    const again = document.createElement("button");
    again.className = "mini-btn";
    again.type = "button";
    again.textContent = "Regenerate";
    again.addEventListener("click", () => { if (aborter) return; runPayload(lastPayload); });
    tools.appendChild(again);
  }
  row.appendChild(tools);
  return { row, content };
}

function providerLabel() {
  const p = PROVIDERS[form.provider];
  if (!p) return "Assistant";
  if (form.provider === "google") return "Gemini";
  return p.label;
}

function buildNoticeRow(text, meta) {
  const built = buildAssistantRow(text, meta);
  built.row.classList.add("notice");
  return built;
}

function buildErrorRow(m) {
  const row = document.createElement("div");
  row.className = "msg assistant error" + (m.quota ? " quota" : "");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = providerLabel();
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = m.title + "\n" + m.text;
  row.appendChild(who);
  row.appendChild(content);
  const meta = document.createElement("div");
  meta.className = "metrics";
  meta.textContent = "request " + (m.requestId || "—") + " · " + new Date().toLocaleTimeString();
  row.appendChild(meta);
  if (m.retry) {
    const tools = document.createElement("div");
    tools.className = "tools";
    const retry = document.createElement("button");
    retry.className = "mini-btn";
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => runPayload(m.retry));
    tools.appendChild(retry);
    row.appendChild(tools);
  }
  return row;
}

// Providers phrase quota waits differently:
//   "retry in 7h33m58.8s"  (Gemini free tier)
//   "retry in 45s" / "retryDelay: 45s"  (OpenAI-style)
// Normalize all of them into a short human string instead of raw seconds.
function humanWait(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  if (totalSeconds < 60) return Math.ceil(totalSeconds) + "s";
  if (totalSeconds < 3600) return Math.round(totalSeconds / 60) + "m";
  const hrs = totalSeconds / 3600;
  return (hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)) + "h";
}

function retryWaitText(res) {
  const raw = JSON.stringify(res.json || {}) + " " + String((res.meta && res.meta.error) || "");
  const hms = raw.match(/(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?\s*([\d.]+)\s*s/i);
  if (hms) return humanWait(Number(hms[1]) * 3600 + Number(hms[2]) * 60 + parseFloat(hms[3]));
  const hm = raw.match(/(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?/i);
  if (hm) return humanWait(Number(hm[1]) * 3600 + Number(hm[2]) * 60);
  const ms = raw.match(/(\d+)\s*m(?:in(?:ute)?s?)?\s*([\d.]+)?\s*s/i);
  if (ms && /retry/i.test(raw)) return humanWait(Number(ms[1]) * 60 + (ms[2] ? parseFloat(ms[2]) : 0));
  const secs = raw.match(/retry in ([\d.]+)\s*s/i);
  if (secs) return humanWait(parseFloat(secs[1]));
  const delay = raw.match(/retryDelay"?\s*:?\s*"?(\d+)/i);
  if (delay) return humanWait(Number(delay[1]));
  return null;
}

function quotaMessage(payload, res) {
  const wait = retryWaitText(res);
  return {
    role: "assistant", kind: "error",
    title: "Quota exhausted · 429",
    text: "Quota exhausted for " + payload.model + "." + (wait ? " Retry window ~" + wait + " from now." : "") + " Your prompt is saved — hit Retry or switch models.",
    requestId: res.meta.requestId || res.sentId,
    retry: payload,
  };
}

function renderThread() {
  const thread = $("#thread");
  if (!thread) return;
  thread.innerHTML = "";
  const chat = activeChat();
  if (!chat || !chat.messages.length) {
    const built = buildAssistantRow("Connected through your gateway to Gemini. Ask anything.", null);
    thread.appendChild(built.row);
    const sugs = document.createElement("div");
    sugs.className = "suggests";
    for (const s of SUGGESTIONS) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.textContent = s;
      chip.addEventListener("click", () => {
        const ta = $("#composerInput");
        if (ta) { ta.value = s; refreshComposerHint(); ta.focus(); }
      });
      sugs.appendChild(chip);
    }
    thread.appendChild(sugs);
    return;
  }
  const msgs = chat.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const isLast = i === msgs.length - 1;
    if (m.role === "user") thread.appendChild(buildUserRow(m.text));
    else if (m.kind === "error") thread.appendChild(buildErrorRow(m));
    else if (m.kind === "notice") thread.appendChild(buildNoticeRow(m.text, m.meta).row);
    else thread.appendChild(buildAssistantRow(m.text, m.meta, { regenerate: isLast && !m.kind }).row);
  }
  scrollBottom();
}

function pushMessage(msg) {
  const chat = activeChat();
  if (!chat) return;
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  saveChats();
  renderStack();
}

function renderStack() {
  const box = $("#chatStack");
  if (!box) return;
  box.innerHTML = "";
  if (!chats.length) {
    const d = document.createElement("div");
    d.className = "stack-empty";
    d.textContent = "No chats yet. Start one below.";
    box.appendChild(d);
    return;
  }
  const ordered = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of ordered) {
    const item = document.createElement("div");
    item.className = "chat-item" + (c.id === activeId ? " active" : "");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = c.title || "New chat";
    const del = document.createElement("button");
    del.className = "chat-del";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete chat");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      chats = chats.filter((x) => x.id !== c.id);
      if (activeId === c.id) activeId = chats.length ? [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id : null;
      if (!activeId) createChat();
      else { saveChats(); renderStack(); renderThread(); }
    });
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener("click", () => { activeId = c.id; renderStack(); renderThread(); });
    box.appendChild(item);
  }
}

function createChat() {
  const chat = { id: uid(), title: "New chat", messages: [], updatedAt: Date.now() };
  chats.unshift(chat);
  activeId = chat.id;
  saveChats();
  renderStack();
  renderThread();
}

function setRunning(running) {
  const btn = $("#sendBtn");
  if (btn) btn.classList.toggle("running", running);
  const label = $("#sendLabel");
  if (label) label.textContent = running ? "■" : "↑";
}

function readForm() {
  const modelSel = $("#modelSel");
  if (modelSel) form.model = modelSel.value;
  const provSel = $("#providerSel");
  if (provSel) form.provider = provSel.value;
  const sys = $("#systemInput");
  if (sys) form.system = sys.value;
  const comp = $("#composerInput");
  if (comp) form.user = comp.value;
  const temp = $("#tempInput");
  if (temp) form.temperature = parseFloat(temp.value);
  const tok = $("#tokensInput");
  if (tok) form.maxTokens = parseInt(tok.value, 10) || DEFAULTS.maxTokens;
  const tg = $("#streamToggle");
  if (tg) form.stream = tg.getAttribute("aria-checked") === "true";
}

function errorText(json, status) {
  if (json && json.error) {
    if (typeof json.error === "string") return json.error;
    return json.error.message || json.error.code || ("HTTP " + status);
  }
  return "HTTP " + status;
}

function emptyNotice(meta) {
  return {
    kind: "notice",
    text: "The provider returned an empty response, so there is nothing to show. Try rephrasing, or lower the temperature for a more deterministic answer.",
    meta,
  };
}

async function send() {
  if (aborter) { aborter.abort(); return; }
  readForm();
  const text = form.user.trim();
  if (!text) return;
  if (!activeChat()) createChat();
  const payload = buildPayload(form);
  lastPayload = payload;
  const chat = activeChat();
  if (chat.title === "New chat") chat.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
  pushMessage({ role: "user", text });
  renderThread();
  const ci = $("#composerInput");
  if (ci) ci.value = "";
  refreshComposerHint();
  await runPayload(payload);
}

async function runPayload(payload) {
  if (!activeChat()) createChat();
  if (currentRoute() !== "playground" && typeof window !== "undefined" && window.location) window.location.hash = "#/playground";
  const useStream = payload.stream;
  const model = payload.model;
  const pending = appendTyping();
  if (!pending) return;
  aborter = new AbortController();
  const signal = aborter.signal;
  setRunning(true);
  updateTraceRunning(true);
  const t0 = performance.now();
  try {
    if (useStream) {
      const content = document.createElement("div");
      content.className = "content streaming";
      const whoEl = pending.querySelector(".who");
      if (whoEl) pending.replaceChildren(whoEl, content);
      else pending.replaceChildren(content);
      const live = document.createElement("div");
      live.className = "metrics live";
      live.textContent = "streaming…";
      pending.appendChild(live);
      let chunks = 0;
      let ttftMs = null;
      const onToken = (delta) => {
        chunks++;
        if (ttftMs === null) ttftMs = performance.now() - t0;
        content.textContent += delta;
        live.textContent = "streaming · " + chunks + " chunks · " + ((performance.now() - t0) / 1000).toFixed(1) + "s · ≈" + estimateTokens(content.textContent) + " tok";
        scrollBottom();
      };
      const res = await client.chatStream(payload, { signal, onToken });
      const latencyMs = performance.now() - t0;
      pending.remove();
      const gwMs = res.meta.latencyMs !== null && res.meta.latencyMs !== undefined && res.meta.latencyMs !== ""
        ? parseInt(res.meta.latencyMs, 10) : null;
      const baseMeta = {
        latencyMs, ttftMs, gwMs,
        cache: res.meta.cache, hash: res.meta.cacheHash,
        canonical: canonicalRequest(payload),
        requestId: res.meta.requestId || res.sentId,
        provider: res.meta.provider, model, streamed: true,
        chunks: res.chunks || chunks, at: Date.now(),
      };
      session.lastIO = { payload, meta: baseMeta, ok: res.ok, usage: res.usage || null, text: content.textContent };
      updateTraceDone(payload, baseMeta, res.usage ? { prompt_tokens: res.usage.prompt_tokens, completion_tokens: res.usage.completion_tokens } : null);
      if (!res.ok) {
        recordStats(res.meta.cache, null, latencyMs, { error: true });
        pushLog("ERROR", "POST /v1/chat/completions " + res.status + " " + errorText(res.json, res.status), res.meta.requestId || res.sentId);
        pushMessage(res.status === 429 ? quotaMessage(payload, res) : { role: "assistant", kind: "error", title: "Request failed · " + res.status, text: errorText(res.json, res.status), requestId: res.meta.requestId || res.sentId });
        renderThread();
      } else if (!content.textContent.trim()) {
        recordStats(res.meta.cache, null, latencyMs, { chunks: res.chunks });
        pushMessage({ role: "assistant", ...emptyNotice({ ...baseMeta, tokens: null, tokensEstimated: false }) });
        renderThread();
      } else {
        const real = formatTokens(res.usage);
        const tokens = real || estimateUsage(payload, content.textContent);
        recordStats(res.meta.cache, tokens, latencyMs, { estimated: !real, ttftMs, chunks: res.chunks || chunks });
        pushLog("INFO", "POST /v1/chat/completions 200 stream chunks=" + (res.chunks || chunks) + " cache=" + (res.meta.cache || "bypass"), res.meta.requestId || res.sentId);
        pushMessage({ role: "assistant", text: content.textContent, meta: { ...baseMeta, tokens, tokensEstimated: !real } });
        renderThread();
      }
    } else {
      const res = await client.chat(payload, { signal });
      const latencyMs = performance.now() - t0;
      pending.remove();
      const gwMs = res.meta.latencyMs !== null && res.meta.latencyMs !== undefined && res.meta.latencyMs !== ""
        ? parseInt(res.meta.latencyMs, 10) : null;
      session.lastIO = { payload, meta: { requestId: res.meta.requestId || res.sentId, provider: res.meta.provider, cache: res.meta.cache }, ok: res.ok, usage: (res.json && res.json.usage) || null, text: JSON.stringify(res.json).slice(0, 400) };
      if (!res.ok) {
        recordStats(res.meta.cache, null, latencyMs, { error: true });
        pushLog("ERROR", "POST /v1/chat/completions " + res.status + " " + errorText(res.json, res.status), res.meta.requestId || res.sentId);
        pushMessage(res.status === 429 ? quotaMessage(payload, res) : { role: "assistant", kind: "error", title: "Request failed · " + res.status, text: errorText(res.json, res.status), requestId: res.meta.requestId || res.sentId });
        renderThread();
      } else {
        const choice = res.json.choices && res.json.choices[0];
        const reply = choice && choice.message ? choice.message.content : "";
        const tokens = formatTokens(res.json.usage);
        const meta = {
          latencyMs, ttftMs: null, gwMs,
          tokens, tokensEstimated: false,
          cache: res.meta.cache, hash: res.meta.cacheHash,
          canonical: canonicalRequest(payload),
          requestId: res.meta.requestId || res.sentId,
          provider: res.meta.provider, model: res.json.model || model,
          streamed: false, chunks: null, at: Date.now(),
        };
        session.lastIO = { payload, meta, ok: true, usage: res.json.usage || null, text: reply };
        updateTraceDone(payload, meta, res.json.usage || null);
        recordStats(res.meta.cache, tokens, latencyMs);
        pushLog("INFO", "POST /v1/chat/completions 200 cache=" + (res.meta.cache || "miss") + " model=" + model, res.meta.requestId || res.sentId);
        if (!reply.trim()) pushMessage({ role: "assistant", ...emptyNotice(meta) });
        else pushMessage({ role: "assistant", text: reply, meta });
        renderThread();
      }
    }
  } catch (e) {
    pending.remove();
    const latencyMs = performance.now() - t0;
    if (e && e.name === "AbortError") {
      recordStats(null, null, latencyMs, { error: true });
      pushMessage({ role: "assistant", text: "Stopped.", meta: { latencyMs, ttftMs: null, gwMs: null, tokens: null, cache: null, model, streamed: useStream, chunks: null, at: Date.now() } });
    } else {
      recordStats(null, null, latencyMs, { error: true });
      pushLog("ERROR", "gateway unreachable: " + ((e && e.message) || e), null);
      pushMessage({ role: "assistant", kind: "error", title: "Cannot reach the gateway", text: "Start it with npm run dev, then retry.", requestId: null });
    }
    renderThread();
  } finally {
    aborter = null;
    setRunning(false);
    updateTraceRunning(false);
  }
}

function appendTyping() {
  const thread = $("#thread");
  if (!thread) return null;
  const row = document.createElement("div");
  row.className = "msg assistant";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = providerLabel();
  const dots = document.createElement("div");
  dots.className = "typing";
  dots.appendChild(document.createElement("span"));
  dots.appendChild(document.createElement("span"));
  dots.appendChild(document.createElement("span"));
  row.appendChild(who);
  row.appendChild(dots);
  thread.appendChild(row);
  scrollBottom();
  return row;
}

function autoGrow() {
  const ta = $("#composerInput");
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
}

function refreshComposerHint() {
  autoGrow();
  const hint = $("#composerHint");
  const ta = $("#composerInput");
  if (hint && ta) hint.textContent = "≈ " + estimateTokens(ta.value).toLocaleString("en-US") + " tokens";
}

/* ── router ───────────────────────────────────────────────────────── */
// Only pages backed by a real gateway surface: /metrics, /v1/chat/completions,
// /providers. Everything else was fiction and is gone on purpose.
const ROUTES = ["overview", "playground", "providers", "cache", "requests"];
const ROUTE_TITLES = { overview: "Overview", playground: "Playground", providers: "Providers", cache: "Cache", requests: "Requests" };

function currentRoute() {
  const hash = (typeof window !== "undefined" && window.location ? window.location.hash : "") || "";
  const h = hash.replace(/^#\/?/, "").split("?")[0].split("/")[0];
  if (h === "" ) return "playground";
  if (h === "cache" || h === "semantic-cache") return "cache";
  if (ROUTES.includes(h)) return h;
  return "playground";
}

function render() {
  const route = currentRoute();
  $$("#sideNav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  const crumb = $("#crumb");
  if (crumb) crumb.textContent = ROUTE_TITLES[route] || route;
  const view = $("#view");
  if (!view) return;
  if (route === "overview") { view.innerHTML = viewOverview(); mountOverview(); }
  else if (route === "playground") { view.innerHTML = viewPlayground(); mountPlayground(); }
  else if (route === "providers") { view.innerHTML = viewProviders(); mountProviders(); }
  else if (route === "cache") { view.innerHTML = viewCache(); mountCache(); }
  else if (route === "requests") { view.innerHTML = viewRequests(); mountRequests(); }
  renderStats();
}

/* -- overview ---------------------------------------------------------- */
// Every figure is read from GET /metrics or measured in this browser session.
// No fabricated traffic: a cold gateway honestly reports zeros.
function overviewCards() {
  const m = gatewayMetrics;
  const s = session;
  const decided = m.exact_hits + m.exact_misses;
  const semDecided = m.semantic_hits + m.semantic_misses;
  const successPct = m.requests_total > 0 ? (1 - m.provider_errors / m.requests_total) * 100 : 100;
  const cards = [
    { k: "Requests", v: m.requests_total.toLocaleString("en-US"), d: m.provider_requests + " provider calls" },
    { k: "Success Rate", v: m.requests_total ? successPct.toFixed(1) + "%" : "--", d: m.provider_errors + " provider errors" },
    { k: "Avg Provider Latency", v: m.provider_requests ? Math.round(m.avg_provider_ms) + "ms" : "--", d: "upstream round trip" },
    { k: "Tokens (session)", v: (s.prompt + s.completion).toLocaleString("en-US"), d: s.prompt + " in - " + s.completion + " out" + (s.estimated ? " (est)" : "") },
    { k: "Exact Hit Rate", v: decided ? fmtRate(pct(m.exact_hits, decided)) : "--", d: m.exact_hits + " hit - " + m.exact_misses + " miss" },
    { k: "Semantic Hit Rate", v: semDecided ? fmtRate(pct(m.semantic_hits, semDecided)) : "--", d: m.semantic_hits + " hit - " + m.semantic_misses + " miss" },
  ];
  return cards
    .map((c) => '<div class="stat-card"><div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v) + '</div><div class="d">' + esc(c.d) + "</div></div>")
    .join("");
}

function metricRows() {
  const m = gatewayMetrics;
  const rows = [
    ["requests_total", m.requests_total],
    ["provider_requests", m.provider_requests],
    ["provider_errors", m.provider_errors],
    ["exact_hits", m.exact_hits],
    ["exact_misses", m.exact_misses],
    ["semantic_hits", m.semantic_hits],
    ["semantic_misses", m.semantic_misses],
    ["semantic_errors", m.semantic_errors],
    ["semantic_lookups", m.semantic_lookups],
    ["avg_semantic_score", Number(m.avg_semantic_score.toFixed(4))],
    ["provider_calls_avoided", m.provider_calls_avoided],
    ["singleflight_coalesced", m.singleflight_coalesced],
    ["singleflight_leaders", m.singleflight_leaders],
    ["cache_lookup_failed", m.cache_lookup_failed],
    ["cache_write_failed", m.cache_write_failed],
    ["avg_cache_lookup_ms", Number(m.avg_cache_lookup_ms.toFixed(2))],
    ["avg_provider_ms", Number(m.avg_provider_ms.toFixed(2))],
  ];
  return rows
    .map((r) => "<tr><td class='mono'>" + esc(r[0]) + "</td><td class='mono'>" + esc(String(r[1])) + "</td></tr>")
    .join("");
}

function viewOverview() {
  const s = session;
  return (
    '<div class="page" data-page="overview">' +
    '<div class="page-head"><div><h1>LLM Gateway</h1><p class="sub">Unified interface for multiple LLM providers</p></div>' +
    '<div class="head-actions"><a class="btn primary" href="#/playground">Open Playground</a></div></div>' +
    '<div class="grid-6" id="ovCards">' + overviewCards() + "</div>" +
    '<div class="panel live-strip"><div class="panel-title">This browser session</div><div class="live-grid">' +
    "<div><b>" + s.requests + "</b><span>requests</span></div>" +
    "<div><b>" + (s.prompt + s.completion).toLocaleString("en-US") + "</b><span>tokens</span></div>" +
    "<div><b>" + s.hits + " HIT / " + s.semanticHits + " SEM / " + s.misses + " MISS / " + s.bypassed + " BYPASS</b><span>cache verdicts</span></div>" +
    "<div><b>" + s.errors + "</b><span>errors</span></div>" +
    "</div></div>" +
    '<div class="grid-2">' +
    '<div class="panel"><div class="panel-title">Cache lookup pipeline</div><div class="flow-strip">' +
    ["Request", "Canonicalization", "Exact Cache", "Semantic Cache", "Policy", "Provider"]
      .map((x, i) => (i ? '<span class="arr">&rarr;</span>' : "") + '<span class="node">' + esc(x) + "</span>")
      .join("") +
    '</div><p class="small faint" style="margin:12px 0 0">Exact first. On MISS the request is embedded and searched for near-duplicates; the policy gate decides whether reuse is safe before any answer is returned.</p></div>' +
    '<div class="panel"><div class="panel-title">Gateway metrics</div><div class="tbl-wrap" style="max-height:340px;overflow:auto"><table class="tbl"><tbody>' +
    metricRows() +
    "</tbody></table></div></div></div></div>"
  );
}

function mountOverview() {
  refreshMetrics().then(() => {
    if (currentRoute() !== "overview") return;
    const host = $("#ovCards");
    if (host) host.innerHTML = overviewCards();
    const table = $("#view .panel:last-child tbody");
    if (table) table.innerHTML = metricRows();
  });
}

/* -- cache ------------------------------------------------------------ */
// Live from GET /metrics. Zeroes before any traffic, never demo numbers.
function cacheCards() {
  const m = gatewayMetrics;
  const decided = m.exact_hits + m.exact_misses;
  const semDecided = m.semantic_hits + m.semantic_misses;
  const cfg = gatewayConfig;
  const cards = [
    { k: "Exact Hit Rate", v: decided ? fmtRate(pct(m.exact_hits, decided)) : "--", d: m.exact_hits + " hit / " + m.exact_misses + " miss" },
    { k: "Semantic Hit Rate", v: semDecided ? fmtRate(pct(m.semantic_hits, semDecided)) : "--", d: m.semantic_hits + " hit / " + m.semantic_misses + " miss" },
    { k: "Provider Calls Avoided", v: String(m.provider_calls_avoided), d: m.exact_hits + " exact + " + m.singleflight_coalesced + " coalesced" },
    { k: "Mean Similarity", v: m.avg_semantic_score ? Number(m.avg_semantic_score.toFixed(4)) : "--", d: "cosine of accepted hits" },
    { k: "Exact Lookup", v: m.cache_lookups ? Math.round(m.avg_cache_lookup_ms) + "ms" : "--", d: "avg get() latency" },
    { k: "Cache Errors", v: String(m.cache_lookup_failed + m.cache_write_failed + m.semantic_errors), d: m.cache_lookup_failed + " read / " + m.cache_write_failed + " write / " + m.semantic_errors + " semantic" },
  ];
  return cards
    .map((c) => '<div class="stat-card"><div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v) + '</div><div class="d">' + esc(c.d) + "</div></div>")
    .join("");
}

function viewCache() {
  const cfg = gatewayConfig;
  const thr = cfg ? cfg.semanticThreshold : null;
  const thrText = thr === null ? "server configured" : "cosine >= " + thr;
  const steps = ["Request", "Canonicalization", "Exact Cache", "Semantic Cache", "Policy", "Provider"];
  const flow = steps
    .map((x, i) => (i ? '<span class="arr">&rarr;</span>' : "") + '<span class="node">' + esc(x) + "</span>")
    .join("");
  const exactJson = {
    key: "llm:exact:v1:<provider>:<sha256(canonical)>",
    identity_fields: ["model", "messages", "temperature", "max_tokens"],
    normalization: "trim whitespace, sort keys, stable JSON",
    verdicts: ["HIT", "MISS", "BYPASS (stream:true)", "DISABLED"],
    ttl_s: cfg ? cfg.cacheTtlSec : "server configured",
    store: health.cache || "unknown",
  };
  const semanticJson = {
    store: health.semantic || "unknown",
    embedder: health.embedder || "unknown",
    threshold: thr === null ? "server configured" : thr,
    top_k: cfg ? cfg.semanticTopK : "server configured",
    ttl_s: cfg ? cfg.semanticTtlSec : "server configured",
    hard_filter: ["tenant", "provider", "model"],
    policy_rejections: ["provider-mismatch", "model-mismatch", "temperature-mismatch", "max-tokens-mismatch", "below-threshold", "empty-content"],
    reuse_verdict: "SEMANTIC_HIT",
    similarity_header: "x-semantic-similarity",
  };
  const panel = (t, obj) => "<details class='inspect' open><summary>" + esc(t) + "</summary><div class='body'><pre class='json'>" + esc(JSON.stringify(obj, null, 2)) + "</pre></div></details>";
  return (
    '<div class="page"><div class="page-head"><div><h1>Cache</h1><p class="sub">Exact first, semantic on MISS, policy gate before every reuse</p></div>' +
    '<div class="head-actions"><span class="mono faint small" id="cacheLive">live /metrics</span></div></div>' +
    '<div class="grid-6" id="cacheCards">' + cacheCards() + "</div>" +
    '<div class="panel"><div class="panel-title">Lookup flow</div><div class="flow-strip">' + flow + "</div>" +
    '<div class="grid-2" style="margin-top:12px">' + panel("Exact cache - sha256 of the canonical request", exactJson) + panel("Semantic cache - " + thrText, semanticJson) + "</div>" +
    '<p class="small faint" style="margin:12px 0 0">Every verdict is returned on the response as <span class="mono">x-cache</span>, so a client can always prove why it hit or missed. Tuning is server-side (<span class="mono">CACHE_TTL_S</span>, <span class="mono">SEMANTIC_THRESHOLD</span>) and never reaches the browser.</p></div></div>'
  );
}

function mountCache() {
  refreshMetrics().then(() => {
    if (currentRoute() !== "cache") return;
    const host = $("#cacheCards");
    if (host) host.innerHTML = cacheCards();
  });
}

function mountRequests() {
  // The inspector reads session.lastIO, which the playground keeps current.
  refreshMetrics().then(() => {
    if (currentRoute() !== "requests") return;
    const el = $("#reqCacheVerdict");
    if (el && session.lastIO && session.lastIO.meta) el.textContent = session.lastIO.meta.cache || "--";
  });
}

/* ── shared bits ──────────────────────────────────────────────────── */
function pillFor(status) {
  const s = String(status || "").toLowerCase();
  const cls = s.includes("run") ? "running" : s.includes("complet") || s === "pass" || s === "connected" ? "completed" : s.includes("fail") ? "failed" : s.includes("cancel") ? "cancelled" : s.includes("miss") ? "miss" : s.includes("hit") ? "hit" : "idle";
  return '<span class="pill ' + cls + '"><span class="dot"></span>' + esc(status) + "</span>";
}
function costFor(model, prompt, completion) {
  return formatCost(estimateCost(model, { prompt, completion }));
}

/* ── overview ─────────────────────────────────────────────────────── */


/* ── playground ───────────────────────────────────────────────────── */
function viewPlayground() {
  return '<div class="page" data-page="playground">' +
    '<div class="page-head"><div><h1>Playground</h1><p class="sub">Send real requests through the gateway · POST /v1/chat/completions</p></div>' +
    '<div class="head-actions"><span class="provider-pill">Google · Gemini</span><span class="mono faint small" id="pgReqId"></span></div></div>' +
    '<div class="pg-layout">' +
    '<section class="panel pg-request"><div class="panel-title">Request</div>' +
    '<label class="fld"><span>Connect via API · gateway URL</span><input type="text" id="apiBaseInput" placeholder="same origin (leave empty)"></label>' +
    '<label class="fld"><span>API key (Bearer, optional)</span><input type="password" id="apiKeyInput" placeholder="optional"></label>' +
    '<label class="fld"><span>Provider</span><select id="providerSel"><option value="google">Google</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="custom">Custom</option></select></label>' +
    '<p class="small faint" style="margin:-4px 0 8px">Model prefix routes automatically (gpt-* → openai, claude-* → anthropic, gemini-* → google). API keys come from server env, never the browser.</p>' +
    '<label class="fld"><span>Model</span><select id="modelSel" aria-label="Model"></select></label>' +
    '<label class="fld"><span>Temperature <b id="tempVal">0.7</b></span><input type="range" id="tempInput" min="0" max="2" step="0.1"></label>' +
    '<label class="fld"><span>Max tokens</span><input type="number" id="tokensInput" min="1" max="8192"></label>' +
    '<label class="fld row"><span>Streaming</span><button class="toggle" id="streamToggle" type="button" role="switch" aria-checked="true"><span class="knob"></span></button></label>' +
    '<label class="fld"><span>System</span><textarea id="systemInput" rows="2" placeholder="You are a helpful assistant."></textarea></label>' +
    '<label class="fld"><span>User message</span><textarea id="composerInput" rows="6" placeholder="Send a prompt through the gateway…"></textarea></label>' +
    '<div class="composer-bar"><span class="composer-hint" id="composerHint">≈ 0 tokens</span></div>' +
    '<div class="btn-row"><button class="btn primary" id="sendBtn" type="button"><span id="sendLabel">↑</span> Send Request</button><button class="btn" id="clearBtn" type="button">Clear</button><button class="btn" id="saveTestBtn" type="button">Save Test</button></div>' +
    "</section>" +
    '<section class="pg-response"><div class="panel"><div class="panel-title">Response</div><div id="thread"></div>' +
    '<div class="hintbar"><span><kbd>Enter</kbd> send</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span><span><kbd>Esc</kbd> stop</span><span>stream requests bypass the cache</span></div>' +
    '<div class="resp-meta" id="respMeta"><div class="cell"><div class="k">Latency</div><div class="v" id="rmLatency">—</div></div><div class="cell"><div class="k">Tokens</div><div class="v" id="rmTokens">—</div></div><div class="cell"><div class="k">Cost</div><div class="v" id="rmCost">—</div></div><div class="cell"><div class="k">Cache</div><div class="v" id="rmCache">—</div></div></div>' +
    "</div>" +
    '<div class="panel"><div class="panel-title">Request Trace</div><div class="trace" id="traceFlow"></div></div>' +
    '<details class="session" id="sessionPanel"><summary><span class="session-title">Session</span><span class="session-line" id="statsSummary">No requests yet</span></summary>' +
    '<div class="session-grid">' +
    '<div class="stat"><b id="statRequests">0</b><span>requests</span></div>' +
    '<div class="stat"><b id="statHits">0</b><span>exact hits</span></div>' +
    '<div class="stat"><b id="statMisses">0</b><span>exact misses</span></div>' +
    '<div class="stat"><b id="statRate">—</b><span>hit rate</span></div>' +
    '<div class="stat"><b id="statSemanticHits">0</b><span>semantic hits</span></div>' +
    '<div class="stat"><b id="statSemanticRate">—</b><span>semantic rate</span></div>' +
    '<div class="stat"><b id="statBypassed">0</b><span>streams bypassed</span></div>' +
    '<div class="stat"><b id="statDisabled">0</b><span>cache disabled</span></div>' +
    '<div class="stat"><b id="statErrors">0</b><span>errors</span></div>' +
    '<div class="stat"><b id="statSaved">0</b><span>provider calls saved</span></div>' +
    '<div class="stat"><b id="statTokensIn">0</b><span>tokens in</span></div>' +
    '<div class="stat"><b id="statTokensOut">0</b><span>tokens out</span></div>' +
    '<div class="stat"><b id="statReused">0</b><span>tokens reused</span></div>' +
    '<div class="stat"><b id="statChunks">0</b><span>stream chunks</span></div>' +
    '<div class="stat"><b id="statAvgLatency">—</b><span>avg latency</span></div>' +
    '<div class="stat"><b id="statTtft">—</b><span>avg TTFT</span></div>' +
    "</div></details></section></div></div>";
}

function populateModels() {
  const sel = $("#modelSel");
  if (!sel) return;
  const list = (PROVIDERS[form.provider] || PROVIDERS.google).models;
  sel.innerHTML = "";
  list.forEach((m) => {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  });
  if (list.includes(form.model)) sel.value = form.model;
  else { sel.value = list[0]; form.model = list[0]; }
  const pill = $(".provider-pill");
  if (pill) {
    const labels = { google: "Google · Gemini", openai: "OpenAI · GPT", anthropic: "Anthropic · Claude", custom: "Custom" };
    pill.textContent = labels[form.provider] || form.provider;
  }
}

function traceSnippet(step, payload, meta) {
  const p = payload || (lastPayload || { model: form.model, messages: [{ role: "user", content: $("#composerInput") ? $("#composerInput").value : "" }] });
  switch (step) {
    case "Client": return JSON.stringify({ method: "POST", path: GATEWAY.path, "x-request-id": (meta && meta.requestId) || "pending" }, null, 2);
    case "Gateway": return JSON.stringify({ validated: true, timeout_ms: 30000, request_id: (meta && meta.requestId) || "pending" }, null, 2);
    case "Canonical Request": return (meta && meta.canonical) || canonicalRequest(buildPayload({ ...form, user: (form.user || "") || "…" }));
    case "Provider Router": return JSON.stringify({ provider: (meta && meta.provider) || form.provider, adapter: (PROVIDERS[form.provider] || {}).adapter || "—", model: p.model }, null, 2);
    case "Provider Adapter": return JSON.stringify({ endpoint: (PROVIDERS[form.provider] || {}).endpoint || "—", stream: !!p.stream }, null, 2);
    case "LLM Provider": return JSON.stringify({ status: meta ? "200" : "pending", latency_ms: meta ? Math.round(meta.latencyMs || 0) : null, ttft_ms: (meta && meta.ttftMs) || null }, null, 2);
    case "Canonical Response": return JSON.stringify({ normalized: !!meta, usage: meta && meta.tokens ? meta.tokens : "pending", cache: (meta && meta.cache) || "…" }, null, 2);
    case "Client": return JSON.stringify({ delivered: !!meta, cache: (meta && meta.cache) || "…", request_id: (meta && meta.requestId) || "pending" }, null, 2);
    default: return "{}";
  }
}

function renderTrace(payload, meta, running) {
  const box = $("#traceFlow");
  if (!box) return;
  box.innerHTML = TRACE_STEPS.map((s, i) => {
    const cls = meta ? "done" : running ? (i === 0 ? "active" : "") : "";
    const lat = meta && i === 5 ? formatLatency(meta.latencyMs) : "";
    return '<div class="trace-step ' + cls + '"><div class="trace-head" data-i="' + i + '"><span class="idx">' + (i + 1) + '</span><span>' + esc(s) + '</span><span class="lat">' + esc(lat) + " ▾</span></div>" +
      '<div class="trace-body" hidden><pre class="json">' + esc(traceSnippet(s, payload, meta)) + "</pre></div></div>";
  }).join("");
  $$(".trace-head", box).forEach((h) => h.addEventListener("click", () => {
    const body = h.parentElement.querySelector(".trace-body");
    if (body) body.hidden = !body.hidden;
  }));
}

function updateTraceRunning(running) {
  if (currentRoute() !== "playground") return;
  if (running) renderTrace(lastPayload, null, true);
}
function updateTraceDone(payload, meta) {
  if (currentRoute() !== "playground") return;
  renderTrace(payload, meta, false);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("#rmLatency", formatLatency(meta.latencyMs) + (meta.gwMs != null ? " · gw " + meta.gwMs + "ms" : ""));
  set("#rmTokens", meta.tokens ? meta.tokens.prompt + " in · " + meta.tokens.completion + " out" : "—");
  set("#rmCost", meta.tokens ? formatCost(estimateCost(meta.model, meta.tokens)) : "—");
  set("#rmCache", meta.cache || "—");
  const rid = $("#pgReqId");
  if (rid && meta.requestId) rid.textContent = meta.requestId.slice(0, 8);
}

function mountPlayground() {
  const apiBase = $("#apiBaseInput");
  const apiKey = $("#apiKeyInput");
  if (apiBase && apiKey) {
    apiBase.value = apiConfig.baseUrl || "";
    apiKey.value = apiConfig.apiKey || "";
    const apply = () => {
      apiConfig = { baseUrl: apiBase.value.trim(), apiKey: apiKey.value.trim() };
      try { localStorage.setItem(API_KEY_KEY, JSON.stringify(apiConfig)); } catch { }
      ensureWorkspaceFor(apiConfig.baseUrl, apiConfig.apiKey);
      client = new GatewayClient(apiConfig.baseUrl || "", apiConfig.apiKey || "");
      renderWorkspace();
      checkHealth();
      render();
    };
    apiBase.addEventListener("change", apply);
    apiKey.addEventListener("change", apply);
  }
  const provSel = $("#providerSel");
  if (provSel) { provSel.value = form.provider; provSel.addEventListener("change", (e) => { form.provider = e.target.value; populateModels(); }); }
  populateModels();
  const sel = $("#modelSel");
  if (sel) sel.addEventListener("change", (e) => { form.model = e.target.value; });
  const temp = $("#tempInput");
  if (temp) {
    temp.value = String(form.temperature);
    const tv = $("#tempVal"); if (tv) tv.textContent = Number(form.temperature).toFixed(1);
    temp.addEventListener("input", (e) => { form.temperature = parseFloat(e.target.value); const v = $("#tempVal"); if (v) v.textContent = form.temperature.toFixed(1); });
  }
  const tok = $("#tokensInput");
  if (tok) { tok.value = String(form.maxTokens); tok.addEventListener("input", (e) => { form.maxTokens = parseInt(e.target.value, 10) || DEFAULTS.maxTokens; }); }
  const tg = $("#streamToggle");
  if (tg) {
    tg.setAttribute("aria-checked", String(form.stream));
    tg.addEventListener("click", () => {
      const on = tg.getAttribute("aria-checked") !== "true";
      tg.setAttribute("aria-checked", String(on));
      form.stream = on;
    });
  }
  const ci = $("#composerInput");
  if (ci) {
    ci.addEventListener("input", refreshComposerHint);
    ci.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
      else if (e.key === "Escape" && aborter) { aborter.abort(); }
    });
    refreshComposerHint();
  }
  const sys = $("#systemInput");
  if (sys && form.system) sys.value = form.system;
  const sendBtn = $("#sendBtn");
  if (sendBtn) sendBtn.addEventListener("click", send);
  const clear = $("#clearBtn");
  if (clear) clear.addEventListener("click", () => {
    const c = $("#composerInput"); if (c) c.value = "";
    const s = $("#systemInput"); if (s) s.value = "";
    refreshComposerHint();
    const t = $("#thread"); if (t) { renderThread(); }
  });
  const save = $("#saveTestBtn");
  if (save) save.addEventListener("click", async () => {
    readForm();
    const ok = await copyText(JSON.stringify(buildPayload(form), null, 2));
    save.textContent = ok ? "Copied" : "Save Test";
    setTimeout(() => { save.textContent = "Save Test"; }, 1200);
  });
  renderThread();
  renderTrace(session.lastIO ? session.lastIO.payload : null, session.lastIO ? session.lastIO.meta : null, false);
  if (session.lastIO && session.lastIO.meta) updateTraceDone(session.lastIO.payload, session.lastIO.meta);
}

/* ── providers ────────────────────────────────────────────────────── */
function providerFallbackCards() {
  // Shown only while GET /providers is unreachable. Inventing latency and
  // request counts here would make the page lie, so every card reads
  // "unknown (offline)" instead of a confident-looking demo number.
  return Object.entries(PROVIDERS).map(([key, p]) =>
    '<div class="prov-card"><h3><span class="dot" style="color:var(--dim);background:currentColor"></span>' + esc(p.label) +
      '<span style="margin-left:auto">' + pillFor("Unknown") + "</span></h3>" +
      '<div class="kv"><dt>endpoint</dt><dd>' + esc(p.endpoint) + "</dd>" +
      "<dt>models</dt><dd>" + esc(p.models.join(", ")) + "</dd>" +
      "<dt>status</dt><dd>unknown (offline)</dd></div></div>"
  ).join("");
}
function viewProviders() {
  const cards = providerFallbackCards();
  return '<div class="page"><div class="page-head"><div><h1>Providers</h1><p class="sub">One integration per provider · canonical translation at the edge</p></div><div class="head-actions"><span class="mono faint small" id="provLive">live status…</span></div></div>' +
    '<div class="banner"><span class="big">One unified interface</span><span class="arrow">→</span><span class="big">Gateway · Router · Adapter</span><span class="arrow">→</span><span class="big">OpenAI · Anthropic · Google</span></div>' +
    '<div class="prov-grid" id="provGrid">' + cards + "</div>" +
    '<div class="panel"><div class="panel-title">How routing works</div><p class="small muted" style="margin:0">Model prefix selects the adapter (<span class="mono">gpt-* → openai</span>, <span class="mono">claude-* → anthropic</span>, <span class="mono">gemini-* → google</span>). Requests are validated, canonicalized and hashed (<span class="mono">x-cache-hash</span>) before routing; responses are translated back to the OpenAI-compatible canonical shape. API keys come from server env, never the browser.</p></div></div>';
}
function liveProviderCards(list) {
  return list.map((p) => {
    const connected = !!p.configured;
    return '<div class="prov-card" data-provider="' + esc(p.id) + '"><h3><span class="dot" style="color:' + (connected ? "var(--green)" : "var(--dim)") + ';background:currentColor"></span>' + esc(p.label) +
      (p.active ? ' <span class="mono faint small">· default</span>' : "") +
      '<span style="margin-left:auto">' + pillFor(connected ? "Connected" : "Not configured") + '</span></h3>' +
      '<div class="kv"><dt>endpoint</dt><dd>' + esc(p.endpoint) + '</dd><dt>models</dt><dd>' + esc((p.models || []).join(", ")) + '</dd>' +
      '<dt>status</dt><dd>' + esc(connected ? "Connected" : "Not configured") + '</dd>' +
      (p.active ? '<dt>default</dt><dd>active default provider</dd>' : '') + '</div></div>';
  }).join("");
}
function mountProviders() {
  // Live status from GET /providers (real configured flags, never key values).
  // Fallback: keep the static cards rendered by viewProviders().
  try {
    const run = async () => {
      const res = await fetch((apiConfig.baseUrl || "") + "/providers");
      if (!res.ok) throw new Error("status " + res.status);
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error("bad shape");
      const grid = $("#provGrid");
      if (grid) grid.innerHTML = liveProviderCards(list);
      const live = $("#provLive");
      if (live) {
        const active = list.find((p) => p.active);
        const n = list.filter((p) => p.configured).length;
        live.textContent = "live · " + n + "/" + list.length + " configured" + (active ? " · default " + active.id : "");
      }
    };
    run().catch(() => {
      const live = $("#provLive");
      if (live) live.textContent = "offline · showing static catalog";
    });
  } catch {
    /* offline-safe: static fallback stays */
  }
}


/* ── requests ─────────────────────────────────────────────────────── */
function viewRequests() {
  const io = session.lastIO;
  const empty = "No live request yet — send one from the Playground to inspect the real pipeline.";
  const incoming = io ? io.payload : empty;
  const canon = io && io.meta && io.meta.canonical ? io.meta.canonical : empty;
  const prov = io && io.meta ? { provider: io.meta.provider, cache: io.meta.cache, request_id: io.meta.requestId, latency: io.meta.latencyMs } : empty;
  const provRes = io && io.usage ? io.usage : empty;
  const canonRes = io ? (io.ok ? "normalized by gateway" : "error response") : empty;
  const fin = io && io.text ? io.text : empty;
  const panel = (t, obj) => '<div class="panel"><div class="panel-title">' + esc(t) + '</div><pre class="json">' + esc(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) + "</pre></div>";
  const flow = ["Client", "Gateway", "Canonicalization", "Routing", "Adapter", "Provider", "Adapter", "Canonical Response", "Client"].map((x, i) => (i ? '<span class="arr">→</span>' : "") + '<span class="node">' + esc(x) + "</span>").join("");
  return '<div class="page"><div class="page-head"><div><h1>Request Inspector</h1><p class="sub">Incoming → canonical → provider → canonical → final · ' + (io ? "last live request" : "no live request yet") + "</p></div></div>" +
    '<div class="panel"><div class="panel-title">Architecture flow</div><div class="flow-strip">' + flow + "</div></div>" +
    '<div class="grid-2">' + panel("Incoming Request", incoming) + panel("Canonical Request", canon) + panel("Provider Request", prov) + panel("Provider Response", provRes) + panel("Canonical Response", canonRes) + panel("Final Response", fin) + "</div></div>";
}






/* ── boot ─────────────────────────────────────────────────────────── */
function init() {
  loadChats();
  if (!chats.length) {
    const chat = { id: uid(), title: "New chat", messages: [], updatedAt: Date.now() };
    chats.unshift(chat);
    activeId = chat.id;
    saveChats();
  } else {
    activeId = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
  }

  const menu = $("#menuBtn");
  if (menu) menu.addEventListener("click", () => {
    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) document.body.classList.toggle("open");
    else document.body.classList.toggle("collapsed");
  });

  const nb = $("#newChatBtn");
  if (nb) nb.addEventListener("click", () => { if (aborter) aborter.abort(); createChat(); if (currentRoute() !== "playground" && typeof window !== "undefined" && window.location) window.location.hash = "#/playground"; });

  bindWorkspaceSwitcher();
  bindThemeToggle();

  window.addEventListener("hashchange", render);
  render();

  checkHealth();
  const timer = setInterval(checkHealth, 30000);
  if (timer.unref) timer.unref();
}

init();
