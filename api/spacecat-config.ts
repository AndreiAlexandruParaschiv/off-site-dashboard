import { handleSpacecatProxyConfigRequest } from '../server/spacecat-proxy.js';

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
};

export default {
  async fetch(request: Request) {
    return handleSpacecatProxyConfigRequest(request, proxyEnv);
  },
};
