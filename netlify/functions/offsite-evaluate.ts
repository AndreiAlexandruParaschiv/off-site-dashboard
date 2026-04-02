import { runOffsiteEvaluation } from '../../server/offsite-evaluate';

function buildResponse(statusCode: number, payload: unknown) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  };
}

function parseEventBody(event: { body?: string | null; isBase64Encoded?: boolean }) {
  const rawBody = event.body;

  if (!rawBody) {
    return null;
  }

  const decodedBody = event.isBase64Encoded
    ? Buffer.from(rawBody, 'base64').toString('utf-8')
    : rawBody;

  return JSON.parse(decodedBody);
}

export async function handler(event: {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
}) {
  if (event.httpMethod !== 'POST') {
    return buildResponse(405, { error: 'Method not allowed.' });
  }

  try {
    const payload = parseEventBody(event);
    const result = await runOffsiteEvaluation(payload, {
      AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
      AWS_REGION: process.env.AWS_REGION,
      BEDROCK_REGION: process.env.BEDROCK_REGION,
      BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
      BEDROCK_MODEL: process.env.BEDROCK_MODEL,
      BRIGHTDATA_API_KEY: process.env.BRIGHTDATA_API_KEY,
      BRIGHTDATA_WEB_UNLOCKER_ZONE: process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE,
      BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID:
        process.env.BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID,
      BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID:
        process.env.BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID,
      BRIGHTDATA_REDDIT_POST_DATASET_ID:
        process.env.BRIGHTDATA_REDDIT_POST_DATASET_ID,
      BRIGHTDATA_REDDIT_COMMENT_DATASET_ID:
        process.env.BRIGHTDATA_REDDIT_COMMENT_DATASET_ID,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_EVALUATOR_MODEL: process.env.OPENAI_EVALUATOR_MODEL,
      AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY,
      AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT,
    });

    return buildResponse(200, result);
  } catch (error) {
    return buildResponse(500, {
      error: error instanceof Error ? error.message : 'Unexpected evaluation error.',
    });
  }
}
