import { handleSpacecatProxyRequest } from '../../server/spacecat-proxy';

function toRequestUrl(event: { rawUrl?: string; queryStringParameters?: Record<string, string | undefined> | null }) {
  if (typeof event.rawUrl === 'string' && event.rawUrl.trim()) {
    return event.rawUrl;
  }

  const requestUrl = new URL('http://localhost/api/spacecat');
  const target = event.queryStringParameters?.target;

  if (typeof target === 'string' && target.trim()) {
    requestUrl.searchParams.set('target', target);
  }

  return requestUrl.toString();
}

function responseToFunctionResult(response: Response) {
  return response.text().then((body) => ({
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }));
}

export async function handler(event: {
  httpMethod?: string;
  rawUrl?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
}) {
  const request = new Request(toRequestUrl(event), {
    method: event.httpMethod ?? 'GET',
  });
  const response = await handleSpacecatProxyRequest(request, {
    SPACECAT_API_KEY: process.env.SPACECAT_API_KEY,
    SPACECAT_API_BASE_URL: process.env.SPACECAT_API_BASE_URL,
  });

  return responseToFunctionResult(response);
}
