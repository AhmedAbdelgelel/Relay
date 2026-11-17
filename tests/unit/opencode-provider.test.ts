import { describe, expect, it } from "vitest";
import {
  createProviderFromEnv,
  createProvidersFromEnv,
  defaultEndpointFor,
  providerRequiresKey,
  providerWithKey,
  routeProviderName,
} from "../../src/providers/factory.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import { loadConfig } from "../../src/infrastructure/config.js";
import { sendJson, startFakeUpstream } from "../e2e/harness.js";

const OPENCODE_ENV = {
  OPENCODE_API_KEY: "oc_test_key",
  OPENCODE_BASE_URL: "https://opencode.example.invalid/openai/v1",
  OPENCODE_MODEL: "deepseek-v4.1-flash",
};

describe("OpenCode Go provider configuration", () => {
  it("defaults to the OpenCode Go DeepSeek model and reads env overrides", () => {
    const defaults = loadConfig({});
    expect(defaults.openCodeApiKey).toBe("");
    expect(defaults.openCodeBaseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(defaults.openCodeModel).toBe("deepseek-v4.1-flash");

    const cfg = loadConfig(OPENCODE_ENV);
    expect(cfg.openCodeApiKey).toBe("oc_test_key");
    expect(cfg.openCodeBaseUrl).toBe(OPENCODE_ENV.OPENCODE_BASE_URL);
    expect(cfg.openCodeModel).toBe("deepseek-v4.1-flash");
  });

  it("creates the provider, registers it in the provider map, and routes DeepSeek ids to it", () => {
    const cfg = { ...loadConfig(OPENCODE_ENV), provider: "opencode" as const };
    const adapter = createProviderFromEnv(cfg);
    expect(adapter.name).toBe("opencode");
    expect(adapter.configured).toBe(true);
    expect(providerRequiresKey("opencode")).toBe(true);
    expect(defaultEndpointFor("opencode", cfg)).toBe(OPENCODE_ENV.OPENCODE_BASE_URL);
    expect(providerWithKey("opencode", "tenant-key", cfg, OPENCODE_ENV.OPENCODE_BASE_URL).name).toBe("opencode");
    expect(createProvidersFromEnv(cfg).has("opencode")).toBe(true);

    // Go model ids route to OpenCode; `:free` OpenRouter ids keep their own route.
    expect(routeProviderName("deepseek-v4.1-flash")).toBe("opencode");
    expect(routeProviderName("opencode/deepseek-v4-pro")).toBe("opencode");
    expect(routeProviderName("deepseek/deepseek-v4.1-flash:free")).toBe("openrouter");
  });
});

describe("OpenCode Go adapter wire contract", () => {
  it("sends the Bearer key, User-Agent, and OpenAI-compatible body to /chat/completions", async () => {
    const upstream = await startFakeUpstream((hit, res) => {
      sendJson(res, 200, {
        id: "oc-1",
        model: hit.body["model"],
        choices: [{ message: { content: "opencode-ok" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    });
    const adapter = new OpenAICompatibleProvider({
      name: "opencode",
      baseURL: upstream.url,
      apiKey: "oc_test_key",
      defaultModel: "deepseek-v4.1-flash",
      extraHeaders: { "User-Agent": "relay-gateway/0.1", "x-opencode-session": "relay-gateway" },
    });
    const res = await adapter.chat(
      {
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0,
        stream: false,
      },
      AbortSignal.timeout(5000),
    );

    expect(res.content).toBe("opencode-ok");
    expect(upstream.hits).toHaveLength(1);
    const hit = upstream.hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/chat/completions");
    expect(hit.headers["authorization"]).toBe("Bearer oc_test_key");
    expect(hit.headers["user-agent"]).toBe("relay-gateway/0.1");
    expect(hit.headers["x-opencode-session"]).toBe("relay-gateway");
    expect(hit.body).toMatchObject({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      stream: false,
    });

    await upstream.close();
  });
});
