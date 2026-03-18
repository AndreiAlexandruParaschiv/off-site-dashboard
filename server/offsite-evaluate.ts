import { SENTIMENT_EVALUATOR_VERSION } from '../src/features/off-site-dashboard/constants';
import type {
  CanonicalOpportunityType,
  SentimentEvaluationRequest,
  SentimentEvaluationResult,
} from '../src/features/off-site-dashboard/types';

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const REQUEST_USER_AGENT =
  'Mozilla/5.0 (compatible; OffSiteDashboardEvaluator/1.0; +https://vercel.com)';
const MAX_EVIDENCE_CHARACTERS = 14000;
const MIN_EVIDENCE_CHARACTERS = 180;

type ServerEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_EVALUATOR_MODEL?: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_KEY?: string;
  AZURE_OPENAI_DEPLOYMENT?: string;
};

type SourceEvidence = {
  sourceType: 'youtube' | 'reddit' | 'web';
  sourceUrl: string;
  usedTranscript: boolean;
  status: 'success' | 'partial' | 'insufficient_evidence' | 'fetch_failed';
  evidenceText: string;
  fallbackSnippet: string;
};

type LlmEvaluation = {
  targetBrand: string;
  evaluatedSentiment: string;
  evidenceSufficient: boolean;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  evidenceSnippet: string;
};

function trimMultilineText(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function stripHtmlTags(value: string) {
  return trimMultilineText(
    decodeHtmlEntities(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<\/(p|div|li|section|article|header|footer|main|h1|h2|h3|h4|h5|h6|br)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return value.replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (match, entity: string) => {
      const normalizedEntity = entity.toLowerCase();

      if (normalizedEntity in namedEntities) {
        return namedEntities[normalizedEntity];
      }

      if (normalizedEntity.startsWith('#x')) {
        const parsedValue = Number.parseInt(normalizedEntity.slice(2), 16);
        return Number.isFinite(parsedValue) ? String.fromCodePoint(parsedValue) : match;
      }

      if (normalizedEntity.startsWith('#')) {
        const parsedValue = Number.parseInt(normalizedEntity.slice(1), 10);
        return Number.isFinite(parsedValue) ? String.fromCodePoint(parsedValue) : match;
      }

      return match;
    },
  );
}

function clampEvidenceText(value: string) {
  return value.slice(0, MAX_EVIDENCE_CHARACTERS).trim();
}

function normalizeAzureOpenAiBaseUrl(value?: string) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return '';
  }

  const withoutTrailingSlash = trimmedValue.replace(/\/+$/, '');

  if (withoutTrailingSlash.endsWith('/openai/v1')) {
    return `${withoutTrailingSlash}/`;
  }

  if (withoutTrailingSlash.endsWith('/openai')) {
    return `${withoutTrailingSlash}/v1/`;
  }

  return `${withoutTrailingSlash}/openai/v1/`;
}

function normalizeRequestPayload(value: unknown): SentimentEvaluationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<SentimentEvaluationRequest>;

  if (
    typeof candidate.site !== 'string' ||
    typeof candidate.opportunityType !== 'string' ||
    typeof candidate.opportunityId !== 'string' ||
    typeof candidate.item !== 'string' ||
    typeof candidate.extractedSentiment !== 'string'
  ) {
    return null;
  }

  return {
    site: candidate.site,
    siteId: typeof candidate.siteId === 'string' ? candidate.siteId : undefined,
    opportunityType: candidate.opportunityType as CanonicalOpportunityType,
    opportunityId: candidate.opportunityId,
    item: candidate.item,
    extractedSentiment: candidate.extractedSentiment,
  };
}

function buildJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      'user-agent': REQUEST_USER_AGENT,
      accept:
        'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with ${response.status}`);
  }

  return response.text();
}

function extractMetaTagValue(html: string, matcher: RegExp) {
  const match = matcher.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : '';
}

function extractBalancedObjectLiteral(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const objectStart = source.indexOf('{', markerIndex);

  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quoteCharacter = '';
  let isEscaped = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (inString) {
      if (character === '\\') {
        isEscaped = true;
        continue;
      }

      if (character === quoteCharacter) {
        inString = false;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      quoteCharacter = character;
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

function parseYouTubeTranscriptPayload(payload: string) {
  const trimmedPayload = payload.trim();

  if (!trimmedPayload) {
    return '';
  }

  if (trimmedPayload.startsWith('{')) {
    try {
      const parsedPayload = JSON.parse(trimmedPayload) as {
        events?: Array<{ segs?: Array<{ utf8?: string }> }>;
      };

      return trimMultilineText(
        (parsedPayload.events ?? [])
          .flatMap((event) => event.segs ?? [])
          .map((segment) => decodeHtmlEntities(segment.utf8 ?? ''))
          .join(' '),
      );
    } catch {
      return '';
    }
  }

  const transcriptChunks = Array.from(
    trimmedPayload.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi),
  ).map((match) => decodeHtmlEntities(match[1] ?? ''));

  return trimMultilineText(transcriptChunks.join(' '));
}

function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeSentimentValue(value: string) {
  const normalizedValue = normalizeComparableText(value);

  if (
    normalizedValue.includes('no brand mention') ||
    normalizedValue.includes('no target brand mention')
  ) {
    return 'no_brand_mentions';
  }

  if (normalizedValue.includes('unfavorable') || normalizedValue.includes('negative')) {
    return 'unfavorable';
  }

  if (normalizedValue.includes('favorable') || normalizedValue.includes('positive')) {
    return 'favorable';
  }

  if (normalizedValue.includes('neutral')) {
    return 'neutral';
  }

  if (normalizedValue.includes('review')) {
    return 'needs_review';
  }

  return 'unknown';
}

function clampConfidenceScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getEvidencePenalty(fetchStatus: SourceEvidence['status']) {
  if (fetchStatus === 'success') {
    return 0;
  }

  if (fetchStatus === 'partial') {
    return 18;
  }

  if (fetchStatus === 'insufficient_evidence') {
    return 42;
  }

  return 55;
}

function getConfidenceBase(
  confidence: LlmEvaluation['confidence'],
  evidenceSufficient: boolean,
) {
  if (!evidenceSufficient) {
    return 42;
  }

  if (confidence === 'high') {
    return 92;
  }

  if (confidence === 'medium') {
    return 76;
  }

  return 58;
}

function buildConfidenceScores(input: {
  extractedSentiment: string;
  llmResult: LlmEvaluation;
  fetchStatus: SourceEvidence['status'];
}) {
  const baseScore = getConfidenceBase(
    input.llmResult.confidence,
    input.llmResult.evidenceSufficient,
  );
  const evidencePenalty = getEvidencePenalty(input.fetchStatus);
  const normalizedExtractedSentiment = normalizeSentimentValue(input.extractedSentiment);
  const normalizedEvaluatedSentiment = normalizeSentimentValue(
    input.llmResult.evaluatedSentiment,
  );
  const sentimentMatches =
    normalizedExtractedSentiment !== 'unknown' &&
    normalizedExtractedSentiment === normalizedEvaluatedSentiment;

  let sentimentConfidence = baseScore - evidencePenalty;

  if (sentimentMatches) {
    sentimentConfidence += 4;
  } else if (
    normalizedExtractedSentiment !== 'unknown' &&
    normalizedEvaluatedSentiment !== 'needs_review'
  ) {
    sentimentConfidence -= 48;
  } else {
    sentimentConfidence -= 16;
  }

  return clampConfidenceScore(sentimentConfidence);
}

async function fetchYoutubeEvidence(itemUrl: string): Promise<SourceEvidence> {
  try {
    const html = await fetchText(itemUrl);
    const title =
      extractMetaTagValue(html, /<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      extractMetaTagValue(html, /<title>([^<]+)<\/title>/i);
    const description =
      extractMetaTagValue(
        html,
        /"shortDescription":"([^"]+)"/i,
      ) ||
      extractMetaTagValue(
        html,
        /<meta\s+name="description"\s+content="([^"]+)"/i,
      );

    const playerResponseJson =
      extractBalancedObjectLiteral(html, 'ytInitialPlayerResponse =') ??
      extractBalancedObjectLiteral(html, 'var ytInitialPlayerResponse =');
    let transcript = '';

    if (playerResponseJson) {
      try {
        const playerResponse = JSON.parse(playerResponseJson) as {
          captions?: {
            playerCaptionsTracklistRenderer?: {
              captionTracks?: Array<{
                baseUrl?: string;
                languageCode?: string;
                kind?: string;
              }>;
            };
          };
        };
        const captionTracks =
          playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        const transcriptTrack =
          captionTracks.find((track) => track.languageCode?.toLowerCase().startsWith('en')) ??
          captionTracks.find((track) => track.kind !== 'asr') ??
          captionTracks[0];

        if (transcriptTrack?.baseUrl) {
          const transcriptPayload = await fetchText(transcriptTrack.baseUrl);
          transcript = parseYouTubeTranscriptPayload(transcriptPayload);
        }
      } catch {
        transcript = '';
      }
    }

    const evidenceText = clampEvidenceText(
      trimMultilineText(
        [
          title ? `Title: ${title}` : '',
          description ? `Description: ${description}` : '',
          transcript ? `Transcript:\n${transcript}` : '',
        ].join('\n\n'),
      ),
    );
    const usedTranscript = transcript.length >= MIN_EVIDENCE_CHARACTERS;

    return {
      sourceType: 'youtube',
      sourceUrl: itemUrl,
      usedTranscript,
      status:
        evidenceText.length < MIN_EVIDENCE_CHARACTERS
          ? 'insufficient_evidence'
          : usedTranscript
            ? 'success'
            : 'partial',
      evidenceText,
      fallbackSnippet: title || description || 'YouTube evidence could not be extracted.',
    };
  } catch {
    return {
      sourceType: 'youtube',
      sourceUrl: itemUrl,
      usedTranscript: false,
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Failed to fetch YouTube content.',
    };
  }
}

function normalizeAbsoluteUrl(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    return trimmedValue;
  }

  return `https://${trimmedValue.replace(/^\/+/, '')}`;
}

function buildRedditJsonUrls(itemUrl: string) {
  try {
    const normalizedValue = normalizeAbsoluteUrl(itemUrl);

    if (!normalizedValue) {
      return [];
    }

    const parsedUrl = new URL(normalizedValue);
    const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
    const hostCandidates = [
      'api.reddit.com',
      parsedUrl.hostname,
      parsedUrl.hostname.replace(/^old\./i, 'www.'),
      'old.reddit.com',
      'www.reddit.com',
    ];

    return Array.from(new Set(hostCandidates)).map((host) => {
      const baseUrl = `${parsedUrl.protocol}//${host}${normalizedPath}`;
      return baseUrl.endsWith('.json')
        ? `${baseUrl}?raw_json=1&limit=8`
        : `${baseUrl}.json?raw_json=1&limit=8`;
    });
  } catch {
    return [];
  }
}

function buildRedditHtmlUrls(itemUrl: string) {
  try {
    const normalizedValue = normalizeAbsoluteUrl(itemUrl);

    if (!normalizedValue) {
      return [];
    }

    const parsedUrl = new URL(normalizedValue);
    const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
    const hostCandidates = [
      parsedUrl.hostname,
      parsedUrl.hostname.replace(/^www\./i, 'old.'),
      'old.reddit.com',
      'www.reddit.com',
    ];

    return Array.from(new Set(hostCandidates)).map(
      (host) => `${parsedUrl.protocol}//${host}${normalizedPath}`,
    );
  } catch {
    return [];
  }
}

async function fetchRedditEvidence(itemUrl: string): Promise<SourceEvidence> {
  const jsonUrls = buildRedditJsonUrls(itemUrl);
  let lastFetchError = '';

  for (const jsonUrl of jsonUrls) {
    try {
      const payload = await fetchText(jsonUrl);
      const parsedPayload = JSON.parse(payload) as Array<{
        data?: {
          children?: Array<{
            data?: {
              title?: string;
              selftext?: string;
              body?: string;
            };
          }>;
        };
      }>;
      const post = parsedPayload[0]?.data?.children?.[0]?.data;
      const comments = (parsedPayload[1]?.data?.children ?? [])
        .map((entry) => entry.data?.body?.trim())
        .filter((value): value is string => Boolean(value))
        .slice(0, 6);
      const evidenceText = clampEvidenceText(
        trimMultilineText(
          [
            post?.title ? `Post title: ${post.title}` : '',
            post?.selftext ? `Post body:\n${post.selftext}` : '',
            comments.length > 0 ? `Comments:\n${comments.join('\n')}` : '',
          ].join('\n\n'),
        ),
      );

      return {
        sourceType: 'reddit',
        sourceUrl: jsonUrl,
        usedTranscript: false,
        status:
          evidenceText.length >= MIN_EVIDENCE_CHARACTERS
            ? 'success'
            : 'insufficient_evidence',
        evidenceText,
        fallbackSnippet: post?.title ?? 'Reddit evidence could not be extracted.',
      };
    } catch (error) {
      lastFetchError = error instanceof Error ? error.message : 'Unknown fetch error.';
      continue;
    }
  }

  const htmlUrls = buildRedditHtmlUrls(itemUrl);

  for (const htmlUrl of htmlUrls) {
    try {
      const html = await fetchText(htmlUrl);
      const title =
        extractMetaTagValue(html, /<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
        extractMetaTagValue(html, /<title>([^<]+)<\/title>/i);
      const description =
        extractMetaTagValue(html, /<meta\s+name="description"\s+content="([^"]+)"/i) ||
        extractMetaTagValue(html, /<meta\s+property="og:description"\s+content="([^"]+)"/i);
      const pageText = stripHtmlTags(html);
      const evidenceText = clampEvidenceText(
        trimMultilineText(
          [
            title ? `Post title: ${title}` : '',
            description ? `Description: ${description}` : '',
            pageText ? `Page content:\n${pageText}` : '',
          ].join('\n\n'),
        ),
      );

      if (!evidenceText) {
        continue;
      }

      return {
        sourceType: 'reddit',
        sourceUrl: htmlUrl,
        usedTranscript: false,
        status:
          evidenceText.length >= MIN_EVIDENCE_CHARACTERS
            ? 'partial'
            : 'insufficient_evidence',
        evidenceText,
        fallbackSnippet: title || description || 'Reddit evidence could not be extracted.',
      };
    } catch (error) {
      lastFetchError = error instanceof Error ? error.message : 'Unknown fetch error.';
      continue;
    }
  }

  return {
    sourceType: 'reddit',
    sourceUrl: itemUrl,
    usedTranscript: false,
    status: 'fetch_failed',
    evidenceText: '',
    fallbackSnippet: lastFetchError
      ? `Failed to fetch Reddit content. ${lastFetchError}`
      : 'Failed to fetch Reddit content.',
  }
}

async function fetchWebEvidence(itemUrl: string): Promise<SourceEvidence> {
  try {
    const html = await fetchText(itemUrl);
    const title =
      extractMetaTagValue(html, /<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      extractMetaTagValue(html, /<title>([^<]+)<\/title>/i);
    const description =
      extractMetaTagValue(html, /<meta\s+name="description"\s+content="([^"]+)"/i) ||
      extractMetaTagValue(html, /<meta\s+property="og:description"\s+content="([^"]+)"/i);
    const pageText = stripHtmlTags(html);
    const evidenceText = clampEvidenceText(
      trimMultilineText(
        [
          title ? `Title: ${title}` : '',
          description ? `Description: ${description}` : '',
          pageText ? `Page content:\n${pageText}` : '',
        ].join('\n\n'),
      ),
    );

    return {
      sourceType: 'web',
      sourceUrl: itemUrl,
      usedTranscript: false,
      status:
        evidenceText.length >= MIN_EVIDENCE_CHARACTERS
          ? 'success'
          : 'insufficient_evidence',
      evidenceText,
      fallbackSnippet: title || description || 'Page evidence could not be extracted.',
    };
  } catch {
    return {
      sourceType: 'web',
      sourceUrl: itemUrl,
      usedTranscript: false,
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Failed to fetch page content.',
    };
  }
}

async function fetchEvidenceForRequest(
  payload: SentimentEvaluationRequest,
): Promise<SourceEvidence> {
  if (payload.opportunityType === 'YouTube') {
    return fetchYoutubeEvidence(payload.item);
  }

  if (payload.opportunityType === 'Reddit') {
    return fetchRedditEvidence(payload.item);
  }

  return fetchWebEvidence(payload.item);
}

function buildLlmPrompt(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
) {
  return [
    'You are an off-site SEO/GEO analyst verifying extracted sentiment for off-site citations.',
    'Review the evidence and determine whether the extracted sentiment is supported.',
    'The target brand is the brand/company associated with the site URL.',
    '',
    `Site URL: ${payload.site}`,
    `Site ID: ${payload.siteId ?? 'Unknown'}`,
    `Opportunity Type: ${payload.opportunityType}`,
    `Opportunity ID: ${payload.opportunityId}`,
    `Item URL: ${payload.item}`,
    `Extracted Sentiment: ${payload.extractedSentiment || 'None'}`,
    '',
    'Return a grounded judgment from the evidence only.',
    'If the evidence is too weak to support a confident judgment, set evidenceSufficient to false and use "Needs Review" for evaluatedSentiment.',
    '',
    'Evidence:',
    evidence.evidenceText,
  ].join('\n');
}

async function fetchLlmEvaluation(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
  env: ServerEnv,
) {
  const azureBaseUrl = normalizeAzureOpenAiBaseUrl(env.AZURE_OPENAI_ENDPOINT);
  const azureApiKey = env.AZURE_OPENAI_KEY?.trim();
  const useAzure = Boolean(azureBaseUrl && azureApiKey);
  const apiKey = useAzure ? azureApiKey : env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      useAzure
        ? 'AZURE_OPENAI_KEY is missing.'
        : 'OPENAI_API_KEY or AZURE_OPENAI_KEY is missing.',
    );
  }

  const modelName =
    (useAzure
      ? env.AZURE_OPENAI_DEPLOYMENT?.trim()
      : env.OPENAI_EVALUATOR_MODEL?.trim()) ||
    env.OPENAI_EVALUATOR_MODEL?.trim() ||
    DEFAULT_OPENAI_MODEL;

  const requestBody = {
    model: modelName,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildLlmPrompt(payload, evidence),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'offsite_sentiment_evaluation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetBrand: { type: 'string' },
            evaluatedSentiment: {
              type: 'string',
              enum: [
                'Favorable',
                'Neutral',
                'Unfavorable',
                'No brand mentions',
                'Needs Review',
              ],
            },
            evidenceSufficient: { type: 'boolean' },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            rationale: { type: 'string' },
            evidenceSnippet: { type: 'string' },
          },
          required: [
            'targetBrand',
            'evaluatedSentiment',
            'evidenceSufficient',
            'confidence',
            'rationale',
            'evidenceSnippet',
          ],
        },
      },
    },
    max_output_tokens: 700,
  };
  const response = await fetch(
    useAzure ? `${azureBaseUrl}responses` : OPENAI_API_URL,
    {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(useAzure
        ? {
            'api-key': apiKey,
          }
        : {
            authorization: `Bearer ${apiKey}`,
          }),
    },
    body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `OpenAI request failed with ${response.status}`);
  }

  const parsedPayload = await response.json();
  const parsedStructuredOutput = Array.isArray(parsedPayload.output)
    ? parsedPayload.output
        .flatMap(
          (entry: {
            content?: Array<{ parsed?: unknown; text?: string }>;
          }) =>
          entry.content ?? [],
        )
        .find((content: { parsed?: unknown }) => Boolean(content.parsed))?.parsed
    : null;
  const outputTextFromContent = Array.isArray(parsedPayload.output)
    ? parsedPayload.output
        .flatMap(
          (entry: {
            content?: Array<{ parsed?: unknown; text?: string }>;
          }) => entry.content ?? [],
        )
        .map((content: { text?: string }) => content.text)
        .find((text: unknown) => typeof text === 'string' && text.trim())
    : null;
  const parsedOutput =
    parsedPayload.output_parsed ??
    parsedStructuredOutput ??
    (() => {
      const outputText =
        typeof parsedPayload.output_text === 'string'
          ? parsedPayload.output_text
          : typeof outputTextFromContent === 'string'
            ? outputTextFromContent
            : null;

      if (!outputText) {
        return null;
      }

      try {
        return JSON.parse(outputText);
      } catch {
        return null;
      }
    })();

  if (
    !parsedOutput ||
    typeof parsedOutput !== 'object' ||
    Array.isArray(parsedOutput)
  ) {
    throw new Error('Failed to parse evaluator response.');
  }

  return parsedOutput as LlmEvaluation;
}

export async function runOffsiteEvaluation(
  rawPayload: unknown,
  env: ServerEnv = {},
): Promise<SentimentEvaluationResult> {
  const payload = normalizeRequestPayload(rawPayload);

  if (!payload) {
    throw new Error('Invalid evaluator request payload.');
  }

  const evidence = await fetchEvidenceForRequest(payload);

  if (
    evidence.status === 'fetch_failed' ||
    evidence.status === 'insufficient_evidence'
  ) {
    const weakEvidenceScore =
      evidence.status === 'fetch_failed' ? 12 : 28;

    return {
      evaluatedSentiment: 'Needs Review',
      sentimentConfidence: weakEvidenceScore,
      rationale:
        evidence.status === 'fetch_failed'
          ? 'The source content could not be fetched for an independent check.'
          : 'The fetched content did not provide enough evidence for a reliable judgment.',
      evidenceSnippet: evidence.fallbackSnippet,
      evaluatedAt: new Date().toISOString(),
      evaluatorVersion: SENTIMENT_EVALUATOR_VERSION,
      fetch: {
        status: evidence.status,
        sourceType: evidence.sourceType,
        sourceUrl: evidence.sourceUrl,
        usedTranscript: evidence.usedTranscript,
        evidenceCharacters: evidence.evidenceText.length,
      },
      targetBrand: '',
    };
  }

  const llmResult = await fetchLlmEvaluation(payload, evidence, env);
  const sentimentConfidence = buildConfidenceScores({
    extractedSentiment: payload.extractedSentiment,
    llmResult,
    fetchStatus: evidence.status,
  });

  return {
    evaluatedSentiment: llmResult.evaluatedSentiment,
    sentimentConfidence,
    rationale: trimMultilineText(llmResult.rationale),
    evidenceSnippet:
      trimMultilineText(llmResult.evidenceSnippet) || evidence.fallbackSnippet,
    evaluatedAt: new Date().toISOString(),
    evaluatorVersion: SENTIMENT_EVALUATOR_VERSION,
    fetch: {
      status: evidence.status,
      sourceType: evidence.sourceType,
      sourceUrl: evidence.sourceUrl,
      usedTranscript: evidence.usedTranscript,
      evidenceCharacters: evidence.evidenceText.length,
    },
    targetBrand: llmResult.targetBrand,
  };
}

export async function handleOffsiteEvaluateRequest(
  request: Request,
  env: ServerEnv = {},
) {
  if (request.method !== 'POST') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const payload = await request.json();
    const result = await runOffsiteEvaluation(payload, env);
    return buildJsonResponse(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unexpected evaluation error.';

    return buildJsonResponse({ error: message }, 500);
  }
}
