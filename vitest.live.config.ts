import { defineConfig } from "vitest/config";

// Opt-in config for tests that reach real provider endpoints (currently Gemini).
//
// It lives in its own file so the default `npm test` sweep — which auto-discovers
// no config at all — stays hermetic, offline and free. Nothing sets
// GEMINI_LIVE_TEST outside this file, so a key sitting in .env is not enough to
// trigger a real upstream call.
export default defineConfig({
  test: {
    include: ["tests/integration/gemini-live.test.ts"],
    env: { GEMINI_LIVE_TEST: "1" },
  },
});
