/**
 * Shared test helpers: hermetic fetch stubbing and Response factories.
 *
 * No real network: everything is served from in-memory Response objects, and
 * route handlers can reject to simulate transport failures.
 */

import { vi } from "vitest";
import type { Mock } from "vitest";

export type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

/** URL as string for a fetch input, whatever shape the caller used. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Install a `fetch` stub for one test. Routes match on the full URL (string =
 * suffix match, RegExp = test). Unmatched requests hang forever so background
 * pollers (AppProvider /health, /metrics, …) can never cause stray state
 * updates or warnings.
 */
export function installFetch(routes: Array<[string | RegExp, RouteHandler]>): FetchMock {
  const stub: FetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    for (const [match, make] of routes) {
      if (typeof match === "string" ? url.endsWith(match) : match.test(url)) return make(init);
    }
    return new Promise<Response>(() => {
      /* intentionally never settles */
    });
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

/** JSON Response with Content-Type set. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** `data: <frame>\n\n` SSE Response with an optional evidence-header set. */
export function sseResponse(
  frames: readonly string[],
  headers: Record<string, string> = {},
): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}
