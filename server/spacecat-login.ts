import {
  exchangeAccessTokenForSession,
  type SpacecatS2SEnv,
} from './auth/spacecat-s2s.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Exchange a browser-supplied IMS *user* access token for a SpaceCat session
 * token. The dashboard "Log in with IMS token" flow POSTs `{ accessToken }`
 * here; we forward it to SpaceCat's /auth/login (via
 * exchangeAccessTokenForSession) and return the resulting session JWT.
 *
 * Unlike the server-held SPACECAT_IMS_ACCESS_TOKEN path, this is per-request
 * and NOT cached server-side — the IMS token belongs to the caller, so the
 * browser holds the returned session token and decides when to re-exchange.
 * We never log or persist either token.
 */
export async function handleSpacecatLoginRequest(
  request: Request,
  env: SpacecatS2SEnv = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  let accessToken = '';
  try {
    const raw = await request.text();
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const value = parsed.accessToken;
    // Defensive: strip a leading "Bearer " in case the whole header value was
    // pasted rather than just the token.
    accessToken =
      typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }

  if (!accessToken) {
    return jsonResponse(
      { error: 'Missing accessToken in request body.' },
      400,
    );
  }

  try {
    const { token, expiresAt } = await exchangeAccessTokenForSession(
      accessToken,
      env,
    );
    return jsonResponse({ sessionToken: token, expiresAt });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to exchange IMS token.';
    // 502: the upstream SpaceCat login rejected the token or failed. The
    // message carries the SpaceCat detail so the UI can show why.
    return jsonResponse({ error: message }, 502);
  }
}
