import {
  getSpacecatAuthHeaders,
  hasManagedAuth,
  isS2SConfigured,
  resetS2SCache,
  type SpacecatS2SEnv,
} from './auth/spacecat-s2s.js';

const DEFAULT_SPACECAT_API_BASE_URL =
  'https://llmo.experiencecloud.live/api/v1';

export type SpacecatProxyEnv = SpacecatS2SEnv & {
  SPACECAT_API_KEY?: string;
  SPACECAT_API_BASE_URL?: string;
  APP_ALLOWED_ORIGINS?: string;
  CORS_ALLOWED_ORIGINS?: string;
};

function normalizeApiBaseUrl(value?: string) {
  const trimmedValue = value?.trim() || DEFAULT_SPACECAT_API_BASE_URL;
  return trimmedValue.replace(/\/+$/, '');
}

function buildJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function getSpacecatProxyConfig(env: SpacecatProxyEnv = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(env.SPACECAT_API_BASE_URL);
  const hasLegacyKey = Boolean(env.SPACECAT_API_KEY?.trim());

  return {
    configured: hasManagedAuth(env) || hasLegacyKey,
    apiBaseUrl,
  };
}

function isAllowedTargetUrl(targetUrl: string, allowedBaseUrl: string) {
  try {
    const target = new URL(targetUrl);
    const allowedBase = new URL(allowedBaseUrl);
    const allowedPath = allowedBase.pathname.replace(/\/+$/, '');
    const targetPath = target.pathname.replace(/\/+$/, '');

    return (
      target.protocol === allowedBase.protocol &&
      target.origin === allowedBase.origin &&
      (targetPath === allowedPath || targetPath.startsWith(`${allowedPath}/`))
    );
  } catch {
    return false;
  }
}

export async function handleSpacecatProxyConfigRequest(
  request: Request,
  env: SpacecatProxyEnv = {},
) {
  if (request.method !== 'GET') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  return buildJsonResponse(getSpacecatProxyConfig(env));
}

// HTTP methods the proxy will forward upstream. GET for normal reads;
// PATCH for the Suggestions Patcher feature, which writes partial
// `data` updates to opportunity suggestions.
const PROXY_ALLOWED_METHODS = new Set(['GET', 'PATCH']);

async function buildUpstreamHeaders(
  env: SpacecatProxyEnv,
  hasBody: boolean,
): Promise<Record<string, string>> {
  const base: Record<string, string> = { accept: 'application/json' };
  if (hasBody) base['content-type'] = 'application/json';
  if (hasManagedAuth(env)) {
    return { ...base, ...(await getSpacecatAuthHeaders(env)) };
  }
  const key = env.SPACECAT_API_KEY?.trim() ?? '';
  return { ...base, authorization: `Bearer ${key}`, 'x-api-key': key };
}

export async function handleSpacecatProxyRequest(
  request: Request,
  env: SpacecatProxyEnv = {},
) {
  if (!PROXY_ALLOWED_METHODS.has(request.method)) {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const proxyConfig = getSpacecatProxyConfig(env);

  if (!proxyConfig.configured) {
    return buildJsonResponse(
      {
        error:
          'SpaceCat auth is not configured on the server. Set IMS_SP_* (S2S) or SPACECAT_API_KEY.',
      },
      503,
    );
  }

  const requestUrl = new URL(request.url);
  const targetUrl = requestUrl.searchParams.get('target')?.trim() || '';

  if (!targetUrl) {
    return buildJsonResponse({ error: 'Missing target query parameter.' }, 400);
  }

  if (!isAllowedTargetUrl(targetUrl, proxyConfig.apiBaseUrl)) {
    return buildJsonResponse(
      { error: 'Target URL is not allowed by the Spacecat proxy.' },
      403,
    );
  }

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
    const responseHeaders = new Headers();
    responseHeaders.set(
      'content-type',
      upstreamResponse.headers.get('content-type') ??
        'application/json; charset=utf-8',
    );
    responseHeaders.set('cache-control', 'no-store');

    const retryAfter = upstreamResponse.headers.get('retry-after');
    if (retryAfter) {
      responseHeaders.set('retry-after', retryAfter);
    }

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return buildJsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected Spacecat proxy error.',
      },
      500,
    );
  }
}
