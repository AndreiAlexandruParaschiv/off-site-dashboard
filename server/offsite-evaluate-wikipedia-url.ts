import { WIKIPEDIA_URL_EVALUATOR_VERSION } from '../src/features/off-site-dashboard/constants.js';
import type {
  WikipediaUrlEvaluationRequest,
  WikipediaUrlEvaluationResult,
  WikipediaUrlEvaluationVerdict,
} from '../src/features/off-site-dashboard/types.js';

const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
const BEDROCK_MODEL_FALLBACKS = [
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
] as const;

type ServerEnv = {
  AWS_BEARER_TOKEN_BEDROCK?: string;
  BEDROCK_BEARER_TOKEN?: string;
  AWS_REGION?: string;
  BEDROCK_REGION?: string;
  BEDROCK_MODEL_ID?: string;
  BEDROCK_MODEL?: string;
};

type LlmWikipediaUrlEvaluation = {
  verdict: WikipediaUrlEvaluationVerdict;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  evidenceSnippet: string;
  wikipediaTitle: string;
};

function buildJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function normalizeBedrockRegion(value?: string) {
  return value?.trim() || '';
}

function getBedrockRegion(env: ServerEnv) {
  return normalizeBedrockRegion(env.AWS_REGION ?? env.BEDROCK_REGION);
}

function getBedrockBearerToken(env: ServerEnv) {
  return env.BEDROCK_BEARER_TOKEN?.trim() || env.AWS_BEARER_TOKEN_BEDROCK?.trim() || '';
}

function getPreferredBedrockModel(env: ServerEnv) {
  return env.BEDROCK_MODEL_ID?.trim() || env.BEDROCK_MODEL?.trim() || DEFAULT_BEDROCK_MODEL;
}

function getBedrockModelCandidates(preferredModel?: string) {
  const candidates = [preferredModel, ...BEDROCK_MODEL_FALLBACKS].filter(
    (value): value is string => Boolean(value?.trim()),
  );

  return candidates.filter((value, index) => candidates.indexOf(value) === index);
}

function extractWikipediaTitleFromUrl(value: string) {
  try {
    const parsedUrl = new URL(value.trim());
    return decodeURIComponent(parsedUrl.pathname.replace(/^\/wiki\//i, ''))
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function normalizeRequestPayload(rawPayload: unknown): WikipediaUrlEvaluationRequest | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return null;
  }

  const candidate = rawPayload as Partial<WikipediaUrlEvaluationRequest>;
  const site = candidate.site?.trim();
  const wikipediaUrl = candidate.wikipediaUrl?.trim();

  if (!site || !wikipediaUrl) {
    return null;
  }

  return {
    site,
    resolvedSiteUrl: candidate.resolvedSiteUrl?.trim() || undefined,
    siteId: candidate.siteId?.trim() || undefined,
    opportunityId: candidate.opportunityId?.trim() || undefined,
    wikipediaUrl,
  };
}

function buildWikipediaUrlPrompt(payload: WikipediaUrlEvaluationRequest) {
  const wikipediaTitle = extractWikipediaTitleFromUrl(payload.wikipediaUrl);

  return [
    'You are validating whether a backend wikipediaUrl is the correct Wikipedia page for a website/domain.',
    'Evaluate ONLY the supplied backend wikipediaUrl.',
    'Do NOT consider competitor URLs, alternative Wikipedia pages, or competitor analysis.',
    'Regional or market-specific domains can still correctly map to the core brand page.',
    'Example: landroverusa.com -> https://en.wikipedia.org/wiki/Land_Rover should usually be treated as Correct.',
    'Use these labels:',
    '- Correct: the wikipediaUrl clearly points to the same brand/entity as the site.',
    '- Incorrect: the wikipediaUrl clearly points to a different brand/entity.',
    '- Needs Review: ambiguity remains (parent company vs subsidiary, reseller/distributor, acronym collision, etc.).',
    '',
    `Submitted site: ${payload.site}`,
    `Resolved site: ${payload.resolvedSiteUrl ?? payload.site}`,
    `Site ID: ${payload.siteId ?? 'unknown'}`,
    `Opportunity ID: ${payload.opportunityId ?? 'unknown'}`,
    `Backend wikipediaUrl: ${payload.wikipediaUrl}`,
    `Wikipedia title parsed from URL: ${wikipediaTitle || 'unknown'}`,
    '',
    'Return ONLY a valid JSON object. Do not add markdown, code fences, or extra text.',
    'Use this exact schema:',
    '{',
    '  "verdict": "Correct" | "Incorrect" | "Needs Review",',
    '  "confidence": "high" | "medium" | "low",',
    '  "rationale": string,',
    '  "evidenceSnippet": string,',
    '  "wikipediaTitle": string',
    '}',
  ].join('\n');
}

function extractJsonObject(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const fencedMatch = trimmedValue.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateValue = fencedMatch?.[1]?.trim() || trimmedValue;

  try {
    return JSON.parse(candidateValue);
  } catch {
    const objectStart = candidateValue.indexOf('{');
    const objectEnd = candidateValue.lastIndexOf('}');

    if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
      return null;
    }

    try {
      return JSON.parse(candidateValue.slice(objectStart, objectEnd + 1));
    } catch {
      return null;
    }
  }
}

function parseWikipediaUrlLlmPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Failed to parse Wikipedia URL evaluator response.');
  }

  const candidate = value as Partial<LlmWikipediaUrlEvaluation>;

  if (
    typeof candidate.verdict !== 'string' ||
    typeof candidate.confidence !== 'string' ||
    typeof candidate.rationale !== 'string' ||
    typeof candidate.evidenceSnippet !== 'string' ||
    typeof candidate.wikipediaTitle !== 'string'
  ) {
    throw new Error('Failed to parse Wikipedia URL evaluator response.');
  }

  return candidate as LlmWikipediaUrlEvaluation;
}

async function fetchWikipediaUrlBedrockEvaluation(
  payload: WikipediaUrlEvaluationRequest,
  env: ServerEnv,
) {
  const apiKey = getBedrockBearerToken(env);
  const region = getBedrockRegion(env);

  if (!apiKey) {
    throw new Error('BEDROCK_BEARER_TOKEN or AWS_BEARER_TOKEN_BEDROCK is missing.');
  }

  if (!region) {
    throw new Error('AWS_REGION or BEDROCK_REGION is missing for Bedrock evaluation.');
  }

  const modelCandidates = getBedrockModelCandidates(getPreferredBedrockModel(env));
  let lastError = '';

  for (const modelId of modelCandidates) {
    try {
      const response = await fetch(
        `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(
          modelId,
        )}/converse`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [{ text: buildWikipediaUrlPrompt(payload) }],
              },
            ],
            inferenceConfig: {
              maxTokens: 500,
              temperature: 0.1,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Bedrock request failed with ${response.status}`);
      }

      const parsedPayload = (await response.json()) as {
        output?: {
          message?: {
            content?: Array<{ text?: string }>;
          };
        };
      };
      const outputText =
        parsedPayload.output?.message?.content
          ?.map((entry) => entry.text)
          .find((text): text is string => Boolean(text?.trim())) ?? '';

      return {
        evaluation: parseWikipediaUrlLlmPayload(extractJsonObject(outputText)),
        model: modelId,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unexpected Bedrock error.';
    }
  }

  throw new Error(lastError || 'Bedrock request failed.');
}

export async function runWikipediaUrlEvaluation(
  rawPayload: unknown,
  env: ServerEnv = {},
): Promise<WikipediaUrlEvaluationResult> {
  const payload = normalizeRequestPayload(rawPayload);

  if (!payload) {
    throw new Error('Invalid Wikipedia URL evaluator request payload.');
  }

  const llmResponse = await fetchWikipediaUrlBedrockEvaluation(payload, env);

  return {
    verdict: llmResponse.evaluation.verdict,
    confidence: llmResponse.evaluation.confidence,
    rationale: llmResponse.evaluation.rationale.trim(),
    evidenceSnippet: llmResponse.evaluation.evidenceSnippet.trim(),
    wikipediaTitle:
      llmResponse.evaluation.wikipediaTitle.trim() ||
      extractWikipediaTitleFromUrl(payload.wikipediaUrl),
    evaluatedAt: new Date().toISOString(),
    evaluatorVersion: WIKIPEDIA_URL_EVALUATOR_VERSION,
    evaluatorProvider: 'bedrock',
    evaluatorModel: llmResponse.model,
  };
}

export async function handleWikipediaUrlEvaluateRequest(
  request: Request,
  env: ServerEnv = {},
) {
  if (request.method !== 'POST') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const payload = await request.json();
    const result = await runWikipediaUrlEvaluation(payload, env);
    return buildJsonResponse(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unexpected Wikipedia URL evaluation error.';

    return buildJsonResponse({ error: message }, 500);
  }
}
