import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Vitest runs without `globals: true`, so RTL's automatic cleanup is not
// registered; do it explicitly for every test in the suite.
afterEach(() => {
  cleanup();
});
