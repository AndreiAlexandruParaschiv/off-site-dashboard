import { handleSpacecatProxyConfigRequest } from '../server/spacecat-proxy.js';
import {
  buildCorsPreflightResponse,
  withCors,
} from '../server/api-cors.js';

const runtimeEnv =
  (
    globalThis as typeof globalThis & {
      process?: {
        env?: Record<string, string | undefined>;
      };
    }
  ).process?.env ?? {};

const proxyEnv = {
  SPACECAT_API_KEY: runtimeEnv.SPACECAT_API_KEY,
  SPACECAT_API_BASE_URL: runtimeEnv.SPACECAT_API_BASE_URL,
  APP_ALLOWED_ORIGINS: runtimeEnv.APP_ALLOWED_ORIGINS,
  CORS_ALLOWED_ORIGINS: runtimeEnv.CORS_ALLOWED_ORIGINS,
};

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') {
      return buildCorsPreflightResponse(request, proxyEnv);
    }

    return withCors(
      request,
      await handleSpacecatProxyConfigRequest(request, proxyEnv),
      proxyEnv,
    );
  },
};
