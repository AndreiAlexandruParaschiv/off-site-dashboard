export type ApiCorsEnv = {
  APP_ALLOWED_ORIGINS?: string;
  CORS_ALLOWED_ORIGINS?: string;
};

function parseAllowedOrigins(env: ApiCorsEnv) {
  const rawValue = env.APP_ALLOWED_ORIGINS ?? env.CORS_ALLOWED_ORIGINS ?? '';

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveAllowedOrigin(request: Request, env: ApiCorsEnv) {
  const requestOrigin = request.headers.get('origin')?.trim() || '';

  if (!requestOrigin) {
    return '*';
  }

  const allowedOrigins = parseAllowedOrigins(env);

  if (allowedOrigins.length === 0) {
    return requestOrigin;
  }

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : '';
}

export function buildCorsHeaders(request: Request, env: ApiCorsEnv = {}) {
  const headers = new Headers();
  const allowedOrigin = resolveAllowedOrigin(request, env);

  if (allowedOrigin) {
    headers.set('access-control-allow-origin', allowedOrigin);
    headers.set('vary', 'origin');
  }

  // PATCH and DELETE are needed by the Suggestions Patcher
  // (server/spacecat-proxy.ts forwards them upstream): PATCH for field/status
  // edits, DELETE for removing an opportunity. Both are non-simple methods, so
  // the browser sends a CORS preflight before the actual call — without them on
  // this allow-list, the preflight fails and the request never leaves the
  // browser.
  headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  headers.set(
    'access-control-allow-headers',
    'content-type, authorization, x-api-key, x-client-token',
  );
  headers.set('access-control-max-age', '86400');

  return headers;
}

export function buildCorsPreflightResponse(
  request: Request,
  env: ApiCorsEnv = {},
) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, env),
  });
}

export function withCors(
  request: Request,
  response: Response,
  env: ApiCorsEnv = {},
) {
  const headers = new Headers(response.headers);
  const corsHeaders = buildCorsHeaders(request, env);
  corsHeaders.forEach((value, key) => {
    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
