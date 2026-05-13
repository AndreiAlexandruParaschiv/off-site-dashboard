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
  BRIGHTDATA_YOUTUBE_ASYNC_TIMEOUT_MS?: string;
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
  isBrandOwned?: boolean;
  /** Full transcript text (YouTube only). Preserved so the UI can offer a
   *  download for QA: when an evaluator verdict surprises a reviewer, they
   *  can audit the source without re-watching the video. */
  transcript?: string;
  /** Optional metadata to make the downloaded transcript file self-describing. */
  videoTitle?: string;
  videoChannel?: string;
  /** Full Reddit thread content (post body + comments, un-clamped). Used by the
   *  UI to offer a one-click download for QA — same purpose as `transcript` but
   *  for Reddit sources. */
  redditThread?: string;
  redditPostTitle?: string;
  redditCommunity?: string;
  /** Full scraped page content for Cited URLs / web sources (un-clamped). Same
   *  purpose as `transcript` / `redditThread` but for arbitrary web pages. */
  pageContent?: string;
  pageTitle?: string;
  /** 'markdown' when the page was scraped via BrightData's markdown formatter;
   *  'plain-text' when it came from the direct-HTML fallback path. */
  pageFormat?: 'markdown' | 'plain-text';
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
  /** Full rationale covering sentiment judgment AND SOV audit. */
  rationale: string;
  /**
   * Sentiment-only rationale — how the content portrays the target brand.
   * Must NOT mention SOV counts or percentage comparisons.
   */
  sentimentRationale: string;
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

function extractBrandKey(site: string): string {
  try {
    const trimmed = site.trim();
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./i, '').split('.')[0].toLowerCase();
  } catch {
    return '';
  }
}

function isBrandChannel(channelName: string, brandKey: string): boolean {
  if (!brandKey || !channelName) {
    return false;
  }
  const normalizedChannel = channelName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedBrand = brandKey.replace(/[^a-z0-9]/g, '');
  return normalizedChannel.includes(normalizedBrand);
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

function stripNavigationNoise(text: string): string {
  return trimMultilineText(
    text
      // Remove markdown skip-nav links: [Skip to X](#anchor)
      .replace(/\[skip to [^\]]+\]\([^)]*\)/gi, '')
      // Remove plain "Skip to X" text fragments
      .replace(/\bskip to \S+(?:\s+\S+){0,4}/gi, '')
      // Remove leading navigation bullet lists (* [Label](/path))
      .replace(/^(?:\*\s+\[[^\]]*\]\([^)]+\)\s*\n)+/m, '')
      // Collapse runs of whitespace/empty fragments left by removals
      .replace(/[ \t]{2,}/g, ' '),
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
  const competitors =
    Array.isArray(candidate.competitors) && candidate.competitors.length > 0
      ? (candidate.competitors as unknown[])
          .filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
          .map((c) => c.trim())
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
    ...(competitors ? { competitors } : {}),
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

function buildYoutubeEvidenceFromBrightDataEntry(
  itemUrl: string,
  firstResult: Record<string, unknown>,
  site?: string,
): SourceEvidence {
  const title = trimMultilineText(String(firstResult.title ?? ''));
  const description = trimMultilineText(String(firstResult.description ?? ''));
  // BrightData returns formatted_transcript as an array of {text, start_time, ...} segments.
  // Fall back to the plain-text transcript field, then give up gracefully.
  const rawFormatted = firstResult.formatted_transcript;
  const transcriptSource = Array.isArray(rawFormatted)
    ? (rawFormatted as Array<{ text?: unknown }>)
        .map((seg) => String(seg.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
    : String(rawFormatted ?? firstResult.transcript ?? '');
  const transcript = trimMultilineText(transcriptSource);
  const channelName = trimMultilineText(
    String(
      firstResult.youtuber ??
        firstResult.channel ??
        firstResult.channel_name ??
        firstResult.author ??
        firstResult.uploader ??
        '',
    ),
  );
  const channelUrl = trimMultilineText(String(firstResult.channel_url ?? ''));

  const brandKey = site ? extractBrandKey(site) : '';
  // Brand detection: channel name match OR title/description prominently features the brand
  // with no competing brand references (handles cases where channel name is missing).
  const brandOwnedByChannel = Boolean(brandKey && isBrandChannel(channelName, brandKey));
  const brandOwnedByContent = Boolean(
    brandKey &&
      !brandOwnedByChannel &&
      !channelName &&
      (isBrandChannel(title, brandKey) || isBrandChannel(description, brandKey)),
  );
  const brandOwned = brandOwnedByChannel || brandOwnedByContent;

  const evidenceText = clampEvidenceText(
    trimMultilineText(
      [
        title ? `Title: ${title}` : '',
        description ? `Description: ${description}` : '',
        channelName ? `Channel: ${channelName}${brandOwned ? ' (brand channel)' : ''}` : '',
        channelUrl ? `Channel URL: ${channelUrl}` : '',
        brandOwned
          ? "Note: This video is published on the brand's own YouTube channel. Brand-produced content is inherently favorable toward the brand."
          : '',
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
    transcript: transcript || undefined,
    videoTitle: title || undefined,
    videoChannel: channelName || undefined,
    fallbackSnippet:
      title ||
      description ||
      'Bright Data YouTube evidence could not be extracted.',
    isBrandOwned: brandOwned,
  };
}

/**
 * Polls a BrightData snapshot until it is ready and returns the first result record.
 * Used by both the /scrape and /trigger YouTube evidence paths.
 */
async function pollBrightDataSnapshot(
  snapshotId: string,
  apiKey: string,
  env: ServerEnv,
): Promise<Record<string, unknown>> {
  const parsedTimeout = Number.parseInt(
    env.BRIGHTDATA_YOUTUBE_ASYNC_TIMEOUT_MS?.trim() ?? '',
    10,
  );
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 90000;
  const pollIntervalMs = 4000;
  const deadlineMs = Date.now() + timeoutMs;

  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const progressResponse = await fetch(
      `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );

    if (!progressResponse.ok) {
      throw new Error(
        `Bright Data progress check failed with ${progressResponse.status}`,
      );
    }

    const progress = (await progressResponse.json()) as { status?: string };

    if (progress.status === 'ready') {
      const snapshotResponse = await fetch(
        `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );

      if (!snapshotResponse.ok) {
        throw new Error(
          `Bright Data snapshot download failed with ${snapshotResponse.status}`,
        );
      }

      const snapshot = (await snapshotResponse.json()) as unknown;
      const firstResult = Array.isArray(snapshot)
        ? (snapshot[0] as Record<string, unknown> | undefined)
        : (snapshot as Record<string, unknown> | undefined);

      if (!firstResult || typeof firstResult !== 'object') {
        throw new Error('Bright Data snapshot returned no results.');
      }

      return firstResult;
    }

    if (progress.status === 'failed') {
      throw new Error('Bright Data async crawl failed.');
    }
  }

  throw new Error('Bright Data async crawl timed out.');
}

async function fetchBrightDataYoutubeEvidence(
  itemUrl: string,
  env: ServerEnv,
  site?: string,
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
              env.BRIGHTDATA_YOUTUBE_TRANSCRIPTION_LANGUAGE?.trim() || '',
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Bright Data YouTube scrape failed with ${response.status}`);
  }

  const rawPayload = (await response.json()) as unknown;

  // BrightData's /scrape endpoint returns one of three shapes:
  //  1. [{...video...}]      – array with one entry (classic sync)
  //  2. {...video...}        – plain object, no snapshot_id (also sync, observed behaviour)
  //  3. {snapshot_id: "..."}  – async job kicked off; must poll until ready
  let firstResult: Record<string, unknown> | undefined;

  if (Array.isArray(rawPayload)) {
    firstResult = rawPayload[0] as Record<string, unknown> | undefined;
  } else if (rawPayload !== null && typeof rawPayload === 'object') {
    const obj = rawPayload as Record<string, unknown>;
    if (obj.snapshot_id) {
      const polled = await pollBrightDataSnapshot(String(obj.snapshot_id), apiKey, env);
      return buildYoutubeEvidenceFromBrightDataEntry(itemUrl, polled, site);
    }
    // Plain object with video data returned directly.
    firstResult = obj;
  }

  if (!firstResult || typeof firstResult !== 'object') {
    throw new Error('Bright Data YouTube scrape returned no results.');
  }

  return buildYoutubeEvidenceFromBrightDataEntry(itemUrl, firstResult, site);
}

async function fetchBrightDataYoutubeEvidenceAsync(
  itemUrl: string,
  env: ServerEnv,
  site?: string,
): Promise<SourceEvidence> {
  const apiKey = getBrightDataApiKey(env);

  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is missing.');
  }

  const datasetId = getBrightDataYoutubeVideoDatasetId(env);
  const triggerResponse = await fetch(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${encodeURIComponent(
      datasetId,
    )}&include_errors=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        {
          url: itemUrl,
          country: '',
          transcription_language:
            env.BRIGHTDATA_YOUTUBE_TRANSCRIPTION_LANGUAGE?.trim() || '',
        },
      ]),
    },
  );

  if (!triggerResponse.ok) {
    const errorText = await triggerResponse.text();
    throw new Error(
      errorText || `Bright Data YouTube async trigger failed with ${triggerResponse.status}`,
    );
  }

  const triggerPayload = (await triggerResponse.json()) as { snapshot_id?: string };
  const snapshotId = triggerPayload.snapshot_id;

  if (!snapshotId) {
    throw new Error('Bright Data YouTube async trigger returned no snapshot_id.');
  }

  const firstResult = await pollBrightDataSnapshot(snapshotId, apiKey, env);
  return buildYoutubeEvidenceFromBrightDataEntry(itemUrl, firstResult, site);
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

function collectBrightDataRedditComments(entries: unknown, limit = 80) {
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

  // Build the LLM evidence text (clamped to MAX_EVIDENCE_CHARACTERS).
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

  // Build a separate, UN-clamped thread snapshot for QA download. The LLM only
  // sees the clamped evidenceText, but the reviewer needs the full thread to
  // audit verdicts that disagree with their expectations.
  const redditThread =
    trimMultilineText(
      [
        title ? `Post title: ${title}` : '',
        description ? `Post body:\n${description}` : '',
        community ? `Community: ${community}` : '',
        communityDescription
          ? `Community description:\n${communityDescription}`
          : '',
        comments.length > 0
          ? `Comments (${comments.length}):\n\n${comments
              .map((comment, index) => `[${index + 1}] ${comment}`)
              .join('\n\n')}`
          : '',
      ].join('\n\n'),
    ) || undefined;

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
    redditThread,
    redditPostTitle: title || undefined,
    redditCommunity: community || undefined,
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

/**
 * Apply variant-stripping to a brand name BEFORE computing its comparison
 * key, so different spellings of the same brand collapse to a single entry:
 *
 *   "WK Kellogg Canada"  →  "WK Kellogg"   (regional suffix)
 *   "Kellogg's"          →  "Kellogg"      (possessive)
 *   "Kellogg's Canada"   →  "Kellogg"      (both)
 *   "Sun-Life"           →  "Sun-Life"     (untouched — punctuation handled later)
 *
 * Keep this conservative: only strip well-known regional tokens (see
 * REGIONAL_BRAND_SUFFIX_PATTERN) and the trailing possessive marker, so we
 * never accidentally fold genuinely distinct brands together.
 */
function canonicalizeBrandForKey(value: string): string {
  let result = stripRegionalBrandSuffix(value);
  // Strip trailing possessive 's / s' so "Kellogg's" and "Kellogg" merge.
  // The Unicode curly apostrophe is normalized to the straight one by the
  // non-alphanumeric strip below, but doing it here keeps the canonical
  // form readable for any caller that uses the pre-key string.
  result = result.replace(/[’']\s*s\b/gi, '').replace(/s[’']\s*$/i, 's');
  return result.trim();
}

function normalizeBrandKey(value: string) {
  // Strip ALL non-alphanumeric characters (not just collapsing them to spaces
  // like normalizeComparableText does). This makes "WK Kellogg", "Wkkellogg",
  // "WK-Kellogg", and "WK_Kellogg" all map to the same key "wkkellogg" so
  // brand variants merge correctly in the SOV calculation. Mirrors the
  // frontend's normalizeBrandKey in src/features/off-site-dashboard/evaluation.ts.
  //
  // Also applies canonicalizeBrandForKey first to collapse regional
  // suffixes ("WK Kellogg Canada" → "WK Kellogg") and possessives
  // ("Kellogg's" → "Kellogg") into a single key — without this, the LLM's
  // variant spellings end up as separate SOV entries.
  return canonicalizeBrandForKey(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Regional/country qualifiers we strip from the LLM-returned targetBrand.
 *
 * Background: for sites like ricekrispies.ca or ricekrispies.com, the brand
 * profile LLM tends to return "Rice Krispies Canada" or "Rice Krispies US"
 * as targetBrand. But "Rice Krispies" is the actual brand — the country is
 * just the storefront. If targetBrand carries the country suffix, the SOV
 * denominator won't match plain "Rice Krispies" mentions and SOV breaks.
 *
 * Pattern matches a trailing region token preceded by space, dash, slash,
 * or an opening paren (so "Rice Krispies (Canada)" works too). Kept
 * conservative — only the most common country/region words, so we don't
 * accidentally strip legitimate name parts like "Bank of America".
 */
const REGIONAL_BRAND_SUFFIX_PATTERN =
  /[\s\-/]+\(?\s*(?:us|usa|u\.s\.|u\.s\.a\.|canada|uk|u\.k\.|gb|eu|emea|apac|latam|mena|global|international|worldwide|mexico|brazil|australia|aus|new\s*zealand|nz|germany|france|spain|italy|japan|china|india|north\s*america|south\s*america)\s*\)?$/i;

function stripRegionalBrandSuffix(value: string): string {
  let result = value.trim();
  // Strip up to two trailing region tokens in case of nested qualifiers like
  // "Rice Krispies (North America) US".
  for (let i = 0; i < 2; i += 1) {
    const next = result.replace(REGIONAL_BRAND_SUFFIX_PATTERN, '').trim();
    if (next === result || !next) break;
    result = next;
  }
  return result;
}

/**
 * Pattern that matches placeholder brand names injected by the SpaceCat backend,
 * e.g. "ProductA", "ProductB", "CompetitorX", "CompetitorY", "BrandA".
 * These are generic template tokens, not real competitor brands, and must be
 * excluded from both the LLM prompt ("Known competitor brands") and the SOV
 * calculation denominator.
 */
const PLACEHOLDER_BRAND_PATTERN = /^(product|competitor|brand)[a-z0-9]{0,3}$/i;

function isIgnorableSovBrand(value: string) {
  const normalizedValue = normalizeBrandKey(value);

  return (
    !normalizedValue ||
    normalizedValue === 'market' ||
    normalizedValue === 'others' ||
    normalizedValue.startsWith('others ') ||
    normalizedValue === 'other' ||
    normalizedValue.startsWith('other ') ||
    // Generic placeholder names from the SpaceCat API (ProductA, CompetitorY, etc.)
    PLACEHOLDER_BRAND_PATTERN.test(value.trim())
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
    sharePct < 0
  ) {
    return;
  }

  // If the same canonical brand was already added under a different spelling
  // ("SunLife" vs "Sun Life" vs "Sun-Life" all normalize to "sunlife"), fold
  // this entry's share into the existing one rather than dropping it. The
  // backend sometimes emits variant casings/spacings on separate lines that
  // should be summed, not deduped-and-discarded.
  if (seenBrands.has(normalizedBrand)) {
    const existing = nextShares.find(
      (share) => normalizeBrandKey(share.brand) === normalizedBrand,
    );
    if (existing) {
      existing.sharePct += sharePct;
    }
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
  brandProfile?: BrandProfile;
}) {
  const targetBrand = trimMultilineText(input.llmResult.targetBrand);
  const targetBrandKey = normalizeBrandKey(targetBrand);

  // Build the set of normalized keys that should fold into the target brand
  // (the canonical target plus any owned products / sub-brands from the
  // brand profile, e.g., Frosted Mini-Wheats / Special K / Raisin Bran for
  // a WK Kellogg site).
  const targetEquivalentKeys = new Set<string>();
  if (targetBrandKey) targetEquivalentKeys.add(targetBrandKey);
  if (input.brandProfile?.ownedProducts) {
    for (const product of input.brandProfile.ownedProducts) {
      const productKey = normalizeBrandKey(product);
      if (productKey) targetEquivalentKeys.add(productKey);
    }
  }
  // Aliases (e.g., "KFC" for Kentucky Fried Chicken, "GE" for General
  // Electric) fold into the target via the same machinery as ownedProducts.
  // If the LLM emits an alias as a separate brandMentions entry despite the
  // prompt rule, this server-side fold catches it deterministically.
  if (input.brandProfile?.targetBrandAliases) {
    for (const alias of input.brandProfile.targetBrandAliases) {
      const aliasKey = normalizeBrandKey(alias);
      if (aliasKey) targetEquivalentKeys.add(aliasKey);
    }
  }

  const mentionCounts = new Map<string, { brand: string; mentionCount: number }>();
  const llmTargetCount = Math.max(0, Math.round(input.llmResult.targetBrandMentionCount));
  let foldedSubBrandCount = 0;
  let llmAlsoListedTarget = false;

  for (const brandMention of input.llmResult.brandMentions) {
    const cleanedBrand = trimMultilineText(brandMention.brand);
    const normalizedBrand = normalizeBrandKey(cleanedBrand);
    if (!normalizedBrand || isIgnorableSovBrand(cleanedBrand)) continue;

    const count = Math.max(0, Math.round(brandMention.mentionCount));

    if (normalizedBrand === targetBrandKey) {
      // The LLM listed the target brand explicitly in brandMentions. The
      // prompt instructs it to put the same count in both fields, so this is
      // typically redundant with targetBrandMentionCount.
      llmAlsoListedTarget = true;
    } else if (targetEquivalentKeys.has(normalizedBrand)) {
      // The LLM listed an owned sub-brand (e.g., Frosted Mini-Wheats) as a
      // separate brandMentions entry. Track its count for the fold rule below.
      foldedSubBrandCount += count;
    } else {
      // Genuine non-target brand — keep as a separate denominator entry.
      // If the LLM emitted multiple spelling variants of the same brand
      // ("SunLife" + "Sun Life" + "Sun-Life" all → "sunlife"), sum the
      // counts so we don't silently drop mentions by overwriting the entry.
      const existing = mentionCounts.get(normalizedBrand);
      if (existing) {
        existing.mentionCount += count;
      } else {
        mentionCounts.set(normalizedBrand, {
          brand: cleanedBrand,
          mentionCount: count,
        });
      }
    }
  }

  // Final target mention count after combining the LLM's targetBrandMentionCount
  // with any owned-sub-brand mentions the LLM listed separately.
  const targetCount = combineTargetAndSubBrandCounts({
    llmTargetCount,
    llmAlsoListedTarget,
    foldedSubBrandCount,
  });

  const orderedBrands = input.extractedBrandShares
    .map((share) => share.brand)
    // Drop any extracted-share entries that fold into the target (they're
    // accounted for by targetCount; including them as separate rows would
    // double-count and produce duplicate-looking SOV entries like
    // "WK Kellogg: 34.5%, Wkkellogg: 34.5%").
    .filter((brand) => !targetEquivalentKeys.has(normalizeBrandKey(brand)));

  if (targetBrandKey) {
    orderedBrands.unshift(targetBrand);
  }

  for (const [normalizedBrand, { brand }] of mentionCounts) {
    if (!orderedBrands.some((b) => normalizeBrandKey(b) === normalizedBrand)) {
      orderedBrands.push(brand);
    }
  }

  const evaluatedBrands = orderedBrands.map((brand) => {
    const normalizedBrand = normalizeBrandKey(brand);
    const mentionCount =
      normalizedBrand === targetBrandKey
        ? targetCount
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

/**
 * Decide the final target-brand mention count given:
 * - `llmTargetCount`: what the LLM put in `targetBrandMentionCount`.
 * - `llmAlsoListedTarget`: whether the LLM ALSO listed the target brand as
 *   a separate `brandMentions` entry (its count is NOT included in
 *   `foldedSubBrandCount` — only owned sub-brand mentions are).
 * - `foldedSubBrandCount`: the SUM of `brandMentions` entries whose keys
 *   matched owned products / sub-brands from the brand profile (e.g.,
 *   Frosted Mini-Wheats for a Kellogg site), excluding any mention of the
 *   target brand itself.
 *
 * Rule: simple addition. The LLM is instructed to fold owned-product
 * mentions into `targetBrandMentionCount`, but in practice it sometimes
 * splits them out as separate `brandMentions` entries. Adding the two
 * together captures both scenarios — if the LLM folded correctly,
 * `foldedSubBrandCount` is 0 and the sum equals `llmTargetCount`; if it
 * split sub-brands out, the sum recovers the true total. Because we
 * exclude the target brand itself from `foldedSubBrandCount` (tracked
 * separately via `llmAlsoListedTarget`), there is no double-count risk
 * from the redundant-target-listing case.
 */
function combineTargetAndSubBrandCounts(input: {
  llmTargetCount: number;
  llmAlsoListedTarget: boolean;
  foldedSubBrandCount: number;
}): number {
  return input.llmTargetCount + input.foldedSubBrandCount;
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

async function buildYoutubeEvidenceFromHtml(
  itemUrl: string,
  html: string,
  transcriptFetcher?: (url: string) => Promise<string>,
  site?: string,
): Promise<SourceEvidence> {
  const title =
    extractMetaTagValue(html, /<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
    extractMetaTagValue(html, /<title>([^<]+)<\/title>/i);
  const description =
    extractMetaTagValue(html, /"shortDescription":"([^"]+)"/i) ||
    extractMetaTagValue(html, /<meta\s+name="description"\s+content="([^"]+)"/i);

  const playerResponseJson =
    extractBalancedObjectLiteral(html, 'ytInitialPlayerResponse =') ??
    extractBalancedObjectLiteral(html, 'var ytInitialPlayerResponse =');
  let transcript = '';
  let transcriptStatus: SourceEvidence['transcriptStatus'] = 'unknown';
  let htmlChannelName = '';

  if (playerResponseJson) {
    try {
      const playerResponse = JSON.parse(playerResponseJson) as {
        videoDetails?: { author?: string; channelId?: string };
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
      htmlChannelName = trimMultilineText(String(playerResponse.videoDetails?.author ?? ''));
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
        const transcriptPayload = await (transcriptFetcher ?? fetchText)(transcriptTrack.baseUrl);
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

  const brandKey = site ? extractBrandKey(site) : '';
  const brandOwnedByChannel = Boolean(brandKey && isBrandChannel(htmlChannelName, brandKey));
  const brandOwnedByContent = Boolean(
    brandKey &&
      !brandOwnedByChannel &&
      !htmlChannelName &&
      (isBrandChannel(title, brandKey) || isBrandChannel(description, brandKey)),
  );
  // Only set isBrandOwned when we have enough context to determine it (site provided).
  const isBrandOwned: boolean | undefined = site
    ? brandOwnedByChannel || brandOwnedByContent
    : undefined;

  const evidenceText = clampEvidenceText(
    trimMultilineText(
      [
        title ? `Title: ${title}` : '',
        description ? `Description: ${description}` : '',
        htmlChannelName ? `Channel: ${htmlChannelName}${isBrandOwned ? ' (brand channel)' : ''}` : '',
        isBrandOwned
          ? "Note: This video is published on the brand's own YouTube channel. Brand-produced content is inherently favorable toward the brand."
          : '',
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
    transcript: transcript || undefined,
    videoTitle: title || undefined,
    videoChannel: htmlChannelName || undefined,
    fallbackSnippet:
      [htmlChannelName, title, description].filter(Boolean).join(' | ') ||
      'YouTube evidence could not be extracted.',
    isBrandOwned,
  };
}

async function fetchYoutubeEvidence(
  itemUrl: string,
  env: ServerEnv,
  site?: string,
): Promise<SourceEvidence> {
  // Ensure BrightData always receives a well-formed https:// URL.
  // SpaceCat may return http:// or even protocol-less YouTube URLs.
  itemUrl = normalizeAbsoluteUrl(itemUrl);
  // BrightData's YouTube dataset is indexed by watch URLs, not Shorts URLs.
  // Convert /shorts/VIDEO_ID → /watch?v=VIDEO_ID so evidence lookups succeed.
  itemUrl = normalizeShortsUrl(itemUrl);
  let videoEvidence: SourceEvidence | null = null;

  if (getBrightDataApiKey(env)) {
    try {
      const datasetEvidence = await fetchBrightDataYoutubeEvidence(itemUrl, env, site);

      if (datasetEvidence.isBrandOwned) {
        // Brand channel: no transcript scraping needed — sentiment is inherently favorable.
        // Only fetch viewer comments as context.
        videoEvidence = datasetEvidence;
      } else if (
        datasetEvidence.transcriptStatus === 'available_and_used' ||
        datasetEvidence.transcriptStatus === 'available_but_not_used'
      ) {
        // Sync scrape returned a transcript — fast path, no async needed.
        videoEvidence = datasetEvidence;
      } else {
        // Sync returned metadata only — try async scrape for a fresh transcript.
        try {
          const asyncEvidence = await fetchBrightDataYoutubeEvidenceAsync(itemUrl, env, site);
          videoEvidence =
            asyncEvidence.transcriptStatus === 'available_and_used' ||
            asyncEvidence.evidenceText.length > datasetEvidence.evidenceText.length
              ? asyncEvidence
              : datasetEvidence;
        } catch {
          // Async failed — fall back to the sync result.
          videoEvidence = datasetEvidence;
        }
      }
    } catch {
      // Dataset paths failed — try Web Unlocker for metadata.
      try {
        const unlockerHtml = await fetchBrightDataUnlockerBody(itemUrl, env, 'raw');
        videoEvidence = await buildYoutubeEvidenceFromHtml(
          itemUrl,
          unlockerHtml,
          (url) => fetchBrightDataUnlockerBody(url, env, 'raw'),
          site,
        );
      } catch {
        // Fall through to direct fetch.
      }
    }

    if (videoEvidence && !videoEvidence.usedTranscript) {
      // No transcript — fetch comments as supplementary evidence.
      try {
        const commentTexts = await fetchBrightDataYoutubeCommentTexts(itemUrl, env);

        if (commentTexts.length > 0) {
          const commentsSection = `Viewer comments:\n${commentTexts.join('\n')}`;
          const combinedEvidence = clampEvidenceText(
            trimMultilineText(
              [videoEvidence.evidenceText, commentsSection].filter(Boolean).join('\n\n'),
            ),
          );

          videoEvidence = {
            ...videoEvidence,
            usedComments: true,
            evidenceText: combinedEvidence,
            status:
              combinedEvidence.length < MIN_EVIDENCE_CHARACTERS
                ? 'insufficient_evidence'
                : 'partial',
          };
        }
      } catch {
        // Comments are supplementary; don't fail if they can't be fetched.
      }
    }


    if (videoEvidence) {
      return videoEvidence;
    }
  }

  try {
    const html = await fetchText(itemUrl);
    const directEvidence = await buildYoutubeEvidenceFromHtml(itemUrl, html, undefined, site);
    return directEvidence;
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

/**
 * Converts a YouTube Shorts URL to its canonical watch URL so BrightData dataset
 * APIs (indexed by watch URL) can resolve it correctly.
 *   https://www.youtube.com/shorts/VIDEO_ID  →  https://www.youtube.com/watch?v=VIDEO_ID
 * Non-Shorts URLs are returned unchanged.
 */
function normalizeShortsUrl(url: string): string {
  const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/i);
  if (shortsMatch) {
    return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
  }
  return url;
}

function normalizeAbsoluteUrl(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return '';
  }

  // Upgrade http:// → https:// and add protocol if missing entirely.
  if (/^http:\/\//i.test(trimmedValue)) {
    return trimmedValue.replace(/^http:\/\//i, 'https://');
  }

  if (/^https:\/\//i.test(trimmedValue)) {
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
        ? `${baseUrl}?raw_json=1&limit=80`
        : `${baseUrl}.json?raw_json=1&limit=80`;
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
        .slice(0, 80);
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
  site?: string,
): Promise<SourceEvidence> {
  const brandKey = site ? extractBrandKey(site) : '';
  const urlBrandKey = extractBrandKey(itemUrl);
  const isBrandOwned = Boolean(brandKey && urlBrandKey && brandKey === urlBrandKey) || undefined;

  if (getBrightDataApiKey(env)) {
    try {
      const brightDataBody = await fetchBrightDataUnlockerBody(itemUrl, env, 'markdown');
      // Keep an un-clamped, navigation-noise-stripped copy for QA download.
      // The LLM only sees the clamped `pageText`, but a reviewer may need
      // the full markdown to verify a verdict.
      const fullPageContent = trimMultilineText(stripNavigationNoise(brightDataBody));
      const pageText = clampEvidenceText(fullPageContent);

      if (pageText.length >= MIN_EVIDENCE_CHARACTERS) {
        return {
          sourceType: 'web',
          sourceUrl: itemUrl,
          usedTranscript: false,
          usedComments: false,
          transcriptStatus: 'not_applicable',
          status: 'success',
          evidenceText: pageText,
          pageContent: fullPageContent || undefined,
          pageFormat: 'markdown',
          fallbackSnippet: pageText.slice(0, 280),
          isBrandOwned,
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
    // Build the un-clamped QA snapshot in the same shape as evidenceText so
    // the downloaded file mirrors what the LLM saw, just without truncation.
    const fullPageContent =
      trimMultilineText(
        [
          title ? `Title: ${title}` : '',
          description ? `Description: ${description}` : '',
          pageText ? `Page content:\n${pageText}` : '',
        ].join('\n\n'),
      ) || undefined;

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
      pageContent: fullPageContent,
      pageTitle: title || undefined,
      pageFormat: 'plain-text',
      fallbackSnippet: title || description || 'Page evidence could not be extracted.',
      isBrandOwned,
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
      isBrandOwned,
    };
  }
}

async function fetchEvidenceForRequest(
  payload: SentimentEvaluationRequest,
  env: ServerEnv,
): Promise<SourceEvidence> {
  if (payload.opportunityType === 'YouTube') {
    return fetchYoutubeEvidence(payload.item, env, payload.site);
  }

  if (payload.opportunityType === 'Reddit') {
    return fetchRedditEvidence(payload.item, env);
  }

  return fetchWebEvidence(payload.item, env, payload.site);
}

/**
 * Per-site authoritative brand profile used to anchor the evaluator's brand
 * recognition. The profile lists products/sub-brands actually OWNED by the
 * target brand alongside common competitor brands in the same category, so
 * the LLM can avoid "category bleed" mistakes (e.g., counting Cheerios as a
 * Kellogg product because both are cereals).
 *
 * Profiles are generated once per site via a small LLM call and cached in
 * memory. If profile generation fails for any reason (no API key, network
 * error, malformed response), evaluation proceeds without it — the prompt's
 * existing brand-mention rules remain in force.
 */
interface BrandProfile {
  site: string;
  targetBrand: string;
  /**
   * The brand's primary industry / category — used by the verdict LLM to
   * filter out unrelated brand mentions from the SOV denominator. E.g., for
   * a Sun Life Financial site (industry: "Life Insurance & Financial
   * Services"), mentions of Tesla, Nike, or Adobe must not be counted as
   * competitors even if they appear in the evidence. The string should be
   * specific enough to draw a tight boundary (prefer "Life Insurance &
   * Wealth Management" over the looser "Finance").
   */
  primaryIndustry?: string;
  /**
   * Whether the brand is itself a retailer, marketplace, or distribution
   * channel (Amazon, Walmart, Target, Costco, Best Buy, Shopify storefront,
   * app store, etc.). When false (the common case — most brands sell
   * THROUGH retailers), retailer mentions in the evidence are NOT competing
   * SOV brands and must be excluded from the denominator. When true, other
   * retailers ARE legitimate competitors and get counted normally.
   */
  isSalesChannel?: boolean;
  /**
   * Alternate official names, common acronyms, and well-known nicknames for
   * the target brand — e.g. for Kentucky Fried Chicken: ["KFC"]; for
   * General Electric: ["GE"]; for Hewlett-Packard: ["HP", "Hewlett Packard"].
   *
   * Used by the SOV evaluator to:
   *   1. Count alias mentions in evidence toward targetBrandMentionCount.
   *   2. Fold any "alias" entries the LLM emits as separate brandMentions
   *      into the target via targetEquivalentKeys (the same merge path used
   *      for ownedProducts).
   *
   * Only well-known, widely-recognized aliases — not spelling variants
   * (handled separately by normalizeBrandKey) and not parent-organization
   * names (handled via parentOrganization).
   */
  targetBrandAliases?: string[];
  ownedProducts: string[];
  parentOrganization?: string;
  knownCompetitors: string[];
  generatedAt: string;
}

const BRAND_PROFILE_CACHE = new Map<string, BrandProfile>();

/**
 * Per-site brand-profile overrides. The LLM generates the bulk of each
 * profile (correctly attributing products, picking competitors, etc.) but
 * sometimes the right answer for our reporting purposes diverges from
 * strict corporate ownership.
 *
 * Example: post-2023 Kellogg Company split, the Kashi brand sits with
 * Kellanova rather than WK Kellogg Co. For SOV reporting on wkkellogg.com,
 * we want Kashi counted as part of the Kellogg family rather than as a
 * competitor — the brand lineage matters more than the corporate
 * partition.
 *
 * Keys are matched against the brand-key form of the site URL (the part
 * before the first dot of the hostname, lowercased — see extractBrandKey).
 * That makes the override apply to wkkellogg.com, www.wkkellogg.com, and
 * any path under those hosts.
 *
 * Each entry is *additive* — listed products/competitors are merged with
 * (not replaced by) the LLM's output, with deduping by normalized brand
 * key. The `removeFromCompetitors` field re-classifies an LLM-detected
 * competitor as one of our own when needed (so e.g. Kashi doesn't end up
 * in BOTH ownedProducts and knownCompetitors).
 */
type BrandProfileOverride = {
  ownedProducts?: string[];
  knownCompetitors?: string[];
  removeFromCompetitors?: string[];
};

const BRAND_PROFILE_OVERRIDES: Record<string, BrandProfileOverride> = {
  wkkellogg: {
    ownedProducts: ['Kashi'],
    removeFromCompetitors: ['Kashi'],
  },
};

function applyBrandProfileOverrides(
  profile: BrandProfile,
  site: string,
): BrandProfile {
  const brandKey = extractBrandKey(site);
  const override = brandKey ? BRAND_PROFILE_OVERRIDES[brandKey] : undefined;
  if (!override) {
    return profile;
  }

  const dedupeByKey = (entries: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of entries) {
      const trimmed = entry.trim();
      const key = normalizeBrandKey(trimmed);
      if (!trimmed || !key || seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
    return result;
  };

  const removalKeys = new Set(
    (override.removeFromCompetitors ?? []).map((entry) => normalizeBrandKey(entry)),
  );

  return {
    ...profile,
    ownedProducts: dedupeByKey([
      ...profile.ownedProducts,
      ...(override.ownedProducts ?? []),
    ]),
    knownCompetitors: dedupeByKey(
      [
        ...profile.knownCompetitors.filter(
          (competitor) => !removalKeys.has(normalizeBrandKey(competitor)),
        ),
        ...(override.knownCompetitors ?? []),
      ],
    ),
  };
}

function brandProfileCacheKey(site: string): string {
  return site.trim().toLowerCase();
}

async function getBrandProfile(
  site: string,
  env: ServerEnv,
): Promise<BrandProfile | undefined> {
  const key = brandProfileCacheKey(site);
  if (!key) {
    return undefined;
  }

  const cached = BRAND_PROFILE_CACHE.get(key);
  if (cached) {
    return cached;
  }

  try {
    const baseProfile = await fetchBrandProfileFromLlm(site, env);
    if (!baseProfile || !baseProfile.targetBrand) {
      return baseProfile;
    }
    // Merge any per-site overrides (e.g., Kashi → Kellogg family) before
    // caching so every consumer sees the same augmented profile.
    const profile = applyBrandProfileOverrides(baseProfile, site);
    BRAND_PROFILE_CACHE.set(key, profile);
    return profile;
  } catch {
    return undefined;
  }
}

async function fetchBrandProfileFromLlm(
  site: string,
  env: ServerEnv,
): Promise<BrandProfile | undefined> {
  // Profile generation uses the OpenAI/Azure path. Bedrock-only setups skip
  // profile generation gracefully — the evaluator falls back to its prior
  // brand-mention heuristics.
  const azureBaseUrl = normalizeAzureOpenAiBaseUrl(env.AZURE_OPENAI_ENDPOINT);
  const azureApiKey = env.AZURE_OPENAI_KEY?.trim();
  const useAzure = Boolean(azureBaseUrl && azureApiKey);
  const apiKey = useAzure ? azureApiKey : env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const modelName =
    (useAzure
      ? env.AZURE_OPENAI_DEPLOYMENT?.trim()
      : env.OPENAI_EVALUATOR_MODEL?.trim()) ||
    env.OPENAI_EVALUATOR_MODEL?.trim() ||
    DEFAULT_OPENAI_MODEL;

  const prompt = [
    `Identify the brand or company associated with this URL: ${site}`,
    '',
    'Return a JSON object with these fields:',
    '- targetBrand: the canonical brand or company name WITHOUT any regional or country qualifier (e.g., return "Rice Krispies", not "Rice Krispies Canada" or "Rice Krispies US" — regional sites still represent the same brand for SOV purposes)',
    '- primaryIndustry: the specific industry/category this brand operates in. Use a concrete, narrow phrase that draws a tight competitive boundary — prefer "Life Insurance & Wealth Management" over "Finance"; "Ready-to-Eat Breakfast Cereal" over "Food"; "Luxury Electric Vehicles" over "Automotive". This is used to filter out unrelated brand mentions from the SOV denominator, so it must be precise enough to exclude brands that share a vague sector but do not actually compete.',
    '- isSalesChannel: boolean — true ONLY if this brand is itself a retailer, marketplace, distribution channel, or storefront whose primary business is RESELLING products from other brands (e.g., Amazon, Walmart, Target, Costco, Best Buy, eBay, Etsy, an app store). For brands that PRODUCE goods or services and sell through retailers (e.g., Rice Krispies, Sun Life, Toyota, Nike), set this to false. This flag controls whether retailer mentions in evidence count as competing SOV brands.',
    '- targetBrandAliases: array of well-known alternate names, common acronyms, and widely-recognized nicknames for the target brand. Examples: for "Kentucky Fried Chicken" → ["KFC"]; for "General Electric" → ["GE"]; for "Hewlett-Packard" → ["HP", "Hewlett Packard"]; for "International Business Machines" → ["IBM", "Big Blue"]; for "JPMorgan Chase" → ["JPMC", "Chase"]. Only include aliases that are widely used in real-world content — do NOT invent or speculate. Return an empty array if no widely-used aliases exist. Do NOT list mere spelling variants (case/spacing/punctuation/possessive — those are handled separately) or the parent organization.',
    '- ownedProducts: array of well-known products, models, and sub-brands OWNED by this brand',
    '- parentOrganization: parent company name if applicable, otherwise empty string',
    '- knownCompetitors: array of major competing brand names that are NOT owned by the target brand. ALL competitors must operate in the same primaryIndustry as the target brand. Do NOT list retailers, marketplaces, or sales channels as competitors UNLESS isSalesChannel is true for the target brand.',
    '',
    'Use only well-known, widely-recognized facts. Be concise — limit each list to ~10-15 entries.',
    'Do not include speculative entries. Do not include the target brand itself in knownCompetitors.',
    'For competitors, prefer specific product brands over umbrella corporations when both exist (e.g., for a Kellogg cereal site, list "Cheerios" rather than just "General Mills").',
  ].join('\n');

  const requestBody = {
    model: modelName,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'brand_profile',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetBrand: { type: 'string' },
            primaryIndustry: { type: 'string' },
            isSalesChannel: { type: 'boolean' },
            targetBrandAliases: { type: 'array', items: { type: 'string' } },
            ownedProducts: { type: 'array', items: { type: 'string' } },
            parentOrganization: { type: 'string' },
            knownCompetitors: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'targetBrand',
            'primaryIndustry',
            'isSalesChannel',
            'targetBrandAliases',
            'ownedProducts',
            'parentOrganization',
            'knownCompetitors',
          ],
        },
      },
    },
    max_output_tokens: 500,
  };

  const response = await fetch(
    useAzure ? `${azureBaseUrl}responses` : OPENAI_API_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(useAzure
          ? { 'api-key': apiKey }
          : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as {
    output?: Array<{
      content?: Array<{ parsed?: unknown; text?: string }>;
    }>;
    output_parsed?: unknown;
    output_text?: string;
  };

  const parsedStructured = Array.isArray(data.output)
    ? data.output
        .flatMap((entry) => entry.content ?? [])
        .find((content) => Boolean(content.parsed))?.parsed
    : null;
  const outputTextFromContent = Array.isArray(data.output)
    ? data.output
        .flatMap((entry) => entry.content ?? [])
        .map((content) => content.text)
        .find((text): text is string => typeof text === 'string' && Boolean(text.trim()))
    : null;
  const parsed =
    data.output_parsed ??
    parsedStructured ??
    (() => {
      const text =
        typeof data.output_text === 'string' ? data.output_text : outputTextFromContent;
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const candidate = parsed as {
    targetBrand?: unknown;
    primaryIndustry?: unknown;
    isSalesChannel?: unknown;
    targetBrandAliases?: unknown;
    ownedProducts?: unknown;
    parentOrganization?: unknown;
    knownCompetitors?: unknown;
  };

  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

  // Strip regional/country suffixes ("Rice Krispies Canada" → "Rice Krispies")
  // so the same brand on different regional storefronts uses one canonical key.
  // See stripRegionalBrandSuffix and REGIONAL_BRAND_SUFFIX_PATTERN above.
  const rawTargetBrand =
    typeof candidate.targetBrand === 'string' ? candidate.targetBrand.trim() : '';
  const targetBrand = stripRegionalBrandSuffix(rawTargetBrand);
  if (!targetBrand) {
    return undefined;
  }

  const parent =
    typeof candidate.parentOrganization === 'string'
      ? candidate.parentOrganization.trim()
      : '';

  const primaryIndustry =
    typeof candidate.primaryIndustry === 'string'
      ? candidate.primaryIndustry.trim()
      : '';

  // Default to false (the much more common case — most analyzed brands are
  // not themselves retailers) so a missing/malformed flag from the LLM never
  // accidentally enables retailer-as-competitor counting.
  const isSalesChannel =
    typeof candidate.isSalesChannel === 'boolean'
      ? candidate.isSalesChannel
      : false;

  const aliases = stringList(candidate.targetBrandAliases);

  return {
    site,
    targetBrand,
    primaryIndustry: primaryIndustry || undefined,
    isSalesChannel,
    targetBrandAliases: aliases.length > 0 ? aliases : undefined,
    ownedProducts: stringList(candidate.ownedProducts),
    parentOrganization: parent ? parent : undefined,
    knownCompetitors: stringList(candidate.knownCompetitors),
    generatedAt: new Date().toISOString(),
  };
}

function buildLlmPrompt(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
  brandProfile?: BrandProfile,
) {
  const extractedBrandShares = extractSovBrandShares(payload.extractedSov);
  const extractedBrandList = extractedBrandShares.map((share) => share.brand);

  // Merge competitors from the request with those already in the extracted SOV.
  // The competitors field contains brands explicitly provided by the SpaceCat backend
  // (e.g., from mentions.others in the API response) that may not appear in the SOV string.
  const extractedBrandKeys = new Set(extractedBrandList.map((b) => normalizeBrandKey(b)));
  const allCompetitors: string[] = [
    ...extractedBrandList,
    ...(payload.competitors ?? []).filter(
      (c) => !extractedBrandKeys.has(normalizeBrandKey(c)),
    ),
  ];

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
    `Known competitor brands (NON-EXHAUSTIVE seed list — actively discover additional same-industry competitors in the evidence): ${allCompetitors.join(', ') || 'None'}`,
    `Extracted Sentiment (backend claim — audit this): ${payload.extractedSentiment || 'None'}`,
  );

  if (brandProfile && brandProfile.targetBrand) {
    promptLines.push(
      '',
      `Authoritative brand profile for ${brandProfile.targetBrand} (use this to decide what counts as a target-brand mention):`,
      ...(brandProfile.primaryIndustry
        ? [`  Primary industry: ${brandProfile.primaryIndustry}`]
        : []),
      `  Is sales channel / retailer: ${brandProfile.isSalesChannel ? 'YES — other retailers ARE competitors for SOV purposes' : 'NO — retailers and sales channels are NOT competitors and must be excluded from SOV'}`,
      `  Also known as / aliases for ${brandProfile.targetBrand} (DO count these as target-brand mentions; do NOT list them as separate brandMentions entries): ${(brandProfile.targetBrandAliases ?? []).join(', ') || 'None known'}`,
      `  Owned products / sub-brands of ${brandProfile.targetBrand} (DO count these as target-brand mentions): ${brandProfile.ownedProducts.join(', ') || 'None known'}`,
      `  Brands NOT owned by ${brandProfile.targetBrand} (do NOT count these as target-brand mentions, even if they share the same product category): ${brandProfile.knownCompetitors.join(', ') || 'None known'}`,
      ...(brandProfile.parentOrganization
        ? [`  Parent organization: ${brandProfile.parentOrganization}`]
        : []),
    );
  }

  promptLines.push(
    '',
    'Process:',
    '  1. Use the Item Title as a fast topical signal before reading the body (e.g., "Manulife RRSP" signals a retirement-plan thread). Count any target-brand mentions that appear in the title.',
    `  2. Read the fetched evidence (post + comments for Reddit, video metadata / transcript for YouTube, page text for web) and count explicit mentions of the target brand (→ targetBrandMentionCount) AND every brand you identify in the evidence (→ brandMentions). For EVERY brand in "Known competitor brands", include an entry in brandMentions — even if its count is 0. Also include any OTHER competing brands you find mentioned in the evidence that are NOT in "Known competitor brands" — add them with their actual mention count. These additional brands are critical: they form the SOV denominator.`,
    '  3. Judge the sentiment toward the target brand — i.e. how the brand is PERCEIVED AND TALKED ABOUT in the content — as "Favorable" | "Neutral" | "Unfavorable". Use "No brand mentions" if neither the brand name nor any of its well-known products, models, or sub-brands appear in the evidence. Use "Needs Review" ONLY if the evidence is too sparse to form any judgment — never use it merely because the exact brand name is absent when its products are clearly present.',
    '     IMPORTANT: Sentiment reflects how the brand is perceived by the community, NOT the tone of the original poster\'s question. A post that is simply asking for advice is not automatically Neutral if the replies show strong positive or negative reactions to the brand.',
    '  4. Return integer mention counts — do NOT compute percentages. The system derives SOV percentages from your counts and compares them against the backend\'s extracted values.',
  );

  if (evidence.usedComments) {
    if (evidence.sourceType === 'reddit') {
      promptLines.push(
        '  5. For Reddit threads: the "Replies / Comments" section represents OTHER USERS\' authentic opinions about the brand — weight it heavily for sentiment.',
        '     A poster asking "Is this deal fair?" is neutral, but if replies say "horrible to lease", "don\'t do this", "worst deals around", the community perception is clearly UNFAVORABLE.',
        '     Conversely, if replies are enthusiastic or complimentary, lean Favorable.',
        '  6. In your sentimentRationale and rationale explicitly state:',
        '     - Original post tone: [neutral question / positive / negative]',
        '     - Community reply sentiment: [your assessment — cite 1-2 specific examples from comments]',
        '     - Combined verdict: [overall brand perception label and reason, with comments weighted heavily]',
      );
    } else {
      promptLines.push(
        '  5. When "Viewer comments:" section is present in the evidence, assess comment sentiment toward the target brand SEPARATELY from the video content sentiment.',
        '  6. In your rationale explicitly state:',
        '     - Video content sentiment: [your assessment from title/description/transcript]',
        '     - Viewer comment sentiment: [your assessment from the comments — note if comments are mostly positive, negative, neutral, or mixed toward the brand, and cite 1-2 specific examples]',
        '     - Combined verdict: [the overall sentiment label you chose and why]',
      );
    }
  }

  promptLines.push(
    '',
    'Auditing rules (these override any instinct to agree with the backend):',
    '  - Brand mentions: count the exact target brand name AND its well-known products, models, or sub-brands using your general knowledge (e.g. "Range Rover" and "Defender" are Land Rover models; "iPhone" is an Apple product; "Corolla" is a Toyota model). Do NOT require an exact brand-name match — a product mention IS a brand mention.',
    '  - Treat case, spacing, punctuation, regional, possessive, and alias variants of a brand as the SAME brand and merge their counts into a single brandMentions entry. Specifically:',
    '       (a) Case/spacing/punctuation — "SunLife" = "Sun Life" = "Sun-Life" (all 3 → ONE entry with mentionCount: 3). Same for "Coca-Cola"/"Coca Cola"/"CocaCola".',
    '       (b) Regional / country qualifiers — "WK Kellogg" = "WK Kellogg Canada" = "WK Kellogg US" = "WK Kellogg (North America)". The country is a storefront, not a different brand. Strip it before counting.',
    '       (c) Possessive forms — "Kellogg" = "Kellogg\'s" = "Kelloggs". "McDonald" = "McDonald\'s" = "McDonalds". The possessive marker is grammatical, not a brand distinction.',
    '       (d) Aliases / acronyms / well-known nicknames — when an alternate official name, acronym, or widely-used nickname refers to the same entity, merge them. For the TARGET BRAND, prefer the "Also known as / aliases" list in the brand profile above as the authoritative source. For COMPETITOR BRANDS, use your general knowledge: "KFC" = "Kentucky Fried Chicken"; "GE" = "General Electric"; "HP" = "Hewlett-Packard" = "Hewlett Packard"; "IBM" = "International Business Machines" = "Big Blue"; "JPM" = "JPMorgan" = "JPMorgan Chase". Be CONSERVATIVE: only merge well-known, widely-recognized aliases. Do NOT invent or speculate (e.g., do not assume a random 3-letter token is an acronym for a brand mentioned elsewhere in the evidence — require an established public association).',
    '     Pick one canonical spelling (typically the longer/full form) and report the summed count once. If the backend\'s extracted SOV lists these variants as separate brands, treat that as a backend error and report the merged count in your audit.',
    '  - INDUSTRY FILTER (critical for SOV correctness): brandMentions must ONLY contain brands that operate in the SAME primary industry as the target brand (see "Primary industry" in the brand profile above). Out-of-industry brands — even when they appear in the evidence — are NOT competitors and must be EXCLUDED from brandMentions. They do not belong in the SOV denominator. Example: if the target brand is Sun Life (Life Insurance & Wealth Management) and the evidence mentions Tesla, Nike, or Adobe, those are NOT competitors and MUST NOT appear in brandMentions. If a brand listed in "Known competitor brands" is clearly from a different industry, exclude it too (the brand profile may be wrong) and note the discrepancy in your rationale. This filter is about CROSS-INDUSTRY noise — it is NOT permission to omit clear same-industry competitors that happen to be missing from the seed competitors list (see OPEN-WORLD COMPETITOR DISCOVERY below). When a brand is plainly in the same industry as the target (e.g., another breakfast cereal for a cereal brand, another life insurer for an insurance brand), INCLUDE it regardless of whether it appears in the seed list.',
    '  - SALES CHANNEL FILTER: if the brand profile says "Is sales channel / retailer: NO", retailers, marketplaces, and distribution channels (Amazon, Walmart, Target, Costco, Best Buy, eBay, Etsy, Walgreens, CVS, Loblaws, Sobeys, app stores, Shopify storefronts, etc.) are WHERE the product is sold, not COMPETITORS of the product. EXCLUDE them entirely from brandMentions — they do not belong in the SOV denominator. Example: for Rice Krispies (a cereal producer, not a retailer), a Reddit thread mentioning "I bought it at Walmart and Costco" must NOT add Walmart or Costco to brandMentions. Only when the target brand IS a sales channel (Is sales channel / retailer: YES) do other retailers count as legitimate competing brands. When uncertain whether something is a retailer vs a producer in the target\'s industry, exclude it — channel pollution corrupts the denominator far more than missing one borderline brand.',
    '  - MENTION INTENT FILTER (avoid inflating counts with incidental usage): only count an occurrence as a brand/product mention if the discussion is genuinely ABOUT the brand or product — its quality, performance, value, experience, fit, support, comparison to alternatives, etc. Do NOT count occurrences where the brand name is used as:',
    '       (a) an ingredient or component in a recipe ("Rice Krispies treats", "Oreo crust", "Nutella sandwich") — that is a cooking discussion, not a brand discussion;',
    '       (b) a generic category synonym ("a Kleenex" meaning any tissue, "a Band-Aid solution") — that is language, not brand engagement;',
    '       (c) part of a proper noun unrelated to the company itself (place names, event names, sports-team sponsorships used only as a venue label, e.g. "the Manulife Centre" as a building) — that is a location reference, not a brand discussion;',
    '       (d) a passing namedrop with no expressed view (e.g. an author listing "Sun Life, Manulife, Canada Life" as examples of companies in a Wikipedia-style definitional sentence) — that is enumeration, not opinion.',
    '     Apply the same intent filter to competitor brands in brandMentions. Reflect any excluded occurrences in the rationale so the audit explains why your count is lower than a naive string-match would suggest.',
    '  - THREAD MEANINGFULNESS GATE (avoid inferring sentiment from informational content): before assigning Favorable / Unfavorable, verify the evidence actually contains expressions of opinion, experience, preference, recommendation, complaint, or comparison about the target brand. If the entire evidence is purely informational — definitional ("X is a Y that does Z"), procedural ("here is how to file a claim"), factual ("the company was founded in YYYY"), or news-summary with no editorial slant — the thread does NOT support a Favorable/Unfavorable judgment.',
    '     In that case: set evaluatedSentiment = "Neutral" with LOW confidence and explicitly state in sentimentRationale that the thread is informational/definitional with no opinion signal. Do NOT fabricate a positive or negative tone from the absence of complaints. Note the lack of opinion content in rationale so the audit flags this thread as low-signal for SOV interpretation purposes.',
    '  - CRITICAL: a product only counts as a target-brand mention if the product is actually OWNED by the target brand. Products from a competing company in the same category do NOT count. For example, if the target brand is WK Kellogg, "Cheerios" is a General Mills product and is NOT a Kellogg mention; "Honey Nut Cheerios" is also General Mills. When an "Authoritative brand profile" is provided above, it is the definitive reference: only items in the "Owned products / sub-brands" list count as target-brand mentions; anything in the "Brands NOT owned" list NEVER counts even if it appears in the evidence. Without a profile, fall back to your general knowledge — but never count products from competitors in the same category. When uncertain whether a product belongs to the target brand, do NOT count it.',
    '  - If neither the target brand name NOR any of its OWNED products/models appear in the evidence, set targetBrandMentionCount = 0 and evaluatedSentiment = "No brand mentions" with high confidence. This is the correct verdict even if the evidence discusses competitor brands at length, and even if Extracted SOV claims a non-zero share — that disagreement is a backend error the system needs to flag. Do NOT pick "Neutral" or any other sentiment label when only competitor brands appear; "Neutral" requires the target brand to actually be present.',
    '  - Do not inflate counts to match the backend. If you count 3 mentions and the backend claims 8, return 3.',
    '  - Adjacent sentiment labels (e.g., Favorable vs Neutral) are still a disagreement — only return the label you actually judged from the evidence.',
    '  - Title-only mentions count toward targetBrandMentionCount but the sentiment should be judged from the body/transcript when available, not from the title alone.',
    '  - If the target brand is already one of the extracted SOV brands, use the same count in both that brand\'s mentionCount and targetBrandMentionCount.',
    '  - Always include an entry in brandMentions for every brand listed in "Known competitor brands", even if that brand has 0 mentions in the evidence. Additionally, include any other competing brands you find in the evidence with their actual mention count — they are required so the SOV denominator is correct. For example, if the evidence mentions Special K (1), Lenny & Larry\'s (1), ON (1) and Kashi (2), brandMentions must list all four brands so the total is 5, not just 2.',
    '  - OPEN-WORLD COMPETITOR DISCOVERY (critical — do NOT treat the competitors list as a closed set): the "Known competitor brands" list is a NON-EXHAUSTIVE seed. Your job is to ACTIVELY DISCOVER additional same-industry brands in the evidence and add them to brandMentions, even when the brand profile did not anticipate them. If a brand appears in the evidence and is clearly in the same primary industry as the target brand (regardless of which parent company owns it, regardless of whether it is a sub-brand of a competitor parent), INCLUDE it as a separate brandMentions entry with its mention count. Do NOT drop a same-industry competitor just because it is owned by a different parent company than expected.',
    '     WORKED EXAMPLE: target brand = Kellogg (primary industry: Ready-to-Eat Breakfast Cereal). Evidence mentions Captain Crunch and Nutella. Captain Crunch is a Quaker / PepsiCo cereal product → it IS a same-industry competitor and MUST be added to brandMentions (count it). Nutella is a Ferrero spread (different industry) → it must NOT be added. Even though "Captain Crunch" is not in the seed competitors list, omitting it would inflate Kellogg\'s SOV toward 100% and corrupt the audit. Do NOT write language like "X was not counted because it was not in the known competitors list" — that reasoning is wrong; the list is a seed, not a boundary.',
    '     Rule of thumb: a brand belongs in brandMentions if (a) it appears in the evidence, AND (b) it competes in the same primary industry, AND (c) it is not a retailer/sales channel when the target is a producer. Parent-company ownership is irrelevant — competing sub-brands of competing parent companies still compete with the target.',
    '  - "Needs Review" is ONLY for genuinely insufficient evidence (very short snippets, pure metadata, fetch errors). If you have a real transcript, article body, or comment thread, the evidence is sufficient — pick a sentiment label even if confidence is low. Do NOT use "Needs Review" as a hedge when the brand name is missing but its products are present.',
    '  - "sentimentRationale": 2-4 sentences describing ONLY how the brand is perceived in the content. Focus on tone, specific user reactions, and overall brand image conveyed. For Reddit, quote or paraphrase 1-2 comment examples that best reflect the community\'s feeling toward the brand. Do NOT mention brand mention counts, SOV percentages, competitor comparisons, or backend extracted-value comparisons — those belong in "rationale" only.',
    '  - "rationale": Full reasoning covering both your sentiment judgment AND your SOV audit (mention counts, percentage comparison to backend\'s extracted values, any discrepancies found).',
    '',
    'Evidence:',
    evidence.evidenceText,
  );

  return promptLines.join('\n');
}

function buildBedrockPrompt(
  payload: SentimentEvaluationRequest,
  evidence: SourceEvidence,
  brandProfile?: BrandProfile,
) {
  return [
    buildLlmPrompt(payload, evidence, brandProfile),
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
    '  "sentimentRationale": string,',
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
    typeof candidate.sentimentRationale !== 'string' ||
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
  brandProfile?: BrandProfile,
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
                content: [{ text: buildBedrockPrompt(payload, evidence, brandProfile) }],
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
  // Fetch the per-site brand profile once (cached). If profile generation
  // fails, evaluation continues without it — the prompt's existing
  // brand-mention rules still apply.
  const brandProfile = await getBrandProfile(payload.site, env);

  const bedrockApiKey = getBedrockBearerToken(env);
  const bedrockRegion = getBedrockRegion(env);

  if (bedrockApiKey && bedrockRegion) {
    try {
      return await fetchBedrockEvaluation(payload, evidence, env, brandProfile);
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
            text: buildLlmPrompt(payload, evidence, brandProfile),
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
            sentimentRationale: { type: 'string' },
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
            'sentimentRationale',
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

  // Brand-owned source: sentiment is inherently favorable — skip LLM.
  if (evidence.isBrandOwned) {
    const sourceLabel =
      evidence.sourceType === 'youtube'
        ? "the brand's own YouTube channel"
        : "the brand's own website";
    const commentNote =
      evidence.sourceType === 'youtube' && evidence.usedComments
        ? ' Viewer comments are included in the evidence for context.'
        : evidence.sourceType === 'youtube'
          ? ' No viewer comments were available.'
          : '';

    return {
      evaluatedSentiment: 'Favorable',
      sentimentConfidence: 65,
      evaluatedSov: 'Needs Review',
      sovConfidence: 20,
      evaluatedTargetBrandSharePct: -1,
      rationale:
        `This content is published on ${sourceLabel}. Brand-produced content is inherently favorable toward the brand.${commentNote}`,
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
        isBrandOwned: evidence.isBrandOwned,
      },
      targetBrand: '',
    };
  }

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
        isBrandOwned: evidence.isBrandOwned,
      },
      targetBrand: '',
    };
  }

  const llmResponse = await fetchLlmEvaluation(payload, evidence, env);
  const llmResult = llmResponse.evaluation;
  const extractedBrandShares = extractSovBrandShares(payload.extractedSov, llmResult.targetBrand);
  // Re-fetch the brand profile (cache hit — already populated by fetchLlmEvaluation).
  // We pass it into buildEvaluatedBrandShares so owned products / sub-brands
  // that the LLM listed as separate brandMentions entries can fold back into
  // the target brand's count.
  const brandProfile = await getBrandProfile(payload.site, env);
  const evaluatedBrandShares = buildEvaluatedBrandShares({
    extractedBrandShares,
    llmResult,
    brandProfile,
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
    sentimentRationale: trimMultilineText(llmResult.sentimentRationale),
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
      isBrandOwned: evidence.isBrandOwned,
    },
    transcript: evidence.transcript,
    videoTitle: evidence.videoTitle,
    videoChannel: evidence.videoChannel,
    redditThread: evidence.redditThread,
    redditPostTitle: evidence.redditPostTitle,
    redditCommunity: evidence.redditCommunity,
    pageContent: evidence.pageContent,
    pageTitle: evidence.pageTitle,
    pageFormat: evidence.pageFormat,
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
