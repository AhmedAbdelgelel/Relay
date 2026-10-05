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
  constructor(baseUrl = "", apiKey = "") {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
  }

  authHeaders() {
    return this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {};
  }

  async health() {
    const res = await fetch(this.baseUrl + "/health", { headers: this.authHeaders() });
    if (!res.ok) throw new Error("Gateway unhealthy: " + res.status);
    return res.json();
  }

  async chat(payload, opts = {}) {
    const id = requestId();
    const res = await fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": id, ...this.authHeaders() },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
    const meta = headersOf(res);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json, meta, sentId: id };
  }

  async chatStream(payload, opts = {}) {
    const id = requestId();
    const res = await fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-request-id": id,
        ...this.authHeaders(),
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: opts.signal,
    });
    const meta = headersOf(res);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return { status: res.status, ok: false, json, meta, sentId: id, text: "", usage: null, chunks: 0 };
    }
    const text = await readSSE(res, opts.onToken, opts.signal);
    return {
      status: res.status,
      ok: true,
      json: null,
      meta,
      sentId: id,
      text: text.text,
      usage: text.usage,
      chunks: text.chunks,
    };
  }
}