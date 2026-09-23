function requestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "req-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function readSSE(response, onToken, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;   // terminal usage frame (D1) — null when the provider omitted it
  let chunks = 0;     // content deltas seen, a streaming metric of its own
  for (;;) {
    if (signal && signal.aborted) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return { text, usage, chunks };
      try {
        const json = JSON.parse(data);
        if (json.usage) usage = json.usage;
        const delta = json.choices && json.choices[0] && json.choices[0].delta
          ? json.choices[0].delta.content || ""
          : "";
        if (delta) {
          chunks++;
          text += delta;
          if (onToken) onToken(delta, text, chunks);
        }
      } catch {
        continue;
      }
    }
  }
  return { text, usage, chunks };
}

function headersOf(response) {
  const pick = (name) => response.headers.get(name);
  return {
    requestId: pick("x-request-id"),
    provider: pick("x-provider"),
    latencyMs: pick("x-latency-ms"),
    cache: pick("x-cache"),
    cacheHash: pick("x-cache-hash"), // D3: sha256 of the canonical request
  };
}

export class GatewayClient {
  constructor(baseUrl = "", mode = "real") {
    this.baseUrl = baseUrl;
    this.mode = mode;
  }

  async health() {
    if (this.mode === "mock") {
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true, provider: "mock", cache: "memory", mock: true };
    }
    const res = await fetch(this.baseUrl + "/health");
    if (!res.ok) throw new Error("Gateway unhealthy: " + res.status);
    return res.json();
  }

  async chat(payload, opts = {}) {
    if (this.mode === "mock") return this.mockChat(payload, opts);
    const id = requestId();
    const res = await fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": id },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
    const meta = headersOf(res);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json, meta, sentId: id };
  }

  async chatStream(payload, opts = {}) {
    if (this.mode === "mock") return this.mockStream(payload, opts);
    const id = requestId();
    const res = await fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-request-id": id,
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: opts.signal,
    });
    const meta = headersOf(res);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return {
      status: res.status,
      ok: false,
      json,
      meta,
      sentId: id,
      text: "",
      usage: null,
      chunks: 0,
    };
    }
    const text = await readSSE(res, opts.onToken, opts.signal);
    return {
      status: res.status,
      ok: true,
      json: null,
      meta,
      sentId: id,
      text: text.text,
      usage: text.usage,   // D1: real numbers, or null -> caller estimates (labeled ≈)
      chunks: text.chunks, // streaming metric: content deltas received
    };
  }

  async mockChat(payload, opts = {}) {
    const ms = 500 + Math.random() * 700;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }
    });
    const user = payload.messages.filter((m) => m.role === "user").pop();
    const content = "Mock response for model " + payload.model + ": " + ((user && user.content) || "").slice(0, 160);
    return {
      status: 200,
      ok: true,
      json: {
        id: "mock-" + Date.now(),
        model: payload.model,
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 24, completion_tokens: 32 },
      },
      meta: { requestId: requestId(), provider: "mock", latencyMs: String(Math.round(ms)), cache: "MISS", cacheHash: null },
      sentId: requestId(),
    };
  }

  async mockStream(payload, opts = {}) {
    const parts = ["Mock ", "streaming ", "response ", "for ", payload.model, "."];
    let text = "";
    for (const part of parts) {
      if (opts.signal && opts.signal.aborted) break;
      await new Promise((r) => setTimeout(r, 140));
      text += part;
      if (opts.onToken) opts.onToken(part, text);
    }
    return {
      status: 200,
      ok: true,
      json: null,
      meta: { requestId: requestId(), provider: "mock", latencyMs: null, cache: "BYPASS", cacheHash: null },
      sentId: requestId(),
      text,
      usage: null, // mock mode never reports usage -> exercises the ≈ estimate path
      chunks: parts.length,
    };
  }
}
