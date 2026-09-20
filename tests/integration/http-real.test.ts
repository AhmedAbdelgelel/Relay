import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";

// Regression test for the live-Gemini bug: `request.raw 'close'` fires when the
// request body is fully read, aborting every upstream call over real HTTP at ~100ms.
// `inject()` never reproduces it — only a real socket does. So boot on an
// ephemeral port and POST via fetch.
describe("real socket (no premature abort)", () => {
  process.env.PROVIDER = "mock"; // force mock regardless of local .env (which may be gemini)
  let app: FastifyInstance;
  let address: string;

  beforeAll(async () => {
    ({ app } = buildServer());
    address = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(() => app.close());

  it("POST over real HTTP returns 200 (not 504)", async () => {
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const json = await res.json();
    expect(json.choices[0].message.content).toContain("mock echo");
  });
});
