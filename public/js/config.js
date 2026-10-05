export const GATEWAY = {
  endpoint: "POST /v1/chat/completions",
  path: "/v1/chat/completions",
  version: "v1",
  environment: "Development",
};

export const PROVIDERS = {
  google: {
    label: "Google",
    adapter: "Google Adapter",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-3.6-flash", "gemini-3.5-flash-lite"],
  },
  openai: {
    label: "OpenAI",
    adapter: "OpenAI Adapter",
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  anthropic: {
    label: "Anthropic",
    adapter: "Anthropic Adapter",
    endpoint: "https://api.anthropic.com/v1",
    models: ["claude-4", "claude-4-sonnet", "claude-3.7-haiku"],
  },
  custom: {
    label: "Custom",
    adapter: "OpenAI-compatible Adapter",
    endpoint: "http://localhost:11434/v1",
    models: ["custom-model"],
  },
};

export const MODELS = [
  { id: "gemini-3.6-flash", provider: "google", context: 1048576, latency: "620ms", cost: 0.075, status: "stable" },
  { id: "gemini-3.5-flash-lite", provider: "google", context: 1048576, latency: "410ms", cost: 0.0375, status: "stable" },
  { id: "gpt-5", provider: "openai", context: 400000, latency: "890ms", cost: 1.25, status: "stable" },
  { id: "gpt-5-mini", provider: "openai", context: 400000, latency: "540ms", cost: 0.25, status: "stable" },
  { id: "gpt-4.1", provider: "openai", context: 1047576, latency: "980ms", cost: 2.0, status: "stable" },
  { id: "claude-4", provider: "anthropic", context: 200000, latency: "1100ms", cost: 3.0, status: "stable" },
  { id: "claude-4-sonnet", provider: "anthropic", context: 500000, latency: "940ms", cost: 1.5, status: "beta" },
  { id: "claude-3.7-haiku", provider: "anthropic", context: 200000, latency: "480ms", cost: 0.25, status: "stable" },
  { id: "custom-model", provider: "custom", context: 32768, latency: "—", cost: 0, status: "unconfigured" },
];

export const DEFAULTS = {
  provider: "google",
  model: "gemini-3.6-flash",
  system: "You are a helpful assistant.",
  user: "Explain what an LLM gateway does in two sentences.",
  temperature: 0.7,
  maxTokens: 512,
  topP: 1,
  stream: true,
};

export const FLOW_NODES = ["Client", "Gateway", "Router", "Adapter", "LLM"];

export const TRACE_STEPS = [
  "Client",
  "Gateway",
  "Canonical Request",
  "Provider Router",
  "Provider Adapter",
  "LLM Provider",
  "Canonical Response",
  "Client",
];

export const PROVIDER_META = {
  openai: { status: "Connected", latency: "212ms", requests: 48210, errorRate: "0.4%" },
  anthropic: { status: "Connected", latency: "348ms", requests: 31022, errorRate: "0.7%" },
  google: { status: "Connected", latency: "410ms", requests: 52118, errorRate: "0.9%" },
  custom: { status: "Not configured", latency: "—", requests: 0, errorRate: "—" },
};
