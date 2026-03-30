import { SUGGESTION_EVALUATOR_VERSION } from '../src/features/off-site-dashboard/constants';
import type {
  SuggestionEvaluationRequest,
  SuggestionEvaluationResult,
  SuggestionEvaluationVerdict,
} from '../src/features/off-site-dashboard/types';

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
const BEDROCK_MODEL_FALLBACKS = [
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
] as const;
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const REQUEST_USER_AGENT =
  'Mozilla/5.0 (compatible; OffSiteDashboardSuggestionEvaluator/1.0; +https://vercel.com)';
const MAX_EVIDENCE_CHARACTERS = 14000;
const MIN_EVIDENCE_CHARACTERS = 180;

type ServerEnv = {
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_REGION?: string;
  BEDROCK_REGION?: string;
  BEDROCK_MODEL_ID?: string;
  BEDROCK_MODEL?: string;
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

type SuggestionEvidenceBundle = {
  sources: SourceEvidence[];
  status: SourceEvidence['status'];
  combinedEvidenceText: string;
  fallbackSnippet: string;
};

type LlmSuggestionEvaluation = {
  targetBrand: string;
  verdict: SuggestionEvaluationVerdict;
  evidenceSufficient: boolean;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  evidenceSnippet: string;
  correctedSuggestion: string;
};

type LlmSuggestionEvaluationResponse = {
  evaluation: LlmSuggestionEvaluation;
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

function getPreferredBedrockModel(env: ServerEnv) {
  return env.BEDROCK_MODEL_ID ?? env.BEDROCK_MODEL;
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

function normalizeRequestPayload(value: unknown): SuggestionEvaluationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<SuggestionEvaluationRequest>;

  if (
    typeof candidate.site !== 'string' ||
    typeof candidate.opportunityType !== 'string' ||
    typeof candidate.opportunityId !== 'string' ||
    typeof candidate.suggestionText !== 'string' ||
    !Array.isArray(candidate.evidenceItems)
  ) {
    return null;
  }

  return {
    site: candidate.site,
    siteId: typeof candidate.siteId === 'string' ? candidate.siteId : undefined,
    opportunityType: candidate.opportunityType,
    opportunityId: candidate.opportunityId,
    suggestionId:
      typeof candidate.suggestionId === 'string' ? candidate.suggestionId : undefined,
    suggestionText: candidate.suggestionText,
    suggestionUrl:
      typeof candidate.suggestionUrl === 'string' ? candidate.suggestionUrl : undefined,
    evidenceItems: candidate.evidenceItems.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    ),
  };
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

function normalizeWikipediaTitle(value: string) {
  return decodeURIComponent(value)
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWikipediaSearchTerms(site: string) {
  try {
    const normalizedSite = normalizeAbsoluteUrl(site);

    if (!normalizedSite) {
      return [];
    }

    const parsedUrl = new URL(normalizedSite);
    const host = parsedUrl.hostname.replace(/^www\./i, '');
    const labels = host.split('.').filter(Boolean);
    const registrableLabel = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    const joinedLabels = labels.slice(0, -1).join(' ');
    const normalizedCandidates = [joinedLabels, registrableLabel, host]
      .map((value) => value.replace(/[-_]+/g, ' ').trim())
      .filter(Boolean);

    return normalizedCandidates.filter(
      (value, index) => normalizedCandidates.indexOf(value) === index,
    );
  } catch {
    return [];
  }
}

async function searchWikipediaTitles(searchTerm: string) {
  if (!searchTerm.trim()) {
    return [];
  }

  try {
    const payload = await fetchText(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        searchTerm,
      )}&srlimit=3&utf8=1&format=json`,
    );
    const parsedPayload = JSON.parse(payload) as {
      query?: {
        search?: Array<{ title?: string }>;
      };
    };

    return (parsedPayload.query?.search ?? [])
      .map((entry) => entry.title?.trim())
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

async function fetchWikipediaArticleEvidence(articleTitle: string): Promise<SourceEvidence> {
  const normalizedTitle = normalizeWikipediaTitle(articleTitle);

  if (!normalizedTitle) {
    return {
      sourceType: 'web',
      sourceUrl: 'https://en.wikipedia.org/wiki/',
      usedTranscript: false,
      transcriptStatus: 'not_applicable',
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Wikipedia title could not be determined.',
    };
  }

  try {
    const payload = await fetchText(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&redirects=1&inprop=url&explaintext=1&titles=${encodeURIComponent(
        normalizedTitle,
      )}&format=json`,
    );
    const parsedPayload = JSON.parse(payload) as {
      query?: {
        pages?: Record<
          string,
          {
            title?: string;
            fullurl?: string;
            canonicalurl?: string;
            extract?: string;
            missing?: boolean | string;
          }
        >;
      };
    };
    const page = Object.values(parsedPayload.query?.pages ?? {})[0];
    const title = page?.title?.trim() || normalizedTitle;
    const extract = trimMultilineText(page?.extract ?? '');
    const sourceUrl =
      page?.fullurl?.trim() ||
      page?.canonicalurl?.trim() ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;

    if (!page || page.missing || !extract) {
      return {
        sourceType: 'web',
        sourceUrl,
        usedTranscript: false,
        transcriptStatus: 'not_applicable',
        status: 'insufficient_evidence',
        evidenceText: '',
        fallbackSnippet: `Wikipedia page "${title}" could not be loaded.`,
      };
    }

    const evidenceText = clampEvidenceText(
      trimMultilineText([`Wikipedia title: ${title}`, `Extract:\n${extract}`].join('\n\n')),
    );

    return {
      sourceType: 'web',
      sourceUrl,
      usedTranscript: false,
      transcriptStatus: 'not_applicable',
      status:
        evidenceText.length >= MIN_EVIDENCE_CHARACTERS ? 'success' : 'partial',
      evidenceText,
      fallbackSnippet: title,
    };
  } catch {
    return {
      sourceType: 'web',
      sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        normalizedTitle.replace(/\s+/g, '_'),
      )}`,
      usedTranscript: false,
      transcriptStatus: 'not_applicable',
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Failed to fetch Wikipedia page content.',
    };
  }
}

async function fetchYoutubeEvidence(itemUrl: string): Promise<SourceEvidence> {
  try {
    const html = await fetchText(itemUrl);
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
      transcriptStatus: 'unknown',
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Failed to fetch YouTube content.',
    };
  }
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
    }
  }

  for (const htmlUrl of buildRedditHtmlUrls(itemUrl)) {
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
    }
  }

  return {
    sourceType: 'reddit',
    sourceUrl: itemUrl,
    usedTranscript: false,
    transcriptStatus: 'not_applicable',
    status: 'fetch_failed',
    evidenceText: '',
    fallbackSnippet: lastFetchError
      ? `Failed to fetch Reddit content. ${lastFetchError}`
      : 'Failed to fetch Reddit content.',
  };
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
      transcriptStatus: 'not_applicable',
      status: 'fetch_failed',
      evidenceText: '',
      fallbackSnippet: 'Failed to fetch page content.',
    };
  }
}

async function fetchEvidenceForSuggestionRequest(
  payload: SuggestionEvaluationRequest,
): Promise<SuggestionEvidenceBundle> {
  if (payload.opportunityType === 'Wikipedia') {
    const wikipediaTitles = new Set<string>();
    const normalizedSuggestionUrl = payload.suggestionUrl
      ? normalizeAbsoluteUrl(payload.suggestionUrl)
      : '';

    if (normalizedSuggestionUrl) {
      try {
        const parsedSuggestionUrl = new URL(normalizedSuggestionUrl);

        if (parsedSuggestionUrl.hostname.includes('wikipedia.org')) {
          const suggestionTitle = normalizeWikipediaTitle(
            parsedSuggestionUrl.pathname.replace(/^\/wiki\//i, ''),
          );

          if (suggestionTitle) {
            wikipediaTitles.add(suggestionTitle);
          }
        }
      } catch {
        // Ignore malformed suggestion URLs and fall back to search terms.
      }
    }

    if (wikipediaTitles.size === 0) {
      const searchTerms = buildWikipediaSearchTerms(payload.site);

      for (const searchTerm of searchTerms) {
        const titles = await searchWikipediaTitles(searchTerm);
        titles.forEach((title) => wikipediaTitles.add(title));

        if (wikipediaTitles.size > 0) {
          break;
        }
      }
    }

    const sources =
      wikipediaTitles.size > 0
        ? await Promise.all(
            Array.from(wikipediaTitles)
              .slice(0, 2)
              .map((title) => fetchWikipediaArticleEvidence(title)),
          )
        : [
            {
              sourceType: 'web' as const,
              sourceUrl: payload.site,
              usedTranscript: false,
              transcriptStatus: 'not_applicable' as const,
              status: 'fetch_failed' as const,
              evidenceText: '',
              fallbackSnippet: 'No matching Wikipedia page could be identified for this site.',
            },
          ];
    const evidenceSections = sources
      .filter((source) => source.evidenceText)
      .map(
        (source, index) =>
          `Source ${index + 1} (${source.sourceUrl}):\n${source.evidenceText}`,
      );
    const combinedEvidenceText = clampEvidenceText(evidenceSections.join('\n\n---\n\n'));
    const fallbackSnippet =
      sources.map((source) => source.fallbackSnippet).find(Boolean) ||
      'No evidence could be gathered for this suggestion.';
    const hasSuccess = sources.some((source) => source.status === 'success');
    const hasPartial = sources.some((source) => source.status === 'partial');
    const hasAnyEvidence = sources.some((source) => source.evidenceText.length > 0);

    return {
      sources,
      combinedEvidenceText,
      fallbackSnippet,
      status:
        combinedEvidenceText.length < MIN_EVIDENCE_CHARACTERS
          ? hasAnyEvidence
            ? 'insufficient_evidence'
            : 'fetch_failed'
          : hasSuccess
            ? 'success'
            : hasPartial
              ? 'partial'
              : 'insufficient_evidence',
    };
  }

  const candidateUrls = Array.from(
    new Set(
      [
        payload.suggestionUrl ? normalizeAbsoluteUrl(payload.suggestionUrl) : '',
        ...payload.evidenceItems.map(normalizeAbsoluteUrl),
        payload.evidenceItems.length === 0 ? normalizeAbsoluteUrl(payload.site) : '',
      ].filter(Boolean),
    ),
  ).slice(0, 3);

  const sources = await Promise.all(
    candidateUrls.map((url) => {
      if (payload.opportunityType === 'YouTube') {
        return fetchYoutubeEvidence(url);
      }

      if (payload.opportunityType === 'Reddit') {
        return fetchRedditEvidence(url);
      }

      return fetchWebEvidence(url);
    }),
  );

  const evidenceSections = sources
    .filter((source) => source.evidenceText)
    .map(
      (source, index) =>
        `Source ${index + 1} (${source.sourceType} | ${source.sourceUrl}):\n${source.evidenceText}`,
    );
  const combinedEvidenceText = clampEvidenceText(evidenceSections.join('\n\n---\n\n'));
  const fallbackSnippet =
    sources.map((source) => source.fallbackSnippet).find(Boolean) ||
    'No evidence could be gathered for this suggestion.';
  const hasSuccess = sources.some((source) => source.status === 'success');
  const hasPartial = sources.some((source) => source.status === 'partial');
  const hasAnyEvidence = sources.some((source) => source.evidenceText.length > 0);

  return {
    sources,
    combinedEvidenceText,
    fallbackSnippet,
    status:
      combinedEvidenceText.length < MIN_EVIDENCE_CHARACTERS
        ? hasAnyEvidence
          ? 'insufficient_evidence'
          : 'fetch_failed'
        : hasSuccess
          ? 'success'
          : hasPartial
            ? 'partial'
            : 'insufficient_evidence',
  };
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
  confidence: LlmSuggestionEvaluation['confidence'],
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

function buildSuggestionConfidenceScore(input: {
  llmResult: LlmSuggestionEvaluation;
  fetchStatus: SourceEvidence['status'];
}) {
  let confidenceScore =
    getConfidenceBase(input.llmResult.confidence, input.llmResult.evidenceSufficient) -
    getEvidencePenalty(input.fetchStatus);

  if (!input.llmResult.evidenceSufficient || input.llmResult.verdict === 'Needs Review') {
    confidenceScore -= 16;
  } else {
    confidenceScore += 4;
  }

  return clampConfidenceScore(confidenceScore);
}

function buildSuggestionPrompt(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
) {
  return [
    'You are an expert in off-site SEO, GEO, AEO, Reddit, YouTube, Cited URLs, and Wikipedia visibility.',
    'Judge whether the suggestion is grounded in the provided evidence or appears hallucinated / unsupported.',
    'Use only the evidence provided below.',
    '',
    `Site URL: ${payload.site}`,
    `Site ID: ${payload.siteId ?? 'Unknown'}`,
    `Opportunity Type: ${payload.opportunityType}`,
    `Opportunity ID: ${payload.opportunityId}`,
    `Suggestion ID: ${payload.suggestionId ?? 'Unknown'}`,
    `Suggestion text: ${payload.suggestionText}`,
    `Suggestion URL: ${payload.suggestionUrl ?? 'None'}`,
    '',
    'Return:',
    '- verdict = "Correct", "Incorrect", or "Needs Review"',
    '- rationale explaining why',
    '- evidenceSnippet with the strongest supporting or contradictory evidence',
    '- correctedSuggestion if the original suggestion is incorrect; otherwise return an empty string',
    '- evidenceSufficient = false if the fetched evidence is too weak to make a grounded decision',
    '',
    'Evidence:',
    evidence.combinedEvidenceText,
  ].join('\n');
}

function buildSuggestionBedrockPrompt(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
) {
  return [
    buildSuggestionPrompt(payload, evidence),
    '',
    'Return ONLY a valid JSON object. Do not add markdown, code fences, or any explanatory text.',
    'Use this exact schema:',
    '{',
    '  "targetBrand": string,',
    '  "verdict": "Correct" | "Incorrect" | "Needs Review",',
    '  "evidenceSufficient": boolean,',
    '  "confidence": "high" | "medium" | "low",',
    '  "rationale": string,',
    '  "evidenceSnippet": string,',
    '  "correctedSuggestion": string',
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

function parseSuggestionLlmPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Failed to parse suggestion evaluator response.');
  }

  const candidate = value as Partial<LlmSuggestionEvaluation>;

  if (
    typeof candidate.targetBrand !== 'string' ||
    typeof candidate.verdict !== 'string' ||
    typeof candidate.evidenceSufficient !== 'boolean' ||
    typeof candidate.confidence !== 'string' ||
    typeof candidate.rationale !== 'string' ||
    typeof candidate.evidenceSnippet !== 'string' ||
    typeof candidate.correctedSuggestion !== 'string'
  ) {
    throw new Error('Failed to parse suggestion evaluator response.');
  }

  return candidate as LlmSuggestionEvaluation;
}

async function fetchSuggestionBedrockEvaluation(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
  env: ServerEnv,
): Promise<LlmSuggestionEvaluationResponse> {
  const apiKey = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  const region = getBedrockRegion(env);

  if (!apiKey) {
    throw new Error('AWS_BEARER_TOKEN_BEDROCK is missing.');
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
                content: [{ text: buildSuggestionBedrockPrompt(payload, evidence) }],
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
        evaluation: parseSuggestionLlmPayload(extractJsonObject(outputText)),
        provider: 'bedrock',
        model: modelId,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unexpected Bedrock error.';
    }
  }

  throw new Error(lastError || 'Bedrock request failed.');
}

async function fetchSuggestionLlmEvaluation(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
  env: ServerEnv,
): Promise<LlmSuggestionEvaluationResponse> {
  const bedrockApiKey = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  const bedrockRegion = getBedrockRegion(env);

  if (bedrockApiKey && bedrockRegion) {
    try {
      return await fetchSuggestionBedrockEvaluation(payload, evidence, env);
    } catch {
      // Fall through to Azure/OpenAI.
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
        : 'OPENAI_API_KEY, AZURE_OPENAI_KEY, or AWS_BEARER_TOKEN_BEDROCK is missing.',
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
            text: buildSuggestionPrompt(payload, evidence),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'offsite_suggestion_evaluation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetBrand: { type: 'string' },
            verdict: {
              type: 'string',
              enum: ['Correct', 'Incorrect', 'Needs Review'],
            },
            evidenceSufficient: { type: 'boolean' },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            rationale: { type: 'string' },
            evidenceSnippet: { type: 'string' },
            correctedSuggestion: { type: 'string' },
          },
          required: [
            'targetBrand',
            'verdict',
            'evidenceSufficient',
            'confidence',
            'rationale',
            'evidenceSnippet',
            'correctedSuggestion',
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
          }) => entry.content ?? [],
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
    evaluation: parseSuggestionLlmPayload(parsedOutput),
    provider: useAzure ? 'azure' : 'openai',
    model: modelName,
  };
}

export async function runOffsiteSuggestionEvaluation(
  rawPayload: unknown,
  env: ServerEnv = {},
): Promise<SuggestionEvaluationResult> {
  const payload = normalizeRequestPayload(rawPayload);

  if (!payload) {
    throw new Error('Invalid suggestion evaluator request payload.');
  }

  const evidence = await fetchEvidenceForSuggestionRequest(payload);

  if (
    evidence.status === 'fetch_failed' ||
    evidence.status === 'insufficient_evidence'
  ) {
    const weakEvidenceScore = evidence.status === 'fetch_failed' ? 12 : 28;

    return {
      verdict: 'Needs Review',
      confidence: weakEvidenceScore,
      rationale:
        evidence.status === 'fetch_failed'
          ? 'The source evidence could not be fetched for an independent suggestion check.'
          : 'The fetched evidence was too thin to judge whether the suggestion is grounded.',
      evidenceSnippet: evidence.fallbackSnippet,
      correctedSuggestion: '',
      evaluatedAt: new Date().toISOString(),
      evaluatorVersion: SUGGESTION_EVALUATOR_VERSION,
      evidenceSources: evidence.sources.map((source) => ({
        status: source.status,
        sourceType: source.sourceType,
        sourceUrl: source.sourceUrl,
        usedTranscript: source.usedTranscript,
        transcriptStatus: source.transcriptStatus,
        evidenceCharacters: source.evidenceText.length,
      })),
      targetBrand: '',
    };
  }

  const llmResponse = await fetchSuggestionLlmEvaluation(payload, evidence, env);
  const llmResult = llmResponse.evaluation;

  return {
    verdict: llmResult.verdict,
    confidence: buildSuggestionConfidenceScore({
      llmResult,
      fetchStatus: evidence.status,
    }),
    rationale: trimMultilineText(llmResult.rationale),
    evidenceSnippet:
      trimMultilineText(llmResult.evidenceSnippet) || evidence.fallbackSnippet,
    correctedSuggestion: trimMultilineText(llmResult.correctedSuggestion),
    evaluatedAt: new Date().toISOString(),
    evaluatorVersion: SUGGESTION_EVALUATOR_VERSION,
    evaluatorProvider: llmResponse.provider,
    evaluatorModel: llmResponse.model,
    evidenceSources: evidence.sources.map((source) => ({
      status: source.status,
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      usedTranscript: source.usedTranscript,
      transcriptStatus: source.transcriptStatus,
      evidenceCharacters: source.evidenceText.length,
    })),
    targetBrand: llmResult.targetBrand,
  };
}
