# SpaceCat S2S Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deprecated SpaceCat legacy API key with Adobe IMS Server-to-Service (S2S) authentication across both server consumers, keeping the legacy key as a fallback until 2026-04-15.

**Architecture:** A single shared module `server/auth/spacecat-s2s.ts` owns the two-hop token flow (IMS access token → SpaceCat session token) with module-level caching. The proxy (`server/spacecat-proxy.ts`) and the cron client (`server/auto-evaluate/spacecat-client.ts`) call it for auth headers, falling back to the legacy `Bearer + x-api-key` when S2S is not configured. The `client_secret` never reaches the browser. All network/time access is injected as dependencies so the module is unit-testable without a mocking library.

**Tech Stack:** TypeScript (strict), Node ≥ 20 (`fetch`, `Response`, `URLSearchParams`, `--env-file`, `node:test` all built in), `tsx` (dev-only, to run `.ts` under Node's test runner and the verify script), Vite middleware (dev) + Vercel functions (prod).

---

## Spec reference

Design: `docs/superpowers/specs/2026-06-02-spacecat-s2s-auth-design.md`

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `server/auth/spacecat-s2s.ts` | The S2S flow + caching + config gate | Create |
| `server/auth/spacecat-s2s.test.ts` | Unit tests (injected fetch/now) | Create |
| `scripts/verify-s2s.ts` | One-shot live IMS→login→GET /sites check | Create |
| `.env.example` | Documented env var template (no secrets) | Create |
| `package.json` | Add `tsx` dev dep + `test:s2s` / `verify:s2s` scripts | Modify |
| `server/spacecat-proxy.ts` | Use S2S headers when configured; LLMO default base URL | Modify |
| `vite.config.ts` | Forward `IMS_SP_*` env to the dev-middleware proxy | Modify |
| `server/auto-evaluate/spacecat-client.ts` | Use S2S headers when configured; LLMO default base URL | Modify |
| `src/features/off-site-dashboard/constants.ts` | LLMO default base URL | Modify |
| `src/features/off-site-dashboard/OffSiteDashboard.tsx` | "auth managed server-side" note | Modify |
| `api/spacecat.ts` | Forward `IMS_SP_*` env to the prod proxy | Modify |
| `api/spacecat-config.ts` | Forward `IMS_SP_*` env to the prod config endpoint | Modify |
| `CLAUDE.md` | Document new env vars + deprecation | Modify |

---

## Task 1: Tooling — add `tsx` and npm scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install tsx as a dev dependency**

Run:
```bash
npm install -D tsx@^4
```
Expected: `tsx` appears under `devDependencies`, lockfile updated.

- [ ] **Step 2: Add the two scripts**

Edit `package.json` `"scripts"` to add `test:s2s` and `verify:s2s` (keep existing scripts):

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test:s2s": "node --import tsx --test server/auth/spacecat-s2s.test.ts",
    "verify:s2s": "node --env-file=.env --import tsx scripts/verify-s2s.ts"
  },
```

- [ ] **Step 3: Verify tsx runs TypeScript**

Run:
```bash
node --import tsx --eval "console.log('tsx ok')"
```
Expected: prints `tsx ok` with no error.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(auth): add tsx dev dep and s2s test/verify scripts"
```

---

## Task 2: Token-freshness helper (pure, TDD)

**Files:**
- Create: `server/auth/spacecat-s2s.ts`
- Test: `server/auth/spacecat-s2s.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/auth/spacecat-s2s.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTokenFresh } from './spacecat-s2s.js';

test('isTokenFresh: null expiry is never fresh', () => {
  assert.equal(isTokenFresh(null, 1000, 0), false);
});

test('isTokenFresh: fresh when now is before expiry minus buffer', () => {
  // expires at 10_000, 1s buffer → fresh until 9_000
  assert.equal(isTokenFresh(10_000, 1_000, 8_999), true);
});

test('isTokenFresh: stale once inside the buffer window', () => {
  assert.equal(isTokenFresh(10_000, 1_000, 9_000), false);
  assert.equal(isTokenFresh(10_000, 1_000, 9_500), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:s2s`
Expected: FAIL — cannot find module `./spacecat-s2s.ts` (or `isTokenFresh` is not exported).

- [ ] **Step 3: Create the module with the helper**

Create `server/auth/spacecat-s2s.ts`:

```ts
// Shared Adobe IMS Server-to-Service (S2S) auth for SpaceCat.
//
// Flow: client_credentials -> IMS access token (24h) -> SpaceCat session
// token (15m) -> Authorization: Bearer <session token> on API calls.
// The client_secret stays server-side and is never sent to the browser.

export type SpacecatS2SEnv = {
  IMS_ENDPOINT?: string;
  IMS_SP_CLIENT_ID?: string;
  IMS_SP_CLIENT_SECRET?: string;
  IMS_SP_ORG_ID?: string;
  IMS_SP_SCOPE?: string;
  IMS_SP_RESOURCE?: string;
  SPACECAT_S2S_LOGIN_URL?: string;
  SPACECAT_API_BASE_URL?: string;
};

/** True when `now` is before the token's expiry minus the safety buffer. */
export function isTokenFresh(
  expiresAt: number | null,
  bufferMs: number,
  now: number,
): boolean {
  return expiresAt !== null && now < expiresAt - bufferMs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:s2s`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/auth/spacecat-s2s.ts server/auth/spacecat-s2s.test.ts
git commit -m "feat(auth): add S2S token-freshness helper"
```

---

## Task 3: IMS access token mint + cache (TDD)

**Files:**
- Modify: `server/auth/spacecat-s2s.ts`
- Test: `server/auth/spacecat-s2s.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `server/auth/spacecat-s2s.test.ts`:

```ts
import {
  getImsAccessToken,
  resetS2SCache,
  type Deps,
} from './spacecat-s2s.js';

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch: no response queued');
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const baseEnv = {
  IMS_ENDPOINT: 'https://ims.test',
  IMS_SP_CLIENT_ID: 'cid',
  IMS_SP_CLIENT_SECRET: 'secret',
  IMS_SP_ORG_ID: 'ORG@AdobeOrg',
  IMS_SP_SCOPE: 'openid,AdobeID',
};

test('getImsAccessToken: mints, posts form body, caches', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([{ body: { access_token: 'ims-1', expires_in: 86399 } }]);
  const deps: Deps = { fetch: impl, now: () => 0 };

  const first = await getImsAccessToken(baseEnv, deps);
  const second = await getImsAccessToken(baseEnv, deps);

  assert.equal(first, 'ims-1');
  assert.equal(second, 'ims-1');
  assert.equal(calls.length, 1, 'second call should hit cache');
  assert.equal(calls[0].url, 'https://ims.test/ims/token/v3');
  const body = String(calls[0].init?.body);
  assert.match(body, /grant_type=client_credentials/);
  assert.match(body, /client_id=cid/);
  assert.match(body, /scope=openid%2CAdobeID/);
  assert.doesNotMatch(body, /resource=/);
});

test('getImsAccessToken: includes resource when IMS_SP_RESOURCE set', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([{ body: { access_token: 'ims-1', expires_in: 86399 } }]);
  await getImsAccessToken({ ...baseEnv, IMS_SP_RESOURCE: 'res-1' }, { fetch: impl, now: () => 0 });
  assert.match(String(calls[0].init?.body), /resource=res-1/);
});

test('getImsAccessToken: re-mints once inside the 5-min buffer', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 600 } }, // expires at now+600s
    { body: { access_token: 'ims-2', expires_in: 600 } },
  ]);
  let clock = 0;
  const deps: Deps = { fetch: impl, now: () => clock };
  await getImsAccessToken(baseEnv, deps);
  clock = 600_000 - 4 * 60_000; // 4 min before expiry → inside 5-min buffer
  const second = await getImsAccessToken(baseEnv, deps);
  assert.equal(second, 'ims-2');
  assert.equal(calls.length, 2);
});

test('getImsAccessToken: throws with status on non-ok', async () => {
  resetS2SCache();
  const { impl } = fakeFetch([{ status: 401, body: { error: 'bad creds' } }]);
  await assert.rejects(
    () => getImsAccessToken(baseEnv, { fetch: impl, now: () => 0 }),
    /IMS token request failed: 401/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:s2s`
Expected: FAIL — `getImsAccessToken` / `resetS2SCache` / `Deps` not exported.

- [ ] **Step 3: Implement IMS minting + cache**

Append to `server/auth/spacecat-s2s.ts` (after `isTokenFresh`):

```ts
const DEFAULT_IMS_ENDPOINT = 'https://ims-na1.adobelogin.com';
const DEFAULT_API_BASE_URL = 'https://llmo.experiencecloud.live/api/v1';

const IMS_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000; // used only if expires_in absent
const IMS_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_REFRESH_BUFFER_MS = 2 * 60 * 1000;

export type Deps = {
  fetch: typeof fetch;
  now: () => number;
};

const defaultDeps: Deps = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
};

// Module-level caches (warm-Lambda lifetime). See spec: serverless note.
let imsToken: string | null = null;
let imsExpiresAt: number | null = null;
let sessionToken: string | null = null;
let sessionExpiresAt: number | null = null;
let sessionScopeKey: string | null = null;

/** Clear all cached tokens. Call after a 401 before re-minting. */
export function resetS2SCache(): void {
  imsToken = null;
  imsExpiresAt = null;
  sessionToken = null;
  sessionExpiresAt = null;
  sessionScopeKey = null;
}

/** True when S2S credentials are present (drives legacy fallback). */
export function isS2SConfigured(env: SpacecatS2SEnv): boolean {
  return Boolean(env.IMS_SP_CLIENT_ID?.trim() && env.IMS_SP_CLIENT_SECRET?.trim());
}

export async function getImsAccessToken(
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<string> {
  if (imsToken && isTokenFresh(imsExpiresAt, IMS_REFRESH_BUFFER_MS, deps.now())) {
    return imsToken;
  }
  const endpoint = (env.IMS_ENDPOINT?.trim() || DEFAULT_IMS_ENDPOINT).replace(/\/+$/, '');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.IMS_SP_CLIENT_ID?.trim() ?? '',
    client_secret: env.IMS_SP_CLIENT_SECRET?.trim() ?? '',
    scope: env.IMS_SP_SCOPE?.trim() ?? '',
  });
  if (env.IMS_SP_RESOURCE?.trim()) {
    body.set('resource', env.IMS_SP_RESOURCE.trim());
  }

  const response = await deps.fetch(`${endpoint}/ims/token/v3`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `IMS token request failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as { access_token: string; expires_in?: number };
  imsToken = json.access_token;
  const ttlMs = json.expires_in ? json.expires_in * 1000 : IMS_FALLBACK_TTL_MS;
  imsExpiresAt = deps.now() + ttlMs;
  return imsToken;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:s2s`
Expected: PASS — all IMS tests green.

- [ ] **Step 5: Commit**

```bash
git add server/auth/spacecat-s2s.ts server/auth/spacecat-s2s.test.ts
git commit -m "feat(auth): mint and cache IMS access token"
```

---

## Task 4: SpaceCat session token exchange + cache (TDD)

**Files:**
- Modify: `server/auth/spacecat-s2s.ts`
- Test: `server/auth/spacecat-s2s.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `server/auth/spacecat-s2s.test.ts`:

```ts
import { getSessionToken } from './spacecat-s2s.js';

test('getSessionToken: exchanges IMS token, posts imsOrgId, caches', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 86399 } }, // IMS
    { body: { sessionToken: 'sess-1' } },                   // login
  ]);
  const deps: Deps = { fetch: impl, now: () => 0 };

  const first = await getSessionToken(baseEnv, deps);
  const second = await getSessionToken(baseEnv, deps);

  assert.equal(first, 'sess-1');
  assert.equal(second, 'sess-1');
  assert.equal(calls.length, 2, 'second call should reuse both caches');
  // login call assertions
  assert.equal(calls[1].url, 'https://llmo.experiencecloud.live/api/v1/auth/s2s/login');
  const headers = calls[1].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer ims-1');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { imsOrgId: 'ORG@AdobeOrg' });
});

test('getSessionToken: honors SPACECAT_S2S_LOGIN_URL override', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 86399 } },
    { body: { sessionToken: 'sess-1' } },
  ]);
  await getSessionToken(
    { ...baseEnv, SPACECAT_S2S_LOGIN_URL: 'https://override.test/login' },
    { fetch: impl, now: () => 0 },
  );
  assert.equal(calls[1].url, 'https://override.test/login');
});

test('getSessionToken: derives login URL from SPACECAT_API_BASE_URL', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 86399 } },
    { body: { sessionToken: 'sess-1' } },
  ]);
  await getSessionToken(
    { ...baseEnv, SPACECAT_API_BASE_URL: 'https://llmo.experiencecloud.page/api/ci' },
    { fetch: impl, now: () => 0 },
  );
  assert.equal(calls[1].url, 'https://llmo.experiencecloud.page/api/ci/auth/s2s/login');
});

test('getSessionToken: throws with status on non-ok login', async () => {
  resetS2SCache();
  const { impl } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 86399 } },
    { status: 403, body: { error: 'no entitlement' } },
  ]);
  await assert.rejects(
    () => getSessionToken(baseEnv, { fetch: impl, now: () => 0 }),
    /SpaceCat session login failed: 403/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:s2s`
Expected: FAIL — `getSessionToken` not exported.

- [ ] **Step 3: Implement the exchange**

Append to `server/auth/spacecat-s2s.ts`:

```ts
function resolveLoginUrl(env: SpacecatS2SEnv): string {
  if (env.SPACECAT_S2S_LOGIN_URL?.trim()) {
    return env.SPACECAT_S2S_LOGIN_URL.trim();
  }
  const base = (env.SPACECAT_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  return `${base}/auth/s2s/login`;
}

export async function getSessionToken(
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<string> {
  const scopeKey = env.IMS_SP_ORG_ID?.trim() ?? '';
  if (
    sessionToken &&
    sessionScopeKey === scopeKey &&
    isTokenFresh(sessionExpiresAt, SESSION_REFRESH_BUFFER_MS, deps.now())
  ) {
    return sessionToken;
  }

  const ims = await getImsAccessToken(env, deps);
  const response = await deps.fetch(resolveLoginUrl(env), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ims}`,
    },
    body: JSON.stringify({ imsOrgId: scopeKey }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `SpaceCat session login failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as { sessionToken: string };
  sessionToken = json.sessionToken;
  sessionExpiresAt = deps.now() + SESSION_TTL_MS;
  sessionScopeKey = scopeKey;
  return sessionToken;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:s2s`
Expected: PASS — all session tests green.

- [ ] **Step 5: Commit**

```bash
git add server/auth/spacecat-s2s.ts server/auth/spacecat-s2s.test.ts
git commit -m "feat(auth): exchange IMS token for SpaceCat session token"
```

---

## Task 5: Auth headers + config gate (TDD)

**Files:**
- Modify: `server/auth/spacecat-s2s.ts`
- Test: `server/auth/spacecat-s2s.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `server/auth/spacecat-s2s.test.ts`:

```ts
import { getSpacecatAuthHeaders, isS2SConfigured } from './spacecat-s2s.js';

test('isS2SConfigured: true only with id and secret', () => {
  assert.equal(isS2SConfigured({}), false);
  assert.equal(isS2SConfigured({ IMS_SP_CLIENT_ID: 'cid' }), false);
  assert.equal(isS2SConfigured(baseEnv), true);
});

test('getSpacecatAuthHeaders: returns bearer of session token', async () => {
  resetS2SCache();
  const { impl } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 86399 } },
    { body: { sessionToken: 'sess-1' } },
  ]);
  const headers = await getSpacecatAuthHeaders(baseEnv, { fetch: impl, now: () => 0 });
  assert.deepEqual(headers, { authorization: 'Bearer sess-1' });
});

test('resetS2SCache: forces a fresh mint', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([
    { body: { access_token: 'ims-1', expires_in: 86399 } },
    { body: { sessionToken: 'sess-1' } },
    { body: { access_token: 'ims-2', expires_in: 86399 } },
    { body: { sessionToken: 'sess-2' } },
  ]);
  const deps: Deps = { fetch: impl, now: () => 0 };
  const a = await getSpacecatAuthHeaders(baseEnv, deps);
  resetS2SCache();
  const b = await getSpacecatAuthHeaders(baseEnv, deps);
  assert.deepEqual(a, { authorization: 'Bearer sess-1' });
  assert.deepEqual(b, { authorization: 'Bearer sess-2' });
  assert.equal(calls.length, 4);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:s2s`
Expected: FAIL — `getSpacecatAuthHeaders` not exported.

- [ ] **Step 3: Implement the header helper**

Append to `server/auth/spacecat-s2s.ts`:

```ts
/**
 * Auth header for SpaceCat API calls. On a 401, the caller should
 * `resetS2SCache()` and call this again once before propagating.
 */
export async function getSpacecatAuthHeaders(
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<Record<string, string>> {
  const token = await getSessionToken(env, deps);
  return { authorization: `Bearer ${token}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:s2s`
Expected: PASS — full suite green.

- [ ] **Step 5: Type-check the module standalone**

`server/` is NOT in `tsconfig.json` (`include: ["src"]`), so `npm run build` does
not check it. The module has no sibling imports, so check it directly:

Run:
```bash
npx tsc --noEmit --strict --target ES2020 --module ESNext \
  --moduleResolution node --lib ES2020,DOM --skipLibCheck \
  server/auth/spacecat-s2s.ts
```
Expected: no output (clean). Fix any reported type errors before committing.

- [ ] **Step 6: Commit**

```bash
git add server/auth/spacecat-s2s.ts server/auth/spacecat-s2s.test.ts
git commit -m "feat(auth): add SpaceCat auth header helper and config gate"
```

---

## Task 6: Live verification script (resolves open items)

**Files:**
- Create: `scripts/verify-s2s.ts`
- Create: `.env.example`

- [ ] **Step 1: Create `.env.example`**

Create `.env.example`:

```bash
# --- SpaceCat S2S (Adobe IMS Server-to-Service) ---
IMS_ENDPOINT=https://ims-na1.adobelogin.com
IMS_SP_CLIENT_ID=aem-sites-mystique
IMS_SP_CLIENT_SECRET=__set_in_vercel_or_local_env_only__
IMS_SP_ORG_ID=XXXXXXXXXXXXXXXX@AdobeOrg
IMS_SP_SCOPE=aem.adobe.service,openid,AdobeID,additional_info,additional_info.projectedProductContext,aem.sites,aem.assets.author,aem.assets.delivery,aem.contentai,aem.folders,aem.fragments.management,aem.repository,read_organizations
# Optional: set only if the IMS token request requires a `resource` param (USE_SP_RESOURCE_PARAM)
IMS_SP_RESOURCE=
# Optional override of the session-login endpoint (defaults to <base>/auth/s2s/login)
SPACECAT_S2S_LOGIN_URL=
# LLMO host base URL (prod). Dev: https://llmo.experiencecloud.page/api/ci
SPACECAT_API_BASE_URL=https://llmo.experiencecloud.live/api/v1

# --- Legacy (fallback only; remove after 2026-04-15) ---
SPACECAT_API_KEY=
```

- [ ] **Step 2: Create the verify script**

Create `scripts/verify-s2s.ts`:

```ts
// One-shot live check: IMS token -> session token -> GET /sites.
// Run: npm run verify:s2s   (reads .env via --env-file)
import {
  getImsAccessToken,
  getSessionToken,
  getSpacecatAuthHeaders,
  isS2SConfigured,
} from '../server/auth/spacecat-s2s.js';

const env = process.env;

async function main() {
  if (!isS2SConfigured(env)) {
    throw new Error('S2S not configured: set IMS_SP_CLIENT_ID and IMS_SP_CLIENT_SECRET in .env');
  }
  const base = (env.SPACECAT_API_BASE_URL?.trim() || 'https://llmo.experiencecloud.live/api/v1').replace(/\/+$/, '');

  const ims = await getImsAccessToken(env);
  console.log('IMS token OK:', `${ims.slice(0, 12)}...`);

  const session = await getSessionToken(env);
  console.log('Session token OK:', `${session.slice(0, 12)}...`);

  const headers = await getSpacecatAuthHeaders(env);
  const res = await fetch(`${base}/sites`, { headers: { accept: 'application/json', ...headers } });
  console.log('GET /sites:', res.status, res.statusText);
  const text = await res.text();
  console.log('Body (first 300 chars):', text.slice(0, 300));
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('verify-s2s failed:', err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run against the live API**

Ensure `.env` has real credentials (copy from `.env.example`, fill values; never commit `.env`).
Run: `npm run verify:s2s`
Expected: `IMS token OK`, `Session token OK`, and `GET /sites: 200 OK`.

**Resolve the three open items here:**
- If the IMS step returns `400 invalid scope`/`resource` errors → set `IMS_SP_RESOURCE` (confirm value with the team) and re-run.
- If the login step 404s → the path is `/auth/login` not `/auth/s2s/login`; set `SPACECAT_S2S_LOGIN_URL` accordingly (and note it for a follow-up code default change).
- If `GET /sites` 401/403s for an org that should be visible → the org token doesn't cover that tenant; capture which sites fail (handled later via per-site `baseURL` exchange if needed).

- [ ] **Step 4: Commit (script + example only; never `.env`)**

```bash
git add scripts/verify-s2s.ts .env.example
git commit -m "chore(auth): add S2S live verification script and .env.example"
```

---

## Task 7: Wire the proxy to S2S

**Files:**
- Modify: `server/spacecat-proxy.ts`

- [ ] **Step 1: Import the S2S module and extend the env type**

In `server/spacecat-proxy.ts`, add the import at the top and extend `SpacecatProxyEnv`:

```ts
import {
  getSpacecatAuthHeaders,
  isS2SConfigured,
  resetS2SCache,
  type SpacecatS2SEnv,
} from './auth/spacecat-s2s.js';

export type SpacecatProxyEnv = SpacecatS2SEnv & {
  SPACECAT_API_KEY?: string;
  SPACECAT_API_BASE_URL?: string;
  APP_ALLOWED_ORIGINS?: string;
  CORS_ALLOWED_ORIGINS?: string;
};
```

- [ ] **Step 2: Switch the default base URL to LLMO**

Change the constant at the top of `server/spacecat-proxy.ts`:

```ts
const DEFAULT_SPACECAT_API_BASE_URL =
  'https://llmo.experiencecloud.live/api/v1';
```

- [ ] **Step 3: Make `configured` true when S2S OR legacy key is set**

Replace the body of `getSpacecatProxyConfig`:

```ts
export function getSpacecatProxyConfig(env: SpacecatProxyEnv = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(env.SPACECAT_API_BASE_URL);
  const hasLegacyKey = Boolean(env.SPACECAT_API_KEY?.trim());

  return {
    configured: isS2SConfigured(env) || hasLegacyKey,
    apiBaseUrl,
  };
}
```

- [ ] **Step 4: Add a header builder and 401-retry in the request handler**

Add this helper above `handleSpacecatProxyRequest`:

```ts
async function buildUpstreamHeaders(
  env: SpacecatProxyEnv,
  hasBody: boolean,
): Promise<Record<string, string>> {
  const base: Record<string, string> = { accept: 'application/json' };
  if (hasBody) base['content-type'] = 'application/json';
  if (isS2SConfigured(env)) {
    return { ...base, ...(await getSpacecatAuthHeaders(env)) };
  }
  const key = env.SPACECAT_API_KEY?.trim() ?? '';
  return { ...base, authorization: `Bearer ${key}`, 'x-api-key': key };
}
```

Then, inside `handleSpacecatProxyRequest`, replace the `try { const upstreamResponse = await fetch(...) ... }` block's fetch call. The new logic:

```ts
  // For mutating methods, forward the JSON request body upstream so the
  // backend can apply the partial update.
  const body = request.method === 'GET' ? undefined : await request.text();
  const hasBody = body !== undefined;

  try {
    let upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      cache: 'no-store',
      headers: await buildUpstreamHeaders(env, hasBody),
      body,
    });

    // S2S session tokens are short-lived; on 401, re-mint once and retry.
    if (upstreamResponse.status === 401 && isS2SConfigured(env)) {
      resetS2SCache();
      upstreamResponse = await fetch(targetUrl, {
        method: request.method,
        cache: 'no-store',
        headers: await buildUpstreamHeaders(env, hasBody),
        body,
      });
    }

    const responseBody = await upstreamResponse.text();
```

(Leave the rest of the response-building code below unchanged.)

- [ ] **Step 5: Update the not-configured error message**

In `handleSpacecatProxyRequest`, update the 503 message:

```ts
  if (!proxyConfig.configured) {
    return buildJsonResponse(
      {
        error:
          'SpaceCat auth is not configured on the server. Set IMS_SP_* (S2S) or SPACECAT_API_KEY.',
      },
      503,
    );
  }
```

- [ ] **Step 6: Forward S2S env in the Vite dev middleware**

`vite.config.ts` hand-picks env keys when calling the proxy handlers (just like
the Vercel wrappers), so dev would never see the S2S vars without this. There are
TWO inline env objects — one in the `/api/spacecat-config` block and one in the
`/api/spacecat` block. Update **both** identically.

Replace each occurrence of:

```ts
              {
                SPACECAT_API_KEY: env.SPACECAT_API_KEY,
                SPACECAT_API_BASE_URL: env.SPACECAT_API_BASE_URL,
              },
```

with:

```ts
              {
                SPACECAT_API_KEY: env.SPACECAT_API_KEY,
                SPACECAT_API_BASE_URL: env.SPACECAT_API_BASE_URL,
                IMS_ENDPOINT: env.IMS_ENDPOINT,
                IMS_SP_CLIENT_ID: env.IMS_SP_CLIENT_ID,
                IMS_SP_CLIENT_SECRET: env.IMS_SP_CLIENT_SECRET,
                IMS_SP_ORG_ID: env.IMS_SP_ORG_ID,
                IMS_SP_SCOPE: env.IMS_SP_SCOPE,
                IMS_SP_RESOURCE: env.IMS_SP_RESOURCE,
                SPACECAT_S2S_LOGIN_URL: env.SPACECAT_S2S_LOGIN_URL,
              },
```

(`loadEnv` is already called with an empty prefix in this file, so non-`VITE_`
vars from `.env` are present on `env`.)

- [ ] **Step 7: Regression-check the module + start the dev server**

`server/` is not type-checked by `npm run build`. Verify nothing broke and the
proxy boots:

Run: `npm run test:s2s`
Expected: PASS (module unchanged).

Run: `npm run dev` (in a separate shell), then confirm it starts with no error
loading `server/spacecat-proxy.ts` as middleware. Stop it after confirming.

- [ ] **Step 8: Commit**

```bash
git add server/spacecat-proxy.ts vite.config.ts
git commit -m "feat(auth): use S2S in spacecat proxy with legacy fallback"
```

---

## Task 8: Wire the auto-evaluate cron client to S2S

**Files:**
- Modify: `server/auto-evaluate/spacecat-client.ts`

- [ ] **Step 1: Import the module and extend env type + default base URL**

At the top of `server/auto-evaluate/spacecat-client.ts`, add the import and change the default:

```ts
import {
  getSpacecatAuthHeaders,
  isS2SConfigured,
  resetS2SCache,
  type SpacecatS2SEnv,
} from '../auth/spacecat-s2s.js';

const DEFAULT_SPACECAT_API_BASE_URL =
  'https://llmo.experiencecloud.live/api/v1';
```

Change the env type:

```ts
export type SpacecatClientEnv = SpacecatS2SEnv & {
  SPACECAT_API_KEY?: string;
  SPACECAT_API_BASE_URL?: string;
};
```

- [ ] **Step 2: Replace `getCredentials` with header building + base URL**

Replace the existing `getCredentials` function with:

```ts
function getBaseUrl(env: SpacecatClientEnv): string {
  return normalizeApiBaseUrl(env.SPACECAT_API_BASE_URL);
}

async function buildHeaders(
  env: SpacecatClientEnv,
): Promise<Record<string, string>> {
  if (isS2SConfigured(env)) {
    return { accept: 'application/json', ...(await getSpacecatAuthHeaders(env)) };
  }
  const apiKey = env.SPACECAT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'No SpaceCat auth configured. Set IMS_SP_* (S2S) or SPACECAT_API_KEY.',
    );
  }
  return { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
}
```

- [ ] **Step 3: Rewrite `spacecatRequest` to take `env` and handle 401**

Replace the `spacecatRequest` function with:

```ts
async function spacecatRequest<T>(
  url: string,
  env: SpacecatClientEnv,
): Promise<T> {
  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: await buildHeaders(env),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response = await doFetch();
  if (response.status === 401 && isS2SConfigured(env)) {
    resetS2SCache();
    response = await doFetch();
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `SpaceCat ${response.status} ${response.statusText} for ${url}: ${detail.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}
```

- [ ] **Step 4: Update all call sites**

In `server/auto-evaluate/spacecat-client.ts`, every place that currently reads
`const { apiKey, baseUrl } = getCredentials(env);` and later calls
`spacecatRequest(url, apiKey)` must change to use `getBaseUrl` and pass `env`:

```ts
  const baseUrl = getBaseUrl(env);
  // ...build url...
  const payload = await spacecatRequest<unknown>(url, env);
```

Find every site with:
```bash
grep -n "getCredentials\|spacecatRequest(" server/auto-evaluate/spacecat-client.ts
```
Replace each `getCredentials(env)` destructure with `const baseUrl = getBaseUrl(env);` (drop `apiKey`), and each `spacecatRequest<...>(url, apiKey)` with `spacecatRequest<...>(url, env)`.

- [ ] **Step 5: Check for leftover `apiKey` references + regression**

`server/` is not type-checked by `npm run build`, so grep for stragglers and
re-run the unit suite:

Run:
```bash
grep -n "apiKey\|getCredentials" server/auto-evaluate/spacecat-client.ts
```
Expected: no matches (every `apiKey`/`getCredentials` usage replaced by `env` / `getBaseUrl`).

Run: `npm run test:s2s`
Expected: PASS (module unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/auto-evaluate/spacecat-client.ts
git commit -m "feat(auth): use S2S in auto-evaluate client with legacy fallback"
```

---

## Task 9: Frontend default host + server-side-auth note

**Files:**
- Modify: `src/features/off-site-dashboard/constants.ts`
- Modify: `src/features/off-site-dashboard/OffSiteDashboard.tsx`

- [ ] **Step 1: Switch the frontend default base URL to LLMO**

In `src/features/off-site-dashboard/constants.ts`:

```ts
export const DEFAULT_API_BASE_URL =
  'https://llmo.experiencecloud.live/api/v1';
```

- [ ] **Step 2: Locate the API key input**

Run:
```bash
grep -n "apiKey\|API key\|API Key\|placeholder" src/features/off-site-dashboard/OffSiteDashboard.tsx | head -20
```
Identify the JSX label/help text around the API key `<input>`.

- [ ] **Step 3: Add a short note near the key field**

Immediately after the API key input's existing help/label text, add a hint (match surrounding JSX/class conventions; example using a plain element):

```tsx
<p className="field-hint">
  Optional. When the server is configured for S2S (Mysticat), authentication
  is handled server-side and this field can be left blank. The legacy API key
  is supported as a fallback until 2026-04-15.
</p>
```

If the file uses a specific hint component/class already (grep showed it), reuse that instead of `field-hint`.

- [ ] **Step 4: Type-check / build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/features/off-site-dashboard/constants.ts src/features/off-site-dashboard/OffSiteDashboard.tsx
git commit -m "feat(auth): default frontend to LLMO host; note server-side S2S"
```

---

## Task 10: Forward S2S env in Vercel wrappers + document env vars

**Files:**
- Modify: `api/spacecat.ts`
- Modify: `api/spacecat-config.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the S2S keys to `proxyEnv` in BOTH wrappers**

`api/spacecat.ts` and `api/spacecat-config.ts` each build `proxyEnv` from a fixed
list of keys (they do NOT pass full `process.env`), so the new S2S vars would
never reach the prod proxy without this change. In **both** files, extend the
`proxyEnv` object:

```ts
const proxyEnv = {
  SPACECAT_API_KEY: runtimeEnv.SPACECAT_API_KEY,
  SPACECAT_API_BASE_URL: runtimeEnv.SPACECAT_API_BASE_URL,
  APP_ALLOWED_ORIGINS: runtimeEnv.APP_ALLOWED_ORIGINS,
  CORS_ALLOWED_ORIGINS: runtimeEnv.CORS_ALLOWED_ORIGINS,
  IMS_ENDPOINT: runtimeEnv.IMS_ENDPOINT,
  IMS_SP_CLIENT_ID: runtimeEnv.IMS_SP_CLIENT_ID,
  IMS_SP_CLIENT_SECRET: runtimeEnv.IMS_SP_CLIENT_SECRET,
  IMS_SP_ORG_ID: runtimeEnv.IMS_SP_ORG_ID,
  IMS_SP_SCOPE: runtimeEnv.IMS_SP_SCOPE,
  IMS_SP_RESOURCE: runtimeEnv.IMS_SP_RESOURCE,
  SPACECAT_S2S_LOGIN_URL: runtimeEnv.SPACECAT_S2S_LOGIN_URL,
};
```

- [ ] **Step 2: Update the CLAUDE.md environment section**

In `CLAUDE.md`, under "Environment Variables", replace the SpaceCat auth guidance. Add this block (keep the surrounding sections):

````markdown
# SpaceCat auth — S2S (Adobe IMS Server-to-Service), preferred:
IMS_ENDPOINT=https://ims-na1.adobelogin.com
IMS_SP_CLIENT_ID=aem-sites-mystique
IMS_SP_CLIENT_SECRET=...            # secret — Vercel/local env only, never commit
IMS_SP_ORG_ID=...@AdobeOrg
IMS_SP_SCOPE=aem.adobe.service,openid,AdobeID,...   # full provisioned scope
IMS_SP_RESOURCE=                    # optional; only if the IMS token needs a `resource` param
SPACECAT_S2S_LOGIN_URL=             # optional; defaults to <base>/auth/s2s/login
SPACECAT_API_BASE_URL=https://llmo.experiencecloud.live/api/v1   # LLMO host (dev: .../page/api/ci)

# Legacy API key — fallback only, removed after 2026-04-15:
SPACECAT_API_KEY=...
````

Also add a one-line note: "Token minting is server-side only; the browser never receives S2S credentials and routes through `/api/spacecat`."

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md api/spacecat.ts api/spacecat-config.ts
git commit -m "docs(auth): document S2S env vars and Vercel wrapper requirements"
```

---

## Final verification

- [ ] **Run the unit suite:** `npm run test:s2s` → all pass.
- [ ] **Type-check the whole project:** `npm run build` → passes.
- [ ] **Live smoke (with real `.env`):** `npm run verify:s2s` → `GET /sites: 200`.
- [ ] **Dev server end-to-end:** `npm run dev`, load the dashboard, fetch a site with the key field blank → data loads through the S2S proxy.
- [ ] Confirm `.env` is NOT staged anywhere (`git status` shows it ignored).
- [ ] Reminder to user: **rotate `IMS_SP_CLIENT_SECRET`** (it was shared in chat).

## Deprecation follow-up (post-merge)

After 2026-04-15, remove the legacy `Bearer + x-api-key` fallback from
`server/spacecat-proxy.ts` and `server/auto-evaluate/spacecat-client.ts`, drop
`SPACECAT_API_KEY` from env docs, and remove the frontend API key input.
