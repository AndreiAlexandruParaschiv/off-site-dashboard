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

/**
 * True when this module can supply auth headers without the legacy key:
 * either a pre-obtained session token or full S2S credentials.
 */
export function hasManagedAuth(env: SpacecatS2SEnv): boolean {
  return Boolean(env.SPACECAT_SESSION_TOKEN?.trim()) || isS2SConfigured(env);
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
 */
export async function getSpacecatAuthHeaders(
  env: SpacecatS2SEnv,
  deps: Deps = defaultDeps,
): Promise<Record<string, string>> {
  // A pre-obtained session token short-circuits S2S minting entirely.
  const provided = env.SPACECAT_SESSION_TOKEN?.trim();
  const token = provided || (await getSessionToken(env, deps));
  return { authorization: `Bearer ${token}` };
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
