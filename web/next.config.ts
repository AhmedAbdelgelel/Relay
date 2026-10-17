import type { NextConfig } from "next";

/**
 * Same-origin API surface (proxied to the Fastify gateway, no CORS needed):
 *   /health     → GET  {ok, provider, cache, semantic, embedder, config}
 *   /metrics    → GET  metrics snapshot
 *   /providers  → GET  ProviderStatus[]
 *   /v1/*       → POST /v1/chat/completions (JSON) and SSE streams
 *
 * Rewrites are applied after filesystem routes (pages win), which keeps the
 * /providers *page* working. The gateway's /providers JSON is still reachable
 * for the API client because `gateway.ts` sends `Accept: application/json`;
 * that header routes the request to the `beforeFiles` entry below before the
 * page is considered. Browser navigations and RSC fetches do not send that
 * header, so they keep hitting the Providers page.
 */
const GATEWAY_URL = (process.env.GATEWAY_URL ?? "http://localhost:3000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // The repo root has its own package-lock.json (the gateway), so Next's
    // lockfile detection would otherwise pick the root as the workspace root.
    // Pin it to web/ so only this app is watched (silences the dual-lockfile
    // warning and keeps the watcher narrow).
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/providers",
          has: [{ type: "header", key: "accept", value: ".*application/json.*" }],
          destination: `${GATEWAY_URL}/providers`,
        },
      ],
      afterFiles: [
        { source: "/health", destination: `${GATEWAY_URL}/health` },
        { source: "/metrics", destination: `${GATEWAY_URL}/metrics` },
        { source: "/v1/:path*", destination: `${GATEWAY_URL}/v1/:path*` },
      ],
    };
  },
};

export default nextConfig;
