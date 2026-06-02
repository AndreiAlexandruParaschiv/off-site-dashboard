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
