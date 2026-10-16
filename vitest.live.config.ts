import { defineConfig } from "vitest/config";

// Opt-in config for tests that reach real provider endpoints — now the
// OpenRouter free tier (tests/integration/openrouter-live.test.ts). Gemini
// remains available as a manual opt-in: GEMINI_LIVE_TEST=1 npm test.
//
// It lives in its own file so the default `npm test` sweep — which
// auto-discovers no config at all — stays hermetic, offline and free: nothing
// sets OPENROUTER_LIVE_TEST outside this file, so a key sitting in .env alone
// is not enough to trigger a real upstream call.
export default defineConfig({
  test: {
    include: ["tests/integration/openrouter-live.test.ts"],
    env: { OPENROUTER_LIVE_TEST: "1" },
  },
});
