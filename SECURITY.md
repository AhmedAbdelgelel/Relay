# Security policy

Relay is an OpenAI-compatible LLM gateway that sits between callers and provider APIs. This document states what the gateway protects, what it deliberately does **not** protect, and how to deploy it safely. It is also the threat model reviewers should read before exposing an instance.

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest commit) | ✅ security fixes land here |
| older commits / forks | ❌ no backports |

There are no tagged releases yet. Report issues against `main`.

## Reporting a vulnerability

Please use **GitHub Security Advisories** (repository → *Security* → *Report a vulnerability*) rather than a public issue for anything that could lead to key disclosure, cache cross-talk, or a request escaping its tenant. Include a minimal reproduction, the affected endpoint/header, and the commit you tested. We aim to confirm within 7 days and to ship a fix or a documented mitigation before any public write-up.

## Security model in one page

### Two lanes, one chat endpoint

| Lane | Credential | Cache | Accounting |
|---|---|---|---|
| **registered** | `Authorization: Bearer lg_…` (or `x-api-key`) | full exact + semantic pipeline | per-tenant usage |
| **anonymous try-out** | `x-provider-key: <your upstream key>` | always `BYPASS` (never reads or writes) | global counters only |
| no credential | — | — | `401` before validation/spend |

- Lane selection happens in a `preHandler` **before** body validation, provider dispatch and any cache lookup — an unauthenticated request cannot spend a provider call or touch cache state.
- A gateway key is bound to one provider. A request routed to a different provider is `403` unless the tenant has stored a credential for that provider via `POST /v1/connections` (bring-your-own key). Operator env keys are never used for a tenant whose binding does not match.
- The anonymous lane forwards **only** the presented `x-provider-key`; it can never borrow the operator's provider keys.
- `x-tenant-id` is ignored everywhere. Tenant identity comes only from the verified gateway key.

### Key material

- Gateway keys are `lg_` + 32 random bytes (base64url). Only the SHA-256 hex digest is stored; plaintext is returned once at `POST /v1/register`. Prefix (`lg_xxxxx`) is metadata.
- Provider credentials are encrypted with **AES-256-GCM** (12-byte IV, 16-byte tag, `v1:` envelope); the key is `sha256(CRED_ENC_KEY)`. They are never returned by any API — `GET /v1/connections` exposes metadata only.
- Stored credentials that cannot be decrypted (e.g. `CRED_ENC_KEY` rotated) degrade to "unavailable"; they do not crash requests.
- Keys never appear in `/health`, `/providers`, `/metrics`, `/v1/usage`, logs, or error bodies. Provider error snippets are truncated to 300 chars.
- Prompts and completions are not logged. Cached answers *are* stored (see data handling below).

### Cache boundaries

- **Semantic cache** rows are scoped by `(tenant_id, provider, model)` and re-checked by the pure policy function: provider, tenant, model, temperature, `max_tokens`, system-prompt fingerprint, policy version and similarity threshold. A row from another tenant is never served.
- **Exact cache** identity is `(serving provider, canonical request)` and is intentionally **not tenant-scoped** — two tenants asking byte-identical questions share the normalized answer. This is a documented product decision; if your deployment requires per-tenant exact isolation, scope the key with the tenant before exposing it (a code change, not a config flag).
- Anonymous traffic never reads or writes either cache. Streaming (`stream:true`) bypasses both caches by design.
- Only successful, non-empty normalized responses are admitted; provider errors and empty completions are never cached.

### Multi-tenancy and usage

- `/v1/usage` returns only the caller's tenant slice. `/metrics` is a global, unauthenticated process snapshot and contains no per-tenant rows or key material.
- A request is attributed to the tenant of its verified gateway key only. There is no admin endpoint in this repo.

## Known security limitations (read before exposing)

1. **No rate limits, quotas or abuse controls.** Registration is open (`POST /v1/register`) and anyone who can reach the gateway can mint keys, store credentials (bounded only by memory/DB growth) and consume provider budget. Put the gateway behind an authenticated reverse proxy/WAF or add rate limiting at the edge before making it public.
2. **The anonymous lane can be used as a proxy** for any provider key the caller presents. That is the feature (try-out), but it means a public anonymous lane lets anyone make provider calls from your egress IP with their own key. Restrict or disable it at the edge if that is not acceptable.
3. **BYO base URL is an SSRF surface.** `POST /v1/register` and `/v1/connections` accept an `http(s)` `base_url` (validated for scheme/length only, including `localhost`/private ranges) because self-hosted/proxied providers are legitimate. A tenant can make the gateway POST to an arbitrary HTTP(S) host with the tenant's key. If that is too broad, restrict `base_url` to an allow-list or drop private ranges at the route boundary.
4. **Prompt/answer data is stored in caches.** Exact-cache blobs and pgvector rows contain normalized answer text, and semantic rows also contain the prompt text. Treat the cache backends (Redis, PostgreSQL) as sensitive data stores: TLS, private networking, access control, backups and retention apply.
5. **Exact cache is cross-tenant by design** (above). If two tenants' prompts must never share an answer, this needs a code change.
6. **Secrets in environment variables.** `CRED_ENC_KEY`, provider keys, `DATABASE_URL` (with password) and `REDIS_URL` (with password) are process env. Use your platform's secret store; never commit `.env`. The repository's `.gitignore` excludes `.env*`, `.cache/`, `dist/`, `node_modules/`.
7. **No MFA/roles on the control plane UI.** The Next.js app is a convenience client; the gateway remains the enforcement point. If you expose the UI publicly, protect it (Entra ID / reverse-proxy auth) and keep the gateway internal.
8. **In-memory defaults are not durable.** Without `DATABASE_URL` + `CRED_ENC_KEY`, gateway keys and provider credentials live in process memory and disappear on restart. For production, use PostgreSQL and Redis (TLS).
9. **Upstream calls use the platform TLS stack.** Provider certificates are validated by Node; there is no pinning or mTLS to providers. Use `https`/`rediss`/`sslmode=require` for all backing services.

## Deployment hardening checklist

- [ ] Terminate TLS at the edge (reverse proxy, load balancer, or the platform's ingress) — never expose the gateway over plain HTTP outside a private network.
- [ ] Gateway ingress **internal/private**; only the Next.js web app exposed, or put both behind an authenticated gateway/WAF.
- [ ] `CRED_ENC_KEY` is a long random secret (32+ bytes), stored in your platform's secret store / Docker secrets, never in the image or repo.
- [ ] PostgreSQL: `sslmode=require`, private network or narrow firewall; pgvector extension allow-listed; least-privilege database user (schema owner only).
- [ ] Redis: TLS (`rediss://`) with auth; private network; no public port.
- [ ] `GATEWAY_API_KEYS` only for dev/bootstrap; production keys via `POST /v1/register` (hashed at rest) and revoke/rotate through the store.
- [ ] Rotate provider keys by reconnecting (`POST /v1/connections` upserts); rotate gateway keys with the store's `rotate()` (plaintext shown once).
- [ ] Rotating `CRED_ENC_KEY` invalidates stored provider credentials by design — reconnect tenants after rotation.
- [ ] Set `CACHE_ENABLED` / `SEMANTIC_ENABLED` deliberately; streaming intentionally bypasses caches.
- [ ] Keep `UPSTREAM_TIMEOUT_MS` bounded (default 25 s) and pin `OPENROUTER_MODEL`/provider models to what you actually use (free model ids churn upstream).
- [ ] Add upstream egress restrictions if you must control which provider hosts are reachable.
- [ ] Monitor `auth_rejects_total`, `cache_lookup_failed`, `semantic_errors`, `breaker_open`; alert on 5xx spikes.
- [ ] Schedule retention/purge for `semantic_cache` (logical TTL is enforced on read; expired rows are not deleted automatically yet).
- [ ] Back up PostgreSQL if it holds credentials; test restore. Redis is a cache — losing it must not break correctness (it degrades to MISS).
- [ ] Run the gateway image as non-root (it is by default) and keep `/health` probing enabled in the orchestrator.

## What is out of scope for the gateway

- **Prompt injection / model output safety** — the gateway routes and caches model calls; it does not filter or judge model content. Do that in your application.
- **Tenant authentication strength** — a gateway key is a bearer credential; if it leaks, the holder can use that tenant's provider credential and cache until revoked. Use TLS, short-lived keys (set `expires_at` when creating) and revocation.
- **Provider-side data retention** — prompts forwarded upstream are subject to the provider's policy. Choose providers accordingly.
- **Denial of service protection** — no rate limiting/quotas; use network edge controls.

## Incident response quick guide

1. Revoke the affected gateway key (store `revoke(id)` / mark `revoked_at`) — future requests get `403`.
2. Reconnect the tenant's provider credential (`POST /v1/connections`) to replace a leaked upstream key, then rotate it with the provider.
3. If `CRED_ENC_KEY` or the database leaked: rotate `CRED_ENC_KEY`, reconnect all credentials, rotate DB credentials, and treat cached prompt/answer rows as exposed.
4. Flush cache backends if cache poisoning is suspected (`CACHE_ENABLED=false` / Redis flush); correctness degrades to MISS, never wrong reuse.
5. Audit logs for request IDs, statuses and provider names; there is no prompt text in logs by design.
