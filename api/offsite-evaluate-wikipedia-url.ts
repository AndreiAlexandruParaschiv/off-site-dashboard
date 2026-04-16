import { handleWikipediaUrlEvaluateRequest } from '../server/offsite-evaluate-wikipedia-url.js';
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
  AWS_BEARER_TOKEN_BEDROCK: runtimeEnv.AWS_BEARER_TOKEN_BEDROCK,
  BEDROCK_BEARER_TOKEN: runtimeEnv.BEDROCK_BEARER_TOKEN,
  AWS_REGION: runtimeEnv.AWS_REGION,
  BEDROCK_REGION: runtimeEnv.BEDROCK_REGION,
  BEDROCK_MODEL_ID: runtimeEnv.BEDROCK_MODEL_ID,
  BEDROCK_MODEL: runtimeEnv.BEDROCK_MODEL,
  APP_ALLOWED_ORIGINS: runtimeEnv.APP_ALLOWED_ORIGINS,
  CORS_ALLOWED_ORIGINS: runtimeEnv.CORS_ALLOWED_ORIGINS,
};

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') {
      return buildCorsPreflightResponse(request, evaluatorEnv);
    }

    return withCors(
      request,
      await handleWikipediaUrlEvaluateRequest(request, evaluatorEnv),
      evaluatorEnv,
    );
  },
};
