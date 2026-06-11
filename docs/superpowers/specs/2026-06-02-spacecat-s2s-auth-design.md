# SpaceCat S2S Authentication — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)
**Author:** paraschi

## Problem

Legacy SpaceCat API keys are deprecated and support is removed on **2026-04-15**.
We must migrate to Adobe IMS OAuth Server-to-Server (S2S) authentication
("Mysticat"). The dashboard authenticates to SpaceCat in three places, all of
which currently send a single bearer/`x-api-key` token:

1. `server/spacecat-proxy.ts` — the CORS proxy the browser uses (env `SPACECAT_API_KEY`).
2. `server/auto-evaluate/spacecat-client.ts` — the cron auto-evaluation client (env `SPACECAT_API_KEY`).
3. `src/features/off-site-dashboard/api.ts` — the browser, using a user-pasted key for direct calls.

## Core constraint

The S2S `client_secret` **must never reach the browser**. Token minting therefore
moves entirely server-side. The browser keeps its user-pasted-key path only as a
**legacy fallback** and otherwise routes through the server proxy, which now mints
S2S tokens. No secret is ever sent to client JS.

## S2S flow (from the consumer integration guide + provisioned config)

```
client_id + client_secret
  → POST {IMS_ENDPOINT}/ims/token/v3   (grant_type=client_credentials)  → IMS access token (24h)
  → POST {host}/api/v1/auth/s2s/login  (Bearer IMS token, body {imsOrgId})→ session token (15m)
  → GET/PATCH {host}/api/v1/...        (Bearer session token)            → API responses
```

- **Host (LLMO consumer):** `https://llmo.experiencecloud.live` (prod) /
  `https://llmo.experiencecloud.page` (dev). Replaces the current
  `spacecat.experiencecloud.live`.
- **IMS endpoint (provisioned):** `https://ims-na1.adobelogin.com`.
- **Scope (provisioned, source of truth — differs from guide examples):**
  `aem.adobe.service,openid,AdobeID,additional_info,additional_info.projectedProductContext,aem.sites,aem.assets.author,aem.assets.delivery,aem.contentai,aem.folders,aem.fragments.management,aem.repository,read_organizations`
- **Org scope:** single `IMS_SP_ORG_ID` (`...@AdobeOrg`). One session token serves
  the org. Exchange body also supports `baseURL` per the "org_id OR baseURL" note;
  the cache keys by scope so per-site exchange is additive later.

## Architecture (Approach A — shared module)

A new `server/auth/spacecat-s2s.ts` owns the entire two-hop flow and caching.
Both server consumers (`spacecat-proxy.ts`, `auto-evaluate/spacecat-client.ts`)
import it. Chosen over duplicating the logic per-consumer (security-sensitive
code shouldn't drift; the flow has no browser deps) and over a browser
token-vending endpoint (would leak 15-min tokens to client JS).

### Components

**`server/auth/spacecat-s2s.ts`**

| Export | Behavior |
|--------|----------|
| `isS2SConfigured(env)` | `true` when `IMS_SP_CLIENT_ID` + `IMS_SP_CLIENT_SECRET` are set. Drives fallback selection. |
| `getImsAccessToken(env)` | POST `${IMS_ENDPOINT}/ims/token/v3`, `application/x-www-form-urlencoded`, body `grant_type=client_credentials&client_id&client_secret&scope[&resource]`. Module-cached 24h, **5-min** refresh buffer. |
| `getSessionToken(env)` | POST login URL with `Authorization: Bearer <imsToken>` + JSON `{ imsOrgId }`. Returns `sessionToken`. Module-cached 15m, **2-min** buffer, keyed by scope. |
| `getSpacecatAuthHeaders(env)` | Returns `{ authorization: 'Bearer <sessionToken>' }`. On a caller-reported 401, clears both caches and re-mints **once**. |

Caching is module-level (warm-Lambda lifetime), matching the guide's serverless note.

**`server/spacecat-proxy.ts`** — `getSpacecatProxyConfig.configured` becomes
`isS2SConfigured(env) || Boolean(SPACECAT_API_KEY)`. The request handler builds
upstream auth via `getSpacecatAuthHeaders` when S2S is configured, else the legacy
`Bearer + x-api-key`. Adds a single 401 re-mint+retry on the S2S path.
`isAllowedTargetUrl` tightens to the LLMO origin automatically via the new default.

**`server/auto-evaluate/spacecat-client.ts`** — `spacecatRequest` accepts `env`
and builds headers via the shared module (S2S preferred, legacy fallback), with the
same 401 handling. `getCredentials` no longer hard-fails on missing
`SPACECAT_API_KEY` when S2S is configured.

**Base URL defaults** — `DEFAULT_API_BASE_URL` (`constants.ts`), proxy default, and
auto-eval default change to `https://llmo.experiencecloud.live/api/v1`, still
overridable via `SPACECAT_API_BASE_URL`. Login URL defaults to
`<api-base-origin>/api/v1/auth/s2s/login`, overridable via `SPACECAT_S2S_LOGIN_URL`.

**Frontend** — minimal. Keep the user-pasted-key field (legacy fallback). Because
S2S makes the proxy report `configured: true`, the browser transparently routes
through the proxy and never holds a secret. Add a short "auth managed server-side"
note near the key field.

### Environment variables (new)

```bash
IMS_ENDPOINT=https://ims-na1.adobelogin.com
IMS_SP_CLIENT_ID=aem-sites-mystique
IMS_SP_CLIENT_SECRET=...            # secret — env/Vercel only, never committed; ROTATE (leaked in chat)
IMS_SP_ORG_ID=...@AdobeOrg
IMS_SP_SCOPE=aem.adobe.service,openid,AdobeID,...   # full provisioned scope
IMS_SP_RESOURCE=                    # optional; only if USE_SP_RESOURCE_PARAM flow needs `resource=`
SPACECAT_S2S_LOGIN_URL=             # optional override of the login endpoint
SPACECAT_API_BASE_URL=https://llmo.experiencecloud.live/api/v1   # optional override
SPACECAT_API_KEY=                   # legacy fallback only; remove after 2026-04-15
```

## Error handling

- Missing config: proxy returns 503 (as today); cron client throws a clear message.
- IMS / login failure: surfaced with HTTP status + truncated upstream body.
- 401 on an API call: one transparent cache-clear + re-mint, then propagate.

## Testing

Repo has no test harness (TS strict at build time only).

1. **Pure cache/buffer unit check** (no network): verify a cached token within its
   buffer is reused and that an expired/near-expiry token triggers a re-mint.
   Written test-first.
2. **One-shot manual `node` script**: run IMS → login → `GET /sites` against the
   live env to prove the flow and resolve the two open items below, before wiring
   the consumers.

## Open items (resolve during the manual-flow test step)

- **`USE_SP_RESOURCE_PARAM`**: not in the guide. Implement `IMS_SP_RESOURCE` as an
  optional `resource=` param on the IMS token request, default off; confirm value
  against the live flow.
- **Login path**: guide says `/auth/s2s/login`; the E2E note said `/auth/login`.
  Default to the guide's, env-overridable.
- **Single-org coverage**: if a tracked site lives under a different org and
  401/403s, switch that exchange to per-site `baseURL` (cache already keyed by scope).

## Legacy deprecation

Keep the legacy `Bearer + x-api-key` path as a fallback until **2026-04-15**, then
remove it (tracked as a cleanup item with that date).

## Out of scope

- No new browser-facing auth endpoints (no token vending).
- No refactor of the auto-eval client's deliberate duplication beyond auth.
- No change to evaluation logic, KV, or GitHub notification paths.
