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

import { getSpacecatAuthHeaders, hasManagedAuth, isS2SConfigured } from './spacecat-s2s.js';

test('isS2SConfigured: true only with id and secret', () => {
  assert.equal(isS2SConfigured({}), false);
  assert.equal(isS2SConfigured({ IMS_SP_CLIENT_ID: 'cid' }), false);
  assert.equal(isS2SConfigured(baseEnv), true);
});

test('hasManagedAuth: true for a provided session token or full S2S creds', () => {
  assert.equal(hasManagedAuth({}), false);
  assert.equal(hasManagedAuth({ SPACECAT_SESSION_TOKEN: 'tok' }), true);
  assert.equal(hasManagedAuth(baseEnv), true);
});

test('getSpacecatAuthHeaders: provided session token short-circuits S2S minting', async () => {
  resetS2SCache();
  const { impl, calls } = fakeFetch([]); // no responses queued: must not fetch
  const headers = await getSpacecatAuthHeaders(
    { ...baseEnv, SPACECAT_SESSION_TOKEN: 'provided-tok' },
    { fetch: impl, now: () => 0 },
  );
  assert.deepEqual(headers, { authorization: 'Bearer provided-tok' });
  assert.equal(calls.length, 0, 'no IMS/login calls when a session token is provided');
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

// --- User-login (IMS access token) path ---

import {
  canRemintSession,
  getUserLoginSessionToken,
  isUserLoginConfigured,
  readJwtExpiryMs,
} from './spacecat-s2s.js';

// A JWT whose payload is {"exp": 9999} (no signature needed for exp parse).
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('readJwtExpiryMs: reads exp claim as ms; null on malformed', () => {
  assert.equal(readJwtExpiryMs(jwtWithExp(1000)), 1000 * 1000);
  assert.equal(readJwtExpiryMs('not-a-jwt'), null);
  assert.equal(readJwtExpiryMs('a.b'), null);
});

test('isUserLoginConfigured / canRemintSession reflect the new path', () => {
  assert.equal(isUserLoginConfigured({}), false);
  assert.equal(isUserLoginConfigured({ SPACECAT_IMS_ACCESS_TOKEN: 'at' }), true);
  // canRemintSession: true for S2S OR user-login, false for pasted token only.
  assert.equal(canRemintSession({}), false);
  assert.equal(canRemintSession({ SPACECAT_SESSION_TOKEN: 'tok' }), false);
  assert.equal(canRemintSession(baseEnv), true);
  assert.equal(canRemintSession({ SPACECAT_IMS_ACCESS_TOKEN: 'at' }), true);
});

test('hasManagedAuth: true for the user-login path too', () => {
  assert.equal(hasManagedAuth({ SPACECAT_IMS_ACCESS_TOKEN: 'at' }), true);
});

test('getUserLoginSessionToken: exchanges IMS access token via /auth/login', async () => {
  resetS2SCache();
  const token = jwtWithExp(99_999);
  const { impl, calls } = fakeFetch([{ body: { sessionToken: token } }]);
  const env = {
    SPACECAT_API_BASE_URL: 'https://llmo.test/api/v1',
    SPACECAT_IMS_ACCESS_TOKEN: 'user-ims-token',
  };
  const out = await getUserLoginSessionToken(env, { fetch: impl, now: () => 0 });
  assert.equal(out, token);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://llmo.test/api/v1/auth/login');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { accessToken: 'user-ims-token' });
});

test('getUserLoginSessionToken: caches until JWT exp', async () => {
  resetS2SCache();
  // exp far in the future (well beyond the 2-min refresh buffer) → second
  // call within the fresh window must hit the cache.
  const token = jwtWithExp(99_999);
  const { impl, calls } = fakeFetch([{ body: { sessionToken: token } }]);
  const env = { SPACECAT_IMS_ACCESS_TOKEN: 'at' };
  const deps: Deps = { fetch: impl, now: () => 0 };
  const a = await getUserLoginSessionToken(env, deps);
  const b = await getUserLoginSessionToken(env, deps);
  assert.equal(a, token);
  assert.equal(b, token);
  assert.equal(calls.length, 1, 'second call hits cache (within JWT exp window)');
});

test('getUserLoginSessionToken: rotating the IMS token busts the cache', async () => {
  resetS2SCache();
  const t1 = jwtWithExp(99_999);
  const t2 = jwtWithExp(99_999);
  const { impl, calls } = fakeFetch([
    { body: { sessionToken: t1 } },
    { body: { sessionToken: t2 } },
  ]);
  const deps: Deps = { fetch: impl, now: () => 0 };
  const a = await getUserLoginSessionToken({ SPACECAT_IMS_ACCESS_TOKEN: 'token-AAAAAAAAAAAAAAAAAAAAAAAA' }, deps);
  const b = await getUserLoginSessionToken({ SPACECAT_IMS_ACCESS_TOKEN: 'token-BBBBBBBBBBBBBBBBBBBBBBBB' }, deps);
  assert.equal(a, t1);
  assert.equal(b, t2);
  assert.equal(calls.length, 2, 'different IMS token fingerprint forces a re-fetch');
});

test('getSpacecatAuthHeaders: falls through to user-login when no S2S creds', async () => {
  resetS2SCache();
  const token = jwtWithExp(99_999);
  const { impl, calls } = fakeFetch([{ body: { sessionToken: token } }]);
  const headers = await getSpacecatAuthHeaders(
    { SPACECAT_IMS_ACCESS_TOKEN: 'at' },
    { fetch: impl, now: () => 0 },
  );
  assert.deepEqual(headers, { authorization: `Bearer ${token}` });
  assert.equal(calls.length, 1, 'only the /auth/login exchange — no IMS client_credentials call');
});

test('getUserLoginSessionToken: surfaces upstream error detail', async () => {
  resetS2SCache();
  const { impl } = fakeFetch([{ status: 401, body: { message: 'Invalid access token' } }]);
  await assert.rejects(
    () => getUserLoginSessionToken({ SPACECAT_IMS_ACCESS_TOKEN: 'expired' }, { fetch: impl, now: () => 0 }),
    /SpaceCat user login failed: 401.*Invalid access token/,
  );
});
