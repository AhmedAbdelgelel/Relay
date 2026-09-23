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
    models: ["gemini-3.6-flash", "gemini-3.5-flash-lite"],
  },
};

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
