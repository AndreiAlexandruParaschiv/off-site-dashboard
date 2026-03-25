import { handleOffsiteEvaluateRequest } from '../server/offsite-evaluate';

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
  AWS_REGION: runtimeEnv.AWS_REGION,
  BEDROCK_MODEL_ID: runtimeEnv.BEDROCK_MODEL_ID,
  OPENAI_API_KEY: runtimeEnv.OPENAI_API_KEY,
  OPENAI_EVALUATOR_MODEL: runtimeEnv.OPENAI_EVALUATOR_MODEL,
  AZURE_OPENAI_ENDPOINT: runtimeEnv.AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY: runtimeEnv.AZURE_OPENAI_KEY,
  AZURE_OPENAI_DEPLOYMENT: runtimeEnv.AZURE_OPENAI_DEPLOYMENT,
};

export default {
  async fetch(request: Request) {
    return handleOffsiteEvaluateRequest(request, evaluatorEnv);
  },
};
