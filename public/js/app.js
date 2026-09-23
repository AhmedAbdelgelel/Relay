import { GATEWAY, PROVIDERS, DEFAULTS } from "./config.js";
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
} from "./state.js";

const $ = (s) => document.querySelector(s);

const CHATS_KEY = "llm-gateway-chats-v1";
const client = new GatewayClient("", "real");
const form = defaultForm();
let aborter = null;
let lastPayload = null;
let chats = [];
let activeId = null;

const SUGGESTIONS = [
  "What does an exact cache guarantee?",
  "Explain canonical request hashing",
  "Why does stream:true bypass the cache?",
];

// Session dashboard counters (D4). `estimated` marks totals that include a
// ≈ client-side token estimate because the provider reported no usage.
const session = {
  requests: 0, hits: 0, misses: 0, bypassed: 0, disabled: 0, errors: 0,
  prompt: 0, completion: 0, latency: 0,
  reused: 0, chunks: 0, ttftSum: 0, ttftCount: 0, estimated: false,
};

function uid() {
  return "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function setStatus(online, text) {
  const dot = $("#statusDot");
  dot.classList.remove("on", "off");
  dot.classList.add(online ? "on" : "off");
  $("#statusText").textContent = text;
}

async function checkHealth() {
  try {
    const h = await client.health();
    setStatus(true, "Online · " + (h.provider || "gateway"));
  } catch {
    setStatus(false, "Offline");
  }
}

function loadChats() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    chats = Array.isArray(list) ? list : [];
  } catch {
    chats = [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 30)));
  } catch {
  }
}

function activeChat() {
  return chats.find((c) => c.id === activeId) || null;
}

function renderStats() {
  const total = session.prompt + session.completion;
  const decided = session.hits + session.misses;
  const rate = decided ? Math.round((session.hits / decided) * 100) + "%" : "—";
  const avg = session.requests ? (session.latency / session.requests / 1000).toFixed(1) + "s" : "—";
  const avgTtft = session.ttftCount ? Math.round(session.ttftSum / session.ttftCount) + "ms" : "—";
  $("#statRequests").textContent = String(session.requests);
  $("#statHits").textContent = String(session.hits);
  $("#statMisses").textContent = String(session.misses);
  $("#statBypassed").textContent = String(session.bypassed);
  $("#statDisabled").textContent = String(session.disabled);
  $("#statErrors").textContent = String(session.errors);
  $("#statRate").textContent = rate;
  $("#statTokensIn").textContent = session.prompt.toLocaleString("en-US");
  $("#statTokensOut").textContent = session.completion.toLocaleString("en-US");
  $("#statReused").textContent = session.reused.toLocaleString("en-US");
  $("#statChunks").textContent = session.chunks.toLocaleString("en-US");
  $("#statAvgLatency").textContent = avg;
  $("#statTtft").textContent = avgTtft;
  $("#statSaved").textContent = String(session.hits);
  $("#statsSummary").textContent = session.requests
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
  if (extra.ttftMs) {
    session.ttftSum += extra.ttftMs;
    session.ttftCount++;
  }
  if (extra.chunks) session.chunks += extra.chunks;
  session.latency += latencyMs;
  renderStats();
}

function scrollBottom() {
  const t = $("#thread");
  t.parentElement.scrollTop = t.parentElement.scrollHeight;
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

function subLine(value, text, cls) {
  const s = document.createElement("span");
  s.className = "sub" + (cls ? " " + cls : "");
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

function buildAssistantRow(text, meta, opts = {}) {
  const row = document.createElement("div");
  row.className = "msg assistant";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "Gemini";
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
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMetrics(line, card);
      }
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
    // Guard at click time, not render time: the thread renders while the run
    // is still in flight, so a render-time check would hide this button.
    again.addEventListener("click", () => {
      if (aborter) return;
      runPayload(lastPayload);
    });
    tools.appendChild(again);
  }
  row.appendChild(tools);
  return { row, content };
}

function buildNoticeRow(text, meta) {
  const built = buildAssistantRow(text, meta);
  built.row.classList.add("notice");
  return built;
}

function buildErrorRow(m) {
  const row = document.createElement("div");
  row.className = "msg assistant error";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "Gemini";
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

function retryWaitSeconds(res) {
  const raw = JSON.stringify(res.json || {});
  const direct = raw.match(/retry in ([\d.]+)\s*s/i);
  if (direct) return Math.ceil(parseFloat(direct[1]));
  const info = raw.match(/retryDelay"?\s*:?\s*"(\d+)\s*s/i);
  if (info) return parseInt(info[1], 10);
  return null;
}

function quotaMessage(payload, res) {
  const wait = retryWaitSeconds(res);
  return {
    role: "assistant",
    kind: "error",
    title: "Quota exhausted · 429",
    text: "Free-tier quota for " + payload.model + " is spent." + (wait ? " Gemini suggests waiting ~" + wait + "s." : "") + " Your prompt is saved — hit Retry or switch models.",
    requestId: res.meta.requestId || res.sentId,
    retry: payload,
  };
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

function renderThread() {
  const thread = $("#thread");
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
        $("#composerInput").value = s;
        refreshComposerHint();
        $("#composerInput").focus();
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
      else {
        saveChats();
        renderStack();
        renderThread();
      }
    });
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener("click", () => {
      activeId = c.id;
      renderStack();
      renderThread();
    });
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
  btn.classList.toggle("running", running);
  $("#sendLabel").textContent = running ? "■" : "↑";
}

function readForm() {
  form.model = $("#modelSel").value;
  form.user = $("#composerInput").value;
  form.temperature = parseFloat($("#tempInput").value);
  form.maxTokens = parseInt($("#tokensInput").value, 10) || DEFAULTS.maxTokens;
  form.stream = $("#streamToggle").getAttribute("aria-checked") === "true";
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
  if (aborter) {
    aborter.abort();
    return;
  }
  readForm();
  const text = form.user.trim();
  if (!text) return;
  if (!activeChat()) createChat();
  const payload = buildPayload(form);
  lastPayload = payload;
  const chat = activeChat();
  if (chat.title === "New chat") {
    chat.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
  }
  pushMessage({ role: "user", text });
  renderThread();
  $("#composerInput").value = "";
  refreshComposerHint();
  await runPayload(payload);
}

async function runPayload(payload) {
  if (!activeChat()) createChat();
  const useStream = payload.stream;
  const model = payload.model;
  const pending = appendTyping();
  aborter = new AbortController();
  const signal = aborter.signal;
  setRunning(true);
  const t0 = performance.now();
  try {
    if (useStream) {
      const content = document.createElement("div");
      content.className = "content streaming";
      pending.replaceChildren(pending.querySelector(".who"), content);
      // Live streaming metrics under the partial text: chunks + wall time so
      // the client sees the stream moving before any final numbers arrive.
      const live = document.createElement("div");
      live.className = "metrics live";
      live.textContent = "streaming…";
      pending.appendChild(live);
      let chunks = 0;
      let ttftMs = null;
      const onToken = (delta) => {
        chunks++;
        if (ttftMs === null) ttftMs = performance.now() - t0; // first token
        content.textContent += delta;
        live.textContent =
          "streaming · " + chunks + " chunks · " +
          ((performance.now() - t0) / 1000).toFixed(1) + "s · ≈" +
          estimateTokens(content.textContent) + " tok";
        scrollBottom();
      };
      const res = await client.chatStream(payload, { signal, onToken });
      const latencyMs = performance.now() - t0;
      pending.remove();
      const gwMs = res.meta.latencyMs !== null && res.meta.latencyMs !== undefined && res.meta.latencyMs !== ""
        ? parseInt(res.meta.latencyMs, 10)
        : null;
      const baseMeta = {
        latencyMs,
        ttftMs,
        gwMs, // SSE: gateway-side time-to-first-token (headers arrive with it)
        cache: res.meta.cache,
        hash: res.meta.cacheHash,
        canonical: canonicalRequest(payload), // browser-side rebuild, verified against hash
        requestId: res.meta.requestId || res.sentId,
        provider: res.meta.provider,
        model,
        streamed: true,
        chunks: res.chunks || chunks,
        at: Date.now(),
      };
      if (!res.ok) {
        recordStats(res.meta.cache, null, latencyMs, { error: true });
        pushMessage(res.status === 429 ? quotaMessage(payload, res) : { role: "assistant", kind: "error", title: "Request failed · " + res.status, text: errorText(res.json, res.status), requestId: res.meta.requestId || res.sentId });
        renderThread();
      } else if (!content.textContent.trim()) {
        recordStats(res.meta.cache, null, latencyMs, { chunks: res.chunks });
        pushMessage({ role: "assistant", ...emptyNotice({ ...baseMeta, tokens: null, tokensEstimated: false }) });
        renderThread();
      } else {
        const real = formatTokens(res.usage);
        const tokens = real || estimateUsage(payload, content.textContent);
        recordStats(res.meta.cache, tokens, latencyMs, {
          estimated: !real,
          ttftMs,
          chunks: res.chunks || chunks,
        });
        pushMessage({ role: "assistant", text: content.textContent, meta: { ...baseMeta, tokens, tokensEstimated: !real } });
        renderThread();
      }
    } else {
      const res = await client.chat(payload, { signal });
      const latencyMs = performance.now() - t0;
      pending.remove();
      const gwMs = res.meta.latencyMs !== null && res.meta.latencyMs !== undefined && res.meta.latencyMs !== ""
        ? parseInt(res.meta.latencyMs, 10)
        : null;
      if (!res.ok) {
        recordStats(res.meta.cache, null, latencyMs, { error: true });
        pushMessage(res.status === 429 ? quotaMessage(payload, res) : { role: "assistant", kind: "error", title: "Request failed · " + res.status, text: errorText(res.json, res.status), requestId: res.meta.requestId || res.sentId });
        renderThread();
      } else {
        const choice = res.json.choices && res.json.choices[0];
        const reply = choice && choice.message ? choice.message.content : "";
        const tokens = formatTokens(res.json.usage);
        const meta = {
          latencyMs,
          ttftMs: null,
          gwMs, // JSON: gateway-side total latency
          tokens,
          tokensEstimated: false,
          cache: res.meta.cache,
          hash: res.meta.cacheHash,
          canonical: canonicalRequest(payload),
          requestId: res.meta.requestId || res.sentId,
          provider: res.meta.provider,
          model: res.json.model || model,
          streamed: false,
          chunks: null,
          at: Date.now(),
        };
        recordStats(res.meta.cache, tokens, latencyMs);
        if (!reply.trim()) {
          pushMessage({ role: "assistant", ...emptyNotice(meta) });
        } else {
          pushMessage({ role: "assistant", text: reply, meta });
        }
        renderThread();
      }
    }
  } catch (e) {
    pending.remove();
    const latencyMs = performance.now() - t0;
    if (e && e.name === "AbortError") {
      recordStats(null, null, latencyMs, { error: true }); // stopped runs still cost a request
      pushMessage({ role: "assistant", text: "Stopped.", meta: { latencyMs, ttftMs: null, gwMs: null, tokens: null, cache: null, model, streamed: useStream, chunks: null, at: Date.now() } });
    } else {
      recordStats(null, null, latencyMs, { error: true });
      pushMessage({ role: "assistant", kind: "error", title: "Cannot reach the gateway", text: "Start it with npm run dev, then retry.", requestId: null });
    }
    renderThread();
  } finally {
    aborter = null;
    setRunning(false);
  }
}

function appendTyping() {
  const row = document.createElement("div");
  row.className = "msg assistant";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "Gemini";
  const dots = document.createElement("div");
  dots.className = "typing";
  dots.appendChild(document.createElement("span"));
  dots.appendChild(document.createElement("span"));
  dots.appendChild(document.createElement("span"));
  row.appendChild(who);
  row.appendChild(dots);
  $("#thread").appendChild(row);
  scrollBottom();
  return row;
}

function autoGrow() {
  const ta = $("#composerInput");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
}

// Live prompt-token estimate in the composer (the gateway reports the exact
// number back in the metrics card after the call).
function refreshComposerHint() {
  autoGrow();
  const hint = $("#composerHint");
  if (hint) hint.textContent = "≈ " + estimateTokens($("#composerInput").value).toLocaleString("en-US") + " tokens";
}

function init() {
  const sel = $("#modelSel");
  PROVIDERS.google.models.forEach((m) => {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  });
  sel.value = form.model;
  $("#tempInput").value = String(form.temperature);
  $("#tempVal").textContent = form.temperature.toFixed(1);
  $("#tokensInput").value = String(form.maxTokens);
  const toggle = $("#streamToggle");
  toggle.setAttribute("aria-checked", String(form.stream));

  loadChats();
  if (!chats.length) createChat();
  else {
    activeId = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
    renderStack();
    renderThread();
  }
  renderStats();

  $("#menuBtn").addEventListener("click", () => {
    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
      document.body.classList.toggle("open");
    } else {
      document.body.classList.toggle("collapsed");
    }
  });
  sel.addEventListener("change", (e) => { form.model = e.target.value; });
  $("#tempInput").addEventListener("input", (e) => {
    form.temperature = parseFloat(e.target.value);
    $("#tempVal").textContent = form.temperature.toFixed(1);
  });
  $("#tokensInput").addEventListener("input", (e) => {
    form.maxTokens = parseInt(e.target.value, 10) || DEFAULTS.maxTokens;
  });
  toggle.addEventListener("click", () => {
    const on = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(on));
    form.stream = on;
  });
  $("#composerInput").addEventListener("input", refreshComposerHint);
  refreshComposerHint();
  $("#composerInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });
  $("#sendBtn").addEventListener("click", send);
  $("#newChatBtn").addEventListener("click", () => {
    if (aborter) aborter.abort();
    createChat();
  });

  checkHealth();
  const timer = setInterval(checkHealth, 30000);
  if (timer.unref) timer.unref();
}

init();
