import { runOffsiteEvaluation } from '../server/offsite-evaluate';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  try {
    const result = await runOffsiteEvaluation(req.body, {
      AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
      AWS_REGION: process.env.AWS_REGION,
      BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_EVALUATOR_MODEL: process.env.OPENAI_EVALUATOR_MODEL,
      AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY,
      AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT,
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected evaluation error.',
    });
  }
}
