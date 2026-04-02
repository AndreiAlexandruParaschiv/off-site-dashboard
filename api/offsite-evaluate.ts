import { handleOffsiteEvaluateRequest } from '../server/offsite-evaluate.js';

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
  BEDROCK_REGION: runtimeEnv.BEDROCK_REGION,
  BEDROCK_MODEL_ID: runtimeEnv.BEDROCK_MODEL_ID,
  BEDROCK_MODEL: runtimeEnv.BEDROCK_MODEL,
  BRIGHTDATA_API_KEY: runtimeEnv.BRIGHTDATA_API_KEY,
  BRIGHTDATA_WEB_UNLOCKER_ZONE: runtimeEnv.BRIGHTDATA_WEB_UNLOCKER_ZONE,
  BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID:
    runtimeEnv.BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID,
  BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID:
    runtimeEnv.BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID,
  BRIGHTDATA_REDDIT_POST_DATASET_ID: runtimeEnv.BRIGHTDATA_REDDIT_POST_DATASET_ID,
  BRIGHTDATA_REDDIT_COMMENT_DATASET_ID:
    runtimeEnv.BRIGHTDATA_REDDIT_COMMENT_DATASET_ID,
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
