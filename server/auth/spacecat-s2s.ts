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
  // Pre-obtained SpaceCat session token. When set, it is used directly as the
  // bearer and S2S minting is skipped. Useful when the caller already holds a
  // valid session token (e.g. a user/admin token) or the S2S service principal
  // is not entitled for the target org.
  SPACECAT_SESSION_TOKEN?: string;
  // User-login path: a raw IMS *user* access token (e.g. from the Experience
  // Cloud shell / exc_app). When set (and neither SPACECAT_SESSION_TOKEN nor
  // S2S creds are configured), this module exchanges it for a SpaceCat session
  // token via POST <base>/auth/login {accessToken}, caching the result until
  // its JWT `exp`. This removes the manual "run curl, copy the session JWT"
  // step — you set the longer-lived IMS access token instead. NOTE: the IMS
  // access token itself still expires; prefer entitled S2S (IMS_SP_*) for a
  // fully hands-off setup.
  SPACECAT_IMS_ACCESS_TOKEN?: string;
  // Optional override for the user-login endpoint. Defaults to
  // <SPACECAT_API_BASE_URL>/auth/login.
  SPACECAT_USER_LOGIN_URL?: string;
};

/** True when `now` is before the token's expiry minus the safety buffer. */
export function isTokenFresh(
  expiresAt: number | null,
  bufferMs: number,
  now: number,
): boolean {
  return expiresAt !== null && now < expiresAt - bufferMs;
}

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
// User-login path cache (independent of the S2S session cache above).
let userSessionToken: string | null = null;
let userSessionExpiresAt: number | null = null;
let userSessionKey: string | null = null;

/** Clear all cached tokens. Call after a 401 before re-minting. */
export function resetS2SCache(): void {
  imsToken = null;
  imsExpiresAt = null;
  sessionToken = null;
  sessionExpiresAt = null;
  sessionScopeKey = null;
  userSessionToken = null;
  userSessionExpiresAt = null;
  userSessionKey = null;
}

/** True when S2S credentials are present (drives legacy fallback). */
export function isS2SConfigured(env: SpacecatS2SEnv): boolean {
  return Boolean(env.IMS_SP_CLIENT_ID?.trim() && env.IMS_SP_CLIENT_SECRET?.trim());
}

/** True when the user-login (IMS access token) path is configured. */
export function isUserLoginConfigured(env: SpacecatS2SEnv): boolean {
  return Boolean(env.SPACECAT_IMS_ACCESS_TOKEN?.trim());
}

/**
 * True when a session token can be (re-)minted from server-held credentials —
 * i.e. S2S creds or a user IMS access token. Used to gate the 401 re-mint
 * retry: a pre-pasted SPACECAT_SESSION_TOKEN can't be re-minted, so retrying
 * it is pointless.
 */
export function canRemintSession(env: SpacecatS2SEnv): boolean {
  return isS2SConfigured(env) || isUserLoginConfigured(env);
}

/**
 * True when this module can supply auth headers without the legacy key:
 * a pre-obtained session token, full S2S credentials, or a user IMS token.
 */
export function hasManagedAuth(env: SpacecatS2SEnv): boolean {
  return (
    Boolean(env.SPACECAT_SESSION_TOKEN?.trim()) ||
    isS2SConfigured(env) ||
    isUserLoginConfigured(env)
  );
}

/**
 * Read the `exp` (seconds-since-epoch) claim from a JWT without verifying it.
 * Returns the expiry in ms, or null if the token is malformed / has no exp.
 * Used to cache user-login session tokens for their real lifetime (~24h)
 * instead of a fixed short TTL.
 */
export function readJwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64.padEnd(Math.ceil(payloadB64.length / 4) * 4, '=');
    const json = JSON.parse(
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf-8'),
    ) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
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
  // Service-principal clients ("client without an owner") must pass the org id
  // on the IMS token request itself, not just the later session exchange.
  if (env.IMS_SP_ORG_ID?.trim()) {
    body.set('org_id', env.IMS_SP_ORG_ID.trim());
  }
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

function resolveLoginUrl(env: SpacecatS2SEnv): string {
  if (env.SPACECAT_S2S_LOGIN_URL?.trim()) {
    return env.SPACECAT_S2S_LOGIN_URL.trim();
  }
  const base = (env.SPACECAT_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  return `${base}/auth/s2s/login`;
}

/**
 * Auth header for SpaceCat API calls. On a 401, the caller should
 * `resetS2SCache()` and call this again once before propagating.
 *
 * Precedence: SPACECAT_SESSION_TOKEN (pasted) > S2S (IMS_SP_*) >
 * user-login (SPACECAT_IMS_ACCESS_TOKEN).
 */
export async function getSpacecatAuthHeaders(
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<Record<string, string>> {
  // A pre-obtained session token short-circuits all minting entirely.
  const provided = env.SPACECAT_SESSION_TOKEN?.trim();
  if (provided) {
    return { authorization: `Bearer ${provided}` };
  }
  // S2S (client_credentials) is the preferred unattended path.
  if (isS2SConfigured(env)) {
    return { authorization: `Bearer ${await getSessionToken(env, deps)}` };
  }
  // User-login: exchange a raw IMS user access token for a session token.
  if (isUserLoginConfigured(env)) {
    return { authorization: `Bearer ${await getUserLoginSessionToken(env, deps)}` };
  }
  throw new Error(
    'No managed SpaceCat auth configured (SPACECAT_SESSION_TOKEN, IMS_SP_*, or SPACECAT_IMS_ACCESS_TOKEN).',
  );
}

function resolveUserLoginUrl(env: SpacecatS2SEnv): string {
  if (env.SPACECAT_USER_LOGIN_URL?.trim()) {
    return env.SPACECAT_USER_LOGIN_URL.trim();
  }
  const base = (env.SPACECAT_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  return `${base}/auth/login`;
}

/**
 * Exchange a raw IMS *user* access token for a SpaceCat session token via
 * POST <base>/auth/login {accessToken}. Caches the result until just before
 * its JWT `exp` (falling back to SESSION_TTL_MS if the token has no exp).
 *
 * The cache is keyed by a fingerprint of the access token, so swapping in a
 * fresh IMS token (e.g. after the old one expires) invalidates the cache
 * without needing an explicit reset.
 */
/**
 * Exchange a raw IMS *user* access token for a SpaceCat session token via
 * POST <base>/auth/login {accessToken}. This is the un-cached primitive — it
 * always hits the network. Callers that hold the token server-side
 * ({@link getUserLoginSessionToken}) layer caching on top; the
 * request-driven login endpoint calls this directly (one user, no shared
 * cache).
 *
 * Returns the session token plus its computed expiry (the JWT's real `exp`
 * when present, otherwise now + a short TTL).
 */
export async function exchangeAccessTokenForSession(
  accessToken: string,
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<{ token: string; expiresAt: number }> {
  const trimmed = accessToken.trim();
  if (!trimmed) {
    throw new Error('No IMS access token provided.');
  }

  const response = await deps.fetch(resolveUserLoginUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: trimmed }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `SpaceCat user login failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
    );
  }

  // Tolerant parse: the endpoint returns the session token under one of a
  // few common keys, or as a raw JWT string body.
  const raw = await response.text();
  let token = '';
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    token =
      (typeof json.sessionToken === 'string' && json.sessionToken) ||
      (typeof json.token === 'string' && json.token) ||
      (typeof json.session_token === 'string' && json.session_token) ||
      '';
  } catch {
    // Body wasn't JSON — treat it as the raw token if it looks like a JWT.
    token = /^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw.trim()) ? raw.trim() : '';
  }
  if (!token) {
    throw new Error(
      `SpaceCat user login returned no session token (body: ${raw.slice(0, 160)}).`,
    );
  }

  // Prefer the JWT's real expiry; fall back to the short S2S TTL.
  const jwtExpiry = readJwtExpiryMs(token);
  return { token, expiresAt: jwtExpiry ?? deps.now() + SESSION_TTL_MS };
}

export async function getUserLoginSessionToken(
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<string> {
  const accessToken = env.SPACECAT_IMS_ACCESS_TOKEN?.trim() ?? '';
  if (!accessToken) {
    throw new Error('SPACECAT_IMS_ACCESS_TOKEN is not set.');
  }
  // Cheap fingerprint so a rotated IMS token busts the cache.
  const key = accessToken.slice(-24);
  if (
    userSessionToken &&
    userSessionKey === key &&
    isTokenFresh(userSessionExpiresAt, SESSION_REFRESH_BUFFER_MS, deps.now())
  ) {
    return userSessionToken;
  }

  const { token, expiresAt } = await exchangeAccessTokenForSession(accessToken, env, deps);
  userSessionToken = token;
  userSessionExpiresAt = expiresAt;
  userSessionKey = key;
  return token;
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
