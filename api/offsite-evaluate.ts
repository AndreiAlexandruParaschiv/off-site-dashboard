import { handleOffsiteEvaluateRequest } from '../server/offsite-evaluate';

const evaluatorEnv = {
  AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
  AWS_REGION: process.env.AWS_REGION,
  BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_EVALUATOR_MODEL: process.env.OPENAI_EVALUATOR_MODEL,
  AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY,
  AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT,
};

export default {
  async fetch(request: Request) {
    return handleOffsiteEvaluateRequest(request, evaluatorEnv);
  },
};
