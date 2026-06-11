import { handleSpacecatLoginRequest } from '../server/spacecat-login.js';
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

const loginEnv = {
  SPACECAT_API_BASE_URL: runtimeEnv.SPACECAT_API_BASE_URL,
  SPACECAT_USER_LOGIN_URL: runtimeEnv.SPACECAT_USER_LOGIN_URL,
  APP_ALLOWED_ORIGINS: runtimeEnv.APP_ALLOWED_ORIGINS,
  CORS_ALLOWED_ORIGINS: runtimeEnv.CORS_ALLOWED_ORIGINS,
};

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') {
      return buildCorsPreflightResponse(request, loginEnv);
    }

    return withCors(
      request,
      await handleSpacecatLoginRequest(request, loginEnv),
      loginEnv,
    );
  },
};
