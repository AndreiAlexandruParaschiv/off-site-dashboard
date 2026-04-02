import { handleSpacecatProxyConfigRequest } from '../../server/spacecat-proxy';

function toRequestUrl(event: { rawUrl?: string }) {
  if (typeof event.rawUrl === 'string' && event.rawUrl.trim()) {
    return event.rawUrl;
  }

  return 'http://localhost/api/spacecat-config';
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
}) {
  const request = new Request(toRequestUrl(event), {
    method: event.httpMethod ?? 'GET',
  });
  const response = await handleSpacecatProxyConfigRequest(request, {
    SPACECAT_API_KEY: process.env.SPACECAT_API_KEY,
    SPACECAT_API_BASE_URL: process.env.SPACECAT_API_BASE_URL,
  });

  return responseToFunctionResult(response);
}
