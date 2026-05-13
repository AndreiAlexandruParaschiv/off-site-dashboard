import { handleOffsiteEvaluateCacheClearRequest } from '../server/offsite-evaluate.js';
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

const evaluatorEnv = {
  APP_ALLOWED_ORIGINS: runtimeEnv.APP_ALLOWED_ORIGINS,
  CORS_ALLOWED_ORIGINS: runtimeEnv.CORS_ALLOWED_ORIGINS,
};

// IMPORTANT: in Vercel production each serverless invocation may run in a
// separate warm container, so the in-memory cache cleared here only affects
// the instance that handles THIS request. The cache itself is process-local
// and unsynchronized across instances. For a strictly-shared cache, swap
// the in-memory Map in server/offsite-evaluate.ts for Vercel KV / Redis.
export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') {
      return buildCorsPreflightResponse(request, evaluatorEnv);
    }

    return withCors(
      request,
      await handleOffsiteEvaluateCacheClearRequest(request, evaluatorEnv),
      evaluatorEnv,
    );
  },
};
