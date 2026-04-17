import { SENTIMENT_EVALUATOR_VERSION } from '../src/features/off-site-dashboard/constants.js';
import type {
  CanonicalOpportunityType,
  SentimentEvaluationRequest,
  SentimentEvaluationResult,
} from '../src/features/off-site-dashboard/types.js';

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
const DEFAULT_BRIGHTDATA_WEB_UNLOCKER_ZONE = 'web_unlocker1';
const DEFAULT_BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID = 'gd_lk56epmy2i5g7lzu0k';
const DEFAULT_BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID = 'gd_lk9q0ew71spt1mxywf';
const DEFAULT_BRIGHTDATA_REDDIT_POST_DATASET_ID = 'gd_lvz8ah06191smkebj4';
const DEFAULT_BRIGHTDATA_REDDIT_COMMENT_DATASET_ID = 'gd_lvzdpsdlw09j6t702';
const BEDROCK_MODEL_FALLBACKS = [
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
] as const;
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const REQUEST_USER_AGENT =
  'Mozilla/5.0 (compatible; OffSiteDashboardEvaluator/1.0; +https://vercel.com)';
const MAX_EVIDENCE_CHARACTERS = 14000;
const MIN_EVIDENCE_CHARACTERS = 180;

type ServerEnv = {
  AWS_BEARER_TOKEN_BEDROCK?: string;
  BEDROCK_BEARER_TOKEN?: string;
  AWS_REGION?: string;
  BEDROCK_REGION?: string;
  BEDROCK_MODEL_ID?: string;
  BEDROCK_MODEL?: string;
  BRIGHTDATA_API_KEY?: string;
  BRIGHTDATA_WEB_UNLOCKER_ZONE?: string;
  BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID?: string;
  BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID?: string;
  BRIGHTDATA_YOUTUBE_TRANSCRIPTION_LANGUAGE?: string;
  BRIGHTDATA_REDDIT_POST_DATASET_ID?: string;
  BRIGHTDATA_REDDIT_COMMENT_DATASET_ID?: string;
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
  usedComments: boolean;
  transcriptStatus:
    | 'available_and_used'
    | 'available_but_not_used'
    | 'not_available'
    | 'not_applicable'
    | 'unknown';
  status: 'success' | 'partial' | 'insufficient_evidence' | 'fetch_failed';
  evidenceText: string;
  fallbackSnippet: string;
};

type LlmEvaluation = {
  targetBrand: string;
  targetBrandMentionCount: number;
  evaluatedSentiment: string;
  brandMentions: Array<{
    brand: string;
    mentionCount: number;
  }>;
  evidenceSufficient: boolean;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  evidenceSnippet: string;
};

type LlmEvaluationResponse = {
  evaluation: LlmEvaluation;
  provider: 'bedrock' | 'azure' | 'openai';
  model: string;
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
  return env.BEDROCK_MODEL_ID ?? env.BEDROCK_MODEL;
}

function getBrightDataApiKey(env: ServerEnv) {
  return env.BRIGHTDATA_API_KEY?.trim() || '';
}

function getBrightDataUnlockerZone(env: ServerEnv) {
  return env.BRIGHTDATA_WEB_UNLOCKER_ZONE?.trim() || DEFAULT_BRIGHTDATA_WEB_UNLOCKER_ZONE;
}

function getBrightDataYoutubeVideoDatasetId(env: ServerEnv) {
  return (
    env.BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID?.trim() ||
    DEFAULT_BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID
  );
}

function getBrightDataYoutubeCommentDatasetId(env: ServerEnv) {
  return (
    env.BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID?.trim() ||
    DEFAULT_BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID
  );
}

function getBrightDataRedditPostDatasetId(env: ServerEnv) {
  return (
    env.BRIGHTDATA_REDDIT_POST_DATASET_ID?.trim() ||
    DEFAULT_BRIGHTDATA_REDDIT_POST_DATASET_ID
  );
}

function getBrightDataRedditCommentDatasetId(env: ServerEnv) {
  return (
    env.BRIGHTDATA_REDDIT_COMMENT_DATASET_ID?.trim() ||
    DEFAULT_BRIGHTDATA_REDDIT_COMMENT_DATASET_ID
  );
}

function getBedrockModelCandidates(preferredModel?: string) {
  const candidates = [
    preferredModel?.trim(),
    ...BEDROCK_MODEL_FALLBACKS,
    DEFAULT_BEDROCK_MODEL,
  ];

  return candidates.filter(
    (value, index): value is string =>
      Boolean(value) && candidates.indexOf(value) === index,
  );
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
    typeof candidate.extractedSov !== 'string' ||
    typeof candidate.extractedSentiment !== 'string'
  ) {
    return null;
  }

  const title =
    typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const timesCited =
    typeof candidate.timesCited === 'number' && Number.isFinite(candidate.timesCited)
      ? candidate.timesCited
      : undefined;

  return {
    site: candidate.site,
    siteId: typeof candidate.siteId === 'string' ? candidate.siteId : undefined,
    opportunityType: candidate.opportunityType as CanonicalOpportunityType,
    opportunityId: candidate.opportunityId,
    item: candidate.item,
    ...(title ? { title } : {}),
    extractedSov: candidate.extractedSov,
    extractedSentiment: candidate.extractedSentiment,
    ...(typeof timesCited === 'number' ? { timesCited } : {}),
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

async function fetchBrightDataUnlockerBody(
  targetUrl: string,
  env: ServerEnv,
  dataFormat: 'markdown' | 'raw' = 'markdown',
) {
  const apiKey = getBrightDataApiKey(env);

  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is missing.');
  }

  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      zone: getBrightDataUnlockerZone(env),
      url: targetUrl,
      format: 'json',
      method: 'GET',
      data_format: dataFormat,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Bright Data unlocker failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    status_code?: number;
    body?: string;
  };

  if (typeof payload.status_code === 'number' && payload.status_code >= 400) {
    throw new Error(`Bright Data unlocker target failed with ${payload.status_code}`);
  }

  if (typeof payload.body !== 'string' || !payload.body.trim()) {
    throw new Error('Bright Data unlocker returned an empty body.');
  }

  return payload.body;
}

async function fetchBrightDataYoutubeEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  const apiKey = getBrightDataApiKey(env);

  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is missing.');
  }

  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(
      getBrightDataYoutubeVideoDatasetId(env),
    )}&notify=false&include_errors=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: [
          {
            url: itemUrl,
            country: '',
            transcription_language:
              env.BRIGHTDATA_YOUTUBE_TRANSCRIPTION_LANGUAGE?.trim() || 'en',
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Bright Data YouTube scrape failed with ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  const firstResult = payload[0];

  if (!firstResult || typeof firstResult !== 'object') {
    throw new Error('Bright Data YouTube scrape returned no results.');
  }

  const title = trimMultilineText(String(firstResult.title ?? ''));
  const description = trimMultilineText(String(firstResult.description ?? ''));
  const transcript = trimMultilineText(
    String(firstResult.formatted_transcript ?? firstResult.transcript ?? ''),
  );
  const channelName = trimMultilineText(String(firstResult.youtuber ?? ''));
  const channelUrl = trimMultilineText(String(firstResult.channel_url ?? ''));

  const evidenceText = clampEvidenceText(
    trimMultilineText(
      [
        title ? `Title: ${title}` : '',
        description ? `Description: ${description}` : '',
        channelName ? `Channel: ${channelName}` : '',
        channelUrl ? `Channel URL: ${channelUrl}` : '',
        transcript ? `Transcript:\n${transcript}` : '',
      ].join('\n\n'),
    ),
  );
  const usedTranscript = transcript.length >= MIN_EVIDENCE_CHARACTERS;

  return {
    sourceType: 'youtube',
    sourceUrl: itemUrl,
    usedTranscript,
    usedComments: false,
    transcriptStatus: transcript
      ? usedTranscript
        ? 'available_and_used'
        : 'available_but_not_used'
      : 'not_available',
    status:
      evidenceText.length < MIN_EVIDENCE_CHARACTERS
        ? 'insufficient_evidence'
        : usedTranscript
          ? 'success'
          : 'partial',
    evidenceText,
    fallbackSnippet:
      title ||
      description ||
      'Bright Data YouTube evidence could not be extracted.',
  };
}

function extractBrightDataCommentText(entry: Record<string, unknown>) {
  const textCandidates = [
    entry.comment,
    entry.comment_text,
    entry.text,
    entry.content,
    entry.comment_content,
  ];

  for (const candidate of textCandidates) {
    const normalizedCandidate = trimMultilineText(String(candidate ?? ''));

    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  return '';
}

function collectBrightDataCommentTexts(entries: unknown, limit = 20) {
  const comments: string[] = [];

  const visitEntry = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return;
    }

    const normalizedEntry = entry as Record<string, unknown>;
    const commentText = extractBrightDataCommentText(normalizedEntry);

    if (commentText) {
      comments.push(commentText);
    }

    if (comments.length >= limit) {
      return;
    }

    for (const nestedKey of ['replies', 'comments']) {
      const nestedEntries = normalizedEntry[nestedKey];

      if (Array.isArray(nestedEntries)) {
        for (const nestedEntry of nestedEntries) {
          if (comments.length >= limit) {
            break;
          }

          visitEntry(nestedEntry);
        }
      }
    }
  };

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (comments.length >= limit) {
        break;
      }

      visitEntry(entry);
    }
  } else if (entries && typeof entries === 'object') {
    const normalizedEntries = entries as Record<string, unknown>;
    const commentsArray = normalizedEntries.comments;

    if (Array.isArray(commentsArray)) {
      for (const entry of commentsArray) {
        if (comments.length >= limit) {
          break;
        }

        visitEntry(entry);
      }
    } else {
      visitEntry(entries);
    }
  }

  return comments.slice(0, limit);
}

async function fetchBrightDataYoutubeCommentTexts(
  itemUrl: string,
  env: ServerEnv,
) {
  const apiKey = getBrightDataApiKey(env);

  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is missing.');
  }

  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(
      getBrightDataYoutubeCommentDatasetId(env),
    )}&notify=false&include_errors=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: [
          {
            url: itemUrl,
            sort_by: '',
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      errorText || `Bright Data YouTube comments scrape failed with ${response.status}`,
    );
  }

  const payload = (await response.json()) as unknown;
  return collectBrightDataCommentTexts(payload);
}

async function fetchBrightDataRedditEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  const apiKey = getBrightDataApiKey(env);

  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is missing.');
  }

  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(
      getBrightDataRedditPostDatasetId(env),
    )}&notify=false&include_errors=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: [{ url: itemUrl }],
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Bright Data Reddit scrape failed with ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const firstResult = Array.isArray(payload) ? payload[0] : payload;

  if (!firstResult || typeof firstResult !== 'object') {
    throw new Error('Bright Data Reddit scrape returned no results.');
  }

  return buildBrightDataRedditEvidence(itemUrl, firstResult);
}

function collectBrightDataRedditComments(entries: unknown, limit = 12) {
  const comments: string[] = [];

  const visitEntry = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return;
    }

    const commentText = trimMultilineText(
      String((entry as { comment?: unknown }).comment ?? ''),
    );

    if (commentText) {
      comments.push(commentText);
    }

    if (comments.length >= limit) {
      return;
    }

    const replies = (entry as { replies?: unknown }).replies;

    if (Array.isArray(replies)) {
      for (const reply of replies) {
        if (comments.length >= limit) {
          break;
        }

        visitEntry(reply);
      }
    }
  };

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (comments.length >= limit) {
        break;
      }

      visitEntry(entry);
    }
  }

  return comments.slice(0, limit);
}

function buildBrightDataRedditEvidence(
  itemUrl: string,
  firstResult: Record<string, unknown>,
): SourceEvidence {
  const title = trimMultilineText(String(firstResult.title ?? ''));
  const description = trimMultilineText(String(firstResult.description ?? ''));
  const community = trimMultilineText(String(firstResult.community_name ?? ''));
  const communityDescription = trimMultilineText(
    String(firstResult.community_description ?? ''),
  );
  const comments = collectBrightDataRedditComments(firstResult.comments);
  const evidenceText = clampEvidenceText(
    trimMultilineText(
      [
        title ? `Post title: ${title}` : '',
        description ? `Post body:\n${description}` : '',
        community ? `Community: ${community}` : '',
        communityDescription
          ? `Community description:\n${communityDescription}`
          : '',
        comments.length > 0 ? `Comments:\n${comments.join('\n')}` : '',
      ].join('\n\n'),
    ),
  );

  return {
    sourceType: 'reddit',
    sourceUrl: itemUrl,
    usedTranscript: false,
    usedComments: comments.length > 0,
    transcriptStatus: 'not_applicable',
    status:
      evidenceText.length >= MIN_EVIDENCE_CHARACTERS
        ? 'success'
        : 'insufficient_evidence',
    evidenceText,
    fallbackSnippet:
      title || description || 'Bright Data Reddit evidence could not be extracted.',
  };
}

function isRedditCommentUrl(itemUrl: string) {
  return /\/comment\/[a-z0-9]+/i.test(itemUrl);
}

async function fetchBrightDataRedditCommentEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  const apiKey = getBrightDataApiKey(env);

  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is missing.');
  }

  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(
      getBrightDataRedditCommentDatasetId(env),
    )}&notify=false&include_errors=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: [
          {
            url: itemUrl,
            days_back: 365,
            load_all_replies: true,
            comment_limit: '',
            sort_by: '',
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      errorText || `Bright Data Reddit comment scrape failed with ${response.status}`,
    );
  }

  const payload = (await response.json()) as unknown;
  const firstResult = Array.isArray(payload) ? payload[0] : payload;

  if (!firstResult || typeof firstResult !== 'object') {
    throw new Error('Bright Data Reddit comment scrape returned no results.');
  }

  return buildBrightDataRedditEvidence(itemUrl, firstResult);
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

function parsePercentageValue(value: string) {
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/);

  if (!match) {
    return null;
  }

  const parsedValue = Number.parseFloat(match[1]);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

type BrandShare = {
  brand: string;
  sharePct: number;
};

function normalizeBrandKey(value: string) {
  return normalizeComparableText(value);
}

function isIgnorableSovBrand(value: string) {
  const normalizedValue = normalizeBrandKey(value);

  return (
    !normalizedValue ||
    normalizedValue === 'market' ||
    normalizedValue === 'others' ||
    normalizedValue.startsWith('others ') ||
    normalizedValue === 'other' ||
    normalizedValue.startsWith('other ')
  );
}

function addBrandShare(
  nextShares: BrandShare[],
  seenBrands: Set<string>,
  brand: string,
  sharePct: number,
) {
  const cleanedBrand = trimMultilineText(
    decodeHtmlEntities(brand.replace(/\*\*/g, '')).replace(/^[•·\-\s]+/, ''),
  );
  const normalizedBrand = normalizeBrandKey(cleanedBrand);

  if (
    isIgnorableSovBrand(cleanedBrand) ||
    !Number.isFinite(sharePct) ||
    sharePct < 0 ||
    seenBrands.has(normalizedBrand)
  ) {
    return;
  }

  seenBrands.add(normalizedBrand);
  nextShares.push({
    brand: cleanedBrand,
    sharePct,
  });
}

function extractSovBrandShares(extractedSov: string, targetBrand?: string) {
  const normalizedSov = trimMultilineText(
    decodeHtmlEntities(extractedSov).replace(/<br\s*\/?>/gi, '\n'),
  );
  const lines = normalizedSov
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const parsedShares: BrandShare[] = [];
  const seenBrands = new Set<string>();

  for (const line of lines) {
    const cleanedLine = line.replace(/^[•·\-\s]+/, '').trim();

    if (!cleanedLine || !cleanedLine.includes('%')) {
      continue;
    }

    const colonIndex = cleanedLine.indexOf(':');

    if (colonIndex !== -1) {
      const leftValue = cleanedLine.slice(0, colonIndex).trim();
      const rightValue = cleanedLine.slice(colonIndex + 1).trim();

      if (rightValue.includes(',') || rightValue.match(/\d+(?:\.\d+)?\s*%/g)?.length) {
        const rightSegments = rightValue
          .split(',')
          .map((segment) => segment.trim())
          .filter(Boolean);

        if (rightSegments.length > 1) {
          for (const segment of rightSegments) {
            const sharePct = parsePercentageValue(segment);

            if (sharePct === null) {
              continue;
            }

            addBrandShare(
              parsedShares,
              seenBrands,
              segment.replace(/\s*\d+(?:\.\d+)?\s*%.*$/, '').trim(),
              sharePct,
            );
          }

          continue;
        }
      }

      const sharePct = parsePercentageValue(rightValue);

      if (sharePct !== null) {
        addBrandShare(parsedShares, seenBrands, leftValue, sharePct);
        continue;
      }
    }

    const segments = cleanedLine
      .split(',')
      .map((segment) => segment.trim())
      .filter(Boolean);

    for (const segment of segments) {
      const sharePct = parsePercentageValue(segment);

      if (sharePct === null) {
        continue;
      }

      addBrandShare(
        parsedShares,
        seenBrands,
        segment.replace(/\s*\d+(?:\.\d+)?\s*%.*$/, '').trim(),
        sharePct,
      );
    }
  }

  const normalizedTargetBrand = targetBrand ? normalizeBrandKey(targetBrand) : '';

  if (
    normalizedTargetBrand &&
    !seenBrands.has(normalizedTargetBrand) &&
    !isIgnorableSovBrand(targetBrand ?? '')
  ) {
    parsedShares.unshift({
      brand: trimMultilineText(targetBrand ?? ''),
      sharePct: 0,
    });
  }

  return parsedShares;
}

function buildEvaluatedBrandShares(input: {
  extractedBrandShares: BrandShare[];
  llmResult: LlmEvaluation;
}) {
  const mentionCounts = new Map<string, { brand: string; mentionCount: number }>();

  for (const brandMention of input.llmResult.brandMentions) {
    const cleanedBrand = trimMultilineText(brandMention.brand);
    const normalizedBrand = normalizeBrandKey(cleanedBrand);

    if (!normalizedBrand || isIgnorableSovBrand(cleanedBrand)) {
      continue;
    }

    mentionCounts.set(normalizedBrand, {
      brand: cleanedBrand,
      mentionCount: Math.max(0, Math.round(brandMention.mentionCount)),
    });
  }

  const targetBrand = trimMultilineText(input.llmResult.targetBrand);
  const targetBrandKey = normalizeBrandKey(targetBrand);
  const orderedBrands = input.extractedBrandShares.map((share) => share.brand);

  if (
    targetBrandKey &&
    !orderedBrands.some((brand) => normalizeBrandKey(brand) === targetBrandKey)
  ) {
    orderedBrands.unshift(targetBrand);
  }

  const evaluatedBrands = orderedBrands.map((brand) => {
    const normalizedBrand = normalizeBrandKey(brand);
    const mentionCount =
      normalizedBrand === targetBrandKey
        ? Math.max(0, Math.round(input.llmResult.targetBrandMentionCount))
        : mentionCounts.get(normalizedBrand)?.mentionCount ?? 0;

    return {
      brand,
      mentionCount,
    };
  });
  const totalMentions = evaluatedBrands.reduce(
    (sum, brand) => sum + brand.mentionCount,
    0,
  );

  return evaluatedBrands.map((brand) => ({
    brand: brand.brand,
    sharePct: totalMentions > 0 ? (brand.mentionCount / totalMentions) * 100 : 0,
  }));
}

function formatSharePct(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatEvaluatedSov(brandShares: BrandShare[]) {
  const visibleShares = brandShares.filter(
    (share, index) => index === 0 || share.sharePct > 0,
  );

  if (visibleShares.length === 0) {
    return 'Needs Review';
  }

  return visibleShares
    .map((share) => `${share.brand}: ${formatSharePct(share.sharePct)}`)
    .join(', ');
}

function getTargetBrandSharePct(brandShares: BrandShare[], targetBrand: string) {
  const normalizedTargetBrand = normalizeBrandKey(targetBrand);

  if (!normalizedTargetBrand) {
    return -1;
  }

  return (
    brandShares.find((share) => normalizeBrandKey(share.brand) === normalizedTargetBrand)
      ?.sharePct ?? 0
  );
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

function buildSovConfidenceScore(input: {
  extractedBrandShares: BrandShare[];
  evaluatedBrandShares: BrandShare[];
  llmResult: LlmEvaluation;
  fetchStatus: SourceEvidence['status'];
}) {
  const baseScore = getConfidenceBase(
    input.llmResult.confidence,
    input.llmResult.evidenceSufficient,
  );
  const evidencePenalty = getEvidencePenalty(input.fetchStatus);
  let sovConfidence = baseScore - evidencePenalty;

  if (!input.llmResult.evidenceSufficient) {
    return clampConfidenceScore(sovConfidence - 16);
  }

  const extractedShareMap = new Map(
    input.extractedBrandShares.map((share) => [normalizeBrandKey(share.brand), share.sharePct]),
  );
  const evaluatedShareMap = new Map(
    input.evaluatedBrandShares.map((share) => [normalizeBrandKey(share.brand), share.sharePct]),
  );
  const comparedBrands = Array.from(
    new Set([
      ...input.extractedBrandShares.map((share) => normalizeBrandKey(share.brand)),
      ...input.evaluatedBrandShares.map((share) => normalizeBrandKey(share.brand)),
    ]),
  ).filter(Boolean);

  if (comparedBrands.length === 0) {
    return clampConfidenceScore(sovConfidence - 18);
  }

  let maxShareDelta = 0;

  for (const brand of comparedBrands) {
    const extractedShare = extractedShareMap.get(brand) ?? 0;
    const evaluatedShare = evaluatedShareMap.get(brand) ?? 0;
    maxShareDelta = Math.max(maxShareDelta, Math.abs(extractedShare - evaluatedShare));
  }

  if (maxShareDelta <= 1) {
    sovConfidence = Math.max(sovConfidence, 89);
  } else if (maxShareDelta <= 5) {
    sovConfidence += 4;
  } else if (maxShareDelta <= 10) {
    sovConfidence -= 10;
  } else if (maxShareDelta <= 20) {
    sovConfidence -= 24;
  } else if (maxShareDelta <= 30) {
    sovConfidence -= 40;
  } else {
    sovConfidence -= 56;
  }

  return clampConfidenceScore(sovConfidence);
}

async function fetchYoutubeEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  if (getBrightDataApiKey(env)) {
    try {
      return await fetchBrightDataYoutubeEvidence(itemUrl, env);
    } catch {
      // Fall through to direct fetch if Bright Data is unavailable for this item.
    }
  }

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
    let transcriptStatus: SourceEvidence['transcriptStatus'] = 'unknown';

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

        if (!transcriptTrack?.baseUrl) {
          transcriptStatus = 'not_available';
        }

        if (transcriptTrack?.baseUrl) {
          const transcriptPayload = await fetchText(transcriptTrack.baseUrl);
          transcript = parseYouTubeTranscriptPayload(transcriptPayload);
          transcriptStatus =
            transcript.length >= MIN_EVIDENCE_CHARACTERS
              ? 'available_and_used'
              : 'available_but_not_used';
        }
      } catch {
        transcript = '';
        transcriptStatus = 'unknown';
      }
    } else {
      transcriptStatus = 'unknown';
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
        usedComments: false,
        transcriptStatus,
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
      usedComments: false,
      transcriptStatus: 'unknown',
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

async function fetchRedditEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  if (getBrightDataApiKey(env)) {
    try {
      return isRedditCommentUrl(itemUrl)
        ? await fetchBrightDataRedditCommentEvidence(itemUrl, env)
        : await fetchBrightDataRedditEvidence(itemUrl, env);
    } catch {
      // Fall back to Unlocker and then the legacy Reddit fetch path.
    }
  }

  if (getBrightDataApiKey(env)) {
    try {
      const brightDataBody = await fetchBrightDataUnlockerBody(itemUrl, env, 'markdown');
      const pageText = clampEvidenceText(trimMultilineText(brightDataBody));

      if (pageText.length >= MIN_EVIDENCE_CHARACTERS) {
        return {
          sourceType: 'reddit',
          sourceUrl: itemUrl,
          usedTranscript: false,
          usedComments: false,
          transcriptStatus: 'not_applicable',
          status: 'success',
          evidenceText: pageText,
          fallbackSnippet: pageText.slice(0, 280),
        };
      }
    } catch {
      // Fall back to the existing Reddit fetch path.
    }
  }

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
        usedComments: comments.length > 0,
        transcriptStatus: 'not_applicable',
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
        usedComments: false,
        transcriptStatus: 'not_applicable',
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
    usedComments: false,
    transcriptStatus: 'not_applicable',
    status: 'fetch_failed',
    evidenceText: '',
    fallbackSnippet: lastFetchError
      ? `Failed to fetch Reddit content. ${lastFetchError}`
      : 'Failed to fetch Reddit content.',
  }
}

async function fetchWebEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  if (getBrightDataApiKey(env)) {
    try {
      const brightDataBody = await fetchBrightDataUnlockerBody(itemUrl, env, 'markdown');
      const pageText = clampEvidenceText(trimMultilineText(brightDataBody));

      if (pageText.length >= MIN_EVIDENCE_CHARACTERS) {
        return {
          sourceType: 'web',
          sourceUrl: itemUrl,
          usedTranscript: false,
          usedComments: false,
          transcriptStatus: 'not_applicable',
          status: 'success',
          evidenceText: pageText,
          fallbackSnippet: pageText.slice(0, 280),
        };
      }
    } catch {
      // Fall back to direct fetch.
    }
  }

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
      usedComments: false,
      transcriptStatus: 'not_applicable',
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
      usedComments: false,
      transcriptStatus: 'not_applicable',
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Failed to fetch page content.',
    };
  }
}

async function fetchEvidenceForRequest(
  payload: SentimentEvaluationRequest,
  env: ServerEnv,
): Promise<SourceEvidence> {
  if (payload.opportunityType === 'YouTube') {
    return fetchYoutubeEvidence(payload.item, env);
  }

  if (payload.opportunityType === 'Reddit') {
    return fetchRedditEvidence(payload.item, env);
  }

  return fetchWebEvidence(payload.item, env);
}

function buildLlmPrompt(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
) {
  const extractedBrandShares = extractSovBrandShares(payload.extractedSov);
  const extractedBrandList = extractedBrandShares.map((share) => share.brand);

  const promptLines = [
    'You are a quality engineer and off-site SEO/GEO/AEO analyst auditing the backend\'s extracted sentiment and share-of-voice for a cited off-site source.',
    'Your job is to VERIFY the backend, not rubber-stamp it: count brand mentions yourself from the fetched evidence, judge sentiment directly from what you read, and flag cases where the backend\'s extracted values disagree with what the evidence actually shows.',
    'The target brand is the brand/company associated with the site URL.',
    '',
    `Site URL: ${payload.site}`,
    `Site ID: ${payload.siteId ?? 'Unknown'}`,
    `Opportunity Type: ${payload.opportunityType}`,
    `Opportunity ID: ${payload.opportunityId}`,
    `Item URL: ${payload.item}`,
  ];

  if (payload.title) {
    promptLines.push(`Item Title: ${payload.title}`);
  }

  if (typeof payload.timesCited === 'number') {
    promptLines.push(`Times Cited across LLM answers: ${payload.timesCited}`);
  }

  promptLines.push(
    `Extracted SOV (backend claim — audit this): ${payload.extractedSov || 'None'}`,
    `Extracted SOV brands: ${extractedBrandList.join(', ') || 'None'}`,
    `Extracted Sentiment (backend claim — audit this): ${payload.extractedSentiment || 'None'}`,
    '',
    'Process:',
    '  1. Use the Item Title as a fast topical signal before reading the body (e.g., "Manulife RRSP" signals a retirement-plan thread). Count any target-brand mentions that appear in the title.',
    '  2. Read the fetched evidence (post + comments for Reddit, video metadata / transcript for YouTube, page text for web) and count explicit mentions of EACH brand in "Extracted SOV brands", plus a separate targetBrandMentionCount for the target brand.',
    '  3. Judge the sentiment of the fetched content toward the target brand: "Favorable" | "Neutral" | "Unfavorable". Use "No brand mentions" if the target brand is never referenced, or "Needs Review" if the evidence is too sparse to support a confident judgment.',
    '  4. Return integer mention counts — do NOT compute percentages. The system derives SOV percentages from your counts and compares them against the backend\'s extracted values.',
    '',
    'Auditing rules (these override any instinct to agree with the backend):',
    '  - If the target brand is NOT mentioned in the evidence but Extracted SOV claims a non-zero share, that is a backend error: return targetBrandMentionCount = 0, evaluatedSentiment = "No brand mentions", confidence = "high". The system will correctly flag this as a large SOV disagreement.',
    '  - Do not inflate counts to match the backend. If you count 3 mentions and the backend claims 8, return 3.',
    '  - Adjacent sentiment labels (e.g., Favorable vs Neutral) are still a disagreement — only return the label you actually judged from the evidence.',
    '  - Title-only mentions count toward targetBrandMentionCount but the sentiment should be judged from the body/transcript when available, not from the title alone.',
    '  - If the target brand is already one of the extracted SOV brands, use the same count in both that brand\'s mentionCount and targetBrandMentionCount.',
    '  - If the evidence is too weak to support a confident judgment, set evidenceSufficient = false and evaluatedSentiment = "Needs Review".',
    '',
    'Evidence:',
    evidence.evidenceText,
  );

  return promptLines.join('\n');
}

function buildBedrockPrompt(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
) {
  return [
    buildLlmPrompt(payload, evidence),
    '',
    'Return ONLY a valid JSON object. Do not add markdown, code fences, or any explanatory text.',
    'Use this exact schema:',
    '{',
    '  "targetBrand": string,',
    '  "targetBrandMentionCount": number,',
    '  "evaluatedSentiment": "Favorable" | "Neutral" | "Unfavorable" | "No brand mentions" | "Needs Review",',
    '  "brandMentions": Array<{ "brand": string, "mentionCount": number }>,',
    '  "evidenceSufficient": boolean,',
    '  "confidence": "high" | "medium" | "low",',
    '  "rationale": string,',
    '  "evidenceSnippet": string',
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

function parseLlmEvaluationPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Failed to parse evaluator response.');
  }

  const candidate = value as Partial<LlmEvaluation>;

  if (
    typeof candidate.targetBrand !== 'string' ||
    typeof candidate.targetBrandMentionCount !== 'number' ||
    typeof candidate.evaluatedSentiment !== 'string' ||
    !Array.isArray(candidate.brandMentions) ||
    typeof candidate.evidenceSufficient !== 'boolean' ||
    typeof candidate.confidence !== 'string' ||
    typeof candidate.rationale !== 'string' ||
    typeof candidate.evidenceSnippet !== 'string'
  ) {
    throw new Error('Failed to parse evaluator response.');
  }

  if (
    candidate.brandMentions.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof (entry as { brand?: string }).brand !== 'string' ||
        typeof (entry as { mentionCount?: number }).mentionCount !== 'number',
    )
  ) {
    throw new Error('Failed to parse evaluator response.');
  }
  return candidate as LlmEvaluation;
}

async function fetchBedrockEvaluation(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
  env: ServerEnv,
): Promise<LlmEvaluationResponse> {
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
                content: [{ text: buildBedrockPrompt(payload, evidence) }],
              },
            ],
            inferenceConfig: {
              maxTokens: 700,
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
        evaluation: parseLlmEvaluationPayload(extractJsonObject(outputText)),
        provider: 'bedrock',
        model: modelId,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unexpected Bedrock error.';
    }
  }

  throw new Error(lastError || 'Bedrock request failed.');
}

async function fetchLlmEvaluation(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
  env: ServerEnv,
): Promise<LlmEvaluationResponse> {
  const bedrockApiKey = getBedrockBearerToken(env);
  const bedrockRegion = getBedrockRegion(env);

  if (bedrockApiKey && bedrockRegion) {
    try {
      return await fetchBedrockEvaluation(payload, evidence, env);
    } catch {
      // Fall through to Azure/OpenAI when the configured Bedrock model chain fails.
    }
  }

  const azureBaseUrl = normalizeAzureOpenAiBaseUrl(env.AZURE_OPENAI_ENDPOINT);
  const azureApiKey = env.AZURE_OPENAI_KEY?.trim();
  const useAzure = Boolean(azureBaseUrl && azureApiKey);
  const apiKey = useAzure ? azureApiKey : env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      useAzure
        ? 'AZURE_OPENAI_KEY is missing.'
        : 'OPENAI_API_KEY, AZURE_OPENAI_KEY, BEDROCK_BEARER_TOKEN, or AWS_BEARER_TOKEN_BEDROCK is missing.',
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
            targetBrandMentionCount: { type: 'number' },
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
            brandMentions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  brand: { type: 'string' },
                  mentionCount: { type: 'number' },
                },
                required: ['brand', 'mentionCount'],
              },
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
            'targetBrandMentionCount',
            'evaluatedSentiment',
            'brandMentions',
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

  return {
    evaluation: parseLlmEvaluationPayload(parsedOutput),
    provider: useAzure ? 'azure' : 'openai',
    model: modelName,
  };
}

export async function runOffsiteEvaluation(
  rawPayload: unknown,
  env: ServerEnv = {},
): Promise<SentimentEvaluationResult> {
  const payload = normalizeRequestPayload(rawPayload);

  if (!payload) {
    throw new Error('Invalid evaluator request payload.');
  }

  const evidence = await fetchEvidenceForRequest(payload, env);

  if (
    evidence.status === 'fetch_failed' ||
    evidence.status === 'insufficient_evidence'
  ) {
    const weakEvidenceScore =
      evidence.status === 'fetch_failed' ? 12 : 28;
    const blockedBySource =
      evidence.status === 'fetch_failed' &&
      /fetch failed with 403/i.test(evidence.fallbackSnippet);
    const blockedSourceLabel =
      evidence.sourceType === 'reddit'
        ? 'Reddit'
        : evidence.sourceType === 'youtube'
          ? 'YouTube'
          : 'The source';

    return {
      evaluatedSentiment: 'Needs Review',
      sentimentConfidence: weakEvidenceScore,
      evaluatedSov: 'Needs Review',
      sovConfidence: weakEvidenceScore,
      evaluatedTargetBrandSharePct: -1,
      rationale:
        blockedBySource
          ? `${blockedSourceLabel} blocked the server-side request, so the sentiment could not be independently checked from this deployment.`
          : evidence.status === 'fetch_failed'
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
        usedComments: evidence.usedComments,
        transcriptStatus: evidence.transcriptStatus,
        evidenceCharacters: evidence.evidenceText.length,
      },
      targetBrand: '',
    };
  }

  const llmResponse = await fetchLlmEvaluation(payload, evidence, env);
  const llmResult = llmResponse.evaluation;
  const extractedBrandShares = extractSovBrandShares(payload.extractedSov, llmResult.targetBrand);
  const evaluatedBrandShares = buildEvaluatedBrandShares({
    extractedBrandShares,
    llmResult,
  });
  const evaluatedSov = formatEvaluatedSov(evaluatedBrandShares);
  const evaluatedTargetBrandSharePct = getTargetBrandSharePct(
    evaluatedBrandShares,
    llmResult.targetBrand,
  );
  const sentimentConfidence = buildConfidenceScores({
    extractedSentiment: payload.extractedSentiment,
    llmResult,
    fetchStatus: evidence.status,
  });
  const sovConfidence = buildSovConfidenceScore({
    extractedBrandShares,
    evaluatedBrandShares,
    llmResult,
    fetchStatus: evidence.status,
  });

  return {
    evaluatedSentiment: llmResult.evaluatedSentiment,
    sentimentConfidence,
    evaluatedSov,
    sovConfidence,
    evaluatedTargetBrandSharePct,
    rationale: trimMultilineText(llmResult.rationale),
    evidenceSnippet:
      trimMultilineText(llmResult.evidenceSnippet) || evidence.fallbackSnippet,
    evaluatedAt: new Date().toISOString(),
    evaluatorVersion: SENTIMENT_EVALUATOR_VERSION,
    evaluatorProvider: llmResponse.provider,
    evaluatorModel: llmResponse.model,
    fetch: {
      status: evidence.status,
      sourceType: evidence.sourceType,
      sourceUrl: evidence.sourceUrl,
      usedTranscript: evidence.usedTranscript,
      usedComments: evidence.usedComments,
      transcriptStatus: evidence.transcriptStatus,
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
