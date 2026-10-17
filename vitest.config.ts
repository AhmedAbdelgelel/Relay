import { defineConfig } from "vitest/config";

// Root sweep = the gateway's own suites under tests/ (unit-ish keepers, the
// e2e suite, and the self-skipping live opt-ins). web/ is a separate app with
// its own tsconfig path aliases, so it must run under web's own config there;
// without this pin the root glob would pull in web/**/*.test.tsx and fail to
// resolve "@/..." imports.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
