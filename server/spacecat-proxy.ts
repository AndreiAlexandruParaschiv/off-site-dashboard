const DEFAULT_SPACECAT_API_BASE_URL =
  'https://spacecat.experiencecloud.live/api/v1';

export type SpacecatProxyEnv = {
  SPACECAT_API_KEY?: string;
  SPACECAT_API_BASE_URL?: string;
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
  const apiKey = env.SPACECAT_API_KEY?.trim() || '';

  return {
    configured: Boolean(apiKey),
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

export async function handleSpacecatProxyRequest(
  request: Request,
  env: SpacecatProxyEnv = {},
) {
  if (request.method !== 'GET') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const proxyConfig = getSpacecatProxyConfig(env);

  if (!proxyConfig.configured) {
    return buildJsonResponse(
      { error: 'SPACECAT_API_KEY is not configured on the server.' },
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

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${env.SPACECAT_API_KEY?.trim()}`,
        'x-api-key': env.SPACECAT_API_KEY?.trim() || '',
      },
    });
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
