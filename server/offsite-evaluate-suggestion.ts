import { SUGGESTION_EVALUATOR_VERSION } from '../src/features/off-site-dashboard/constants.js';
import type {
  SuggestionEvaluationRequest,
  SuggestionEvaluationResult,
  SuggestionEvaluationVerdict,
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
  'Mozilla/5.0 (compatible; OffSiteDashboardSuggestionEvaluator/1.0; +https://vercel.com)';
const MAX_EVIDENCE_CHARACTERS = 14000;
const MIN_EVIDENCE_CHARACTERS = 180;
const MAX_WIKIPEDIA_SOURCE_COUNT = 8;

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
  BRIGHTDATA_YOUTUBE_ASYNC_FALLBACK?: string;
  BRIGHTDATA_YOUTUBE_ASYNC_TIMEOUT_MS?: string;
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
  transcriptStatus:
    | 'available_and_used'
    | 'available_but_not_used'
    | 'not_available'
    | 'not_applicable'
    | 'unknown';
  status: 'success' | 'partial' | 'insufficient_evidence' | 'fetch_failed';
  evidenceText: string;
  fallbackSnippet: string;
  maintenanceScope?: 'section' | 'article' | 'unknown';
  maintenanceSection?: string;
  maintenanceWarningText?: string;
};

type SuggestionEvidenceBundle = {
  sources: SourceEvidence[];
  status: SourceEvidence['status'];
  combinedEvidenceText: string;
  fallbackSnippet: string;
  wikipediaTitleMismatch?: boolean;
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

type WikipediaMaintenanceContext = {
  scope: 'section' | 'article' | 'unknown';
  sectionName?: string;
  warningText?: string;
};

type WikipediaQualityStatusContext = {
  hasGoodArticle?: boolean;
  hasFeaturedArticle?: boolean;
};

type WikipediaDeterministicContext = {
  citationCount?: number;
  avgCitations?: number;
  citationsRank?: number;
  citationsRankOf?: number;
  secondPlaceCitations?: number;
  citationsLeadOverSecondPlace?: number;
  citationsLeadAboveAverage?: number;
  sectionCount?: number;
  avgSections?: number;
  sectionsRank?: number;
  sectionsRankOf?: number;
  imageCount?: number;
  avgImages?: number;
  imagesRank?: number;
  imagesRankOf?: number;
  secondPlaceImages?: number;
  imagesLeadOverSecondPlace?: number;
  categoryCount?: number;
  avgCategories?: number;
  categoriesRank?: number;
  categoriesRankOf?: number;
  categoriesComparison?: string;
  hasInfobox?: boolean;
  hasNavbox?: boolean;
  hasSeeAlso?: boolean;
  hasExternalLinks?: boolean;
  competitorsAnalyzed?: number;
  competitorsWithInfobox?: { count: number; total: number; percentage: number };
  competitorsWithNavigationBox?: { count: number; total: number; percentage: number };
  competitorsWithSeeAlso?: { count: number; total: number; percentage: number };
  competitorsWithExternalLinks?: { count: number; total: number; percentage: number };
  infoboxFieldCount?: number;
  infoboxFields?: string[];
  commonCompetitorInfoboxFields?: string[];
  missingCommonInfoboxFields?: string[];
  lastEdited?: string;
  editCount30Days?: number;
  hasGoodArticle?: boolean;
  hasFeaturedArticle?: boolean;
};

type WikipediaFetchedMetricEntry = {
  title?: string;
  sourceUrl: string;
  categoryCount?: number;
  sectionCount?: number;
  imageCount?: number;
  wordCount?: number;
};

type WikipediaFetchedCategoryComparison = {
  categoryCount?: number;
  avgCategories?: number;
  categoriesRank?: number;
  categoriesRankOf?: number;
  categoriesComparison?: string;
  leaderName?: string;
  leaderCount?: number;
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

/**
 * Detect whether a Wikipedia File: title refers to a template/UI/chrome icon
 * rather than visible article content.
 *
 * Wikipedia's `prop=images` API returns every File: link on the page, including
 * sister-project logos (Commons-logo.svg), trend arrows (Increase2.svg /
 * Decrease2.svg), category symbols (Symbol_category_class.svg), maintenance
 * banners (Ambox*.svg), and inline icons that link to other companies' logos.
 * None of those are content images a human reader would count when looking at
 * the page, so we filter them out before counting.
 *
 * Title format from the API is "File:Some_Image.svg" — match runs on the
 * lowercased, underscore-normalized basename (no "File:" prefix).
 */
function isWikipediaTemplateImage(fileTitle: string): boolean {
  const normalized = fileTitle
    .replace(/^File:/i, '')
    .replace(/\s+/g, '_')
    .toLowerCase();

  const TEMPLATE_PATTERNS: RegExp[] = [
    /^commons-logo/,                              // Wikimedia Commons sister-project icon
    /^(wikiquote|wiktionary|wikisource|wikinews|wikibooks|wikiversity|wikivoyage|wikidata|meta-wiki)-logo/, // Other sister-project icons
    /^(increase|decrease|steady)\d*\.svg$/,       // Infobox trend arrows
    /^symbol_/,                                   // Category/portal symbol icons
    /^ambox/,                                     // Article message box decoration
    /^padlock/,                                   // Page-protection icons
    /^(question_book|edit-clear|disambig)/,       // Cleanup/disambig template icons
    /^red_pog\.svg$/,                             // Map location markers
    /^office-book\.svg$/,                         // Reference/portal icons

    // STUB-MESSAGE IMAGES. Wikipedia stub templates ("This X article is a
    // stub. You can help...") render an icon inside the message box. The
    // wrapper has the ambox class but the IMAGE filename is whatever the
    // stub family uses — most commonly *-stub.svg, or a thematic image
    // like the Ben Franklin hundred-dollar-bill on US-business stubs.
    // These are template chrome, not brand-relevant content images, and
    // their presence inflates the "Live image count" we hand to the LLM.
    /[-_]stub\.svg$/i,                            // Any *-stub.svg / *_stub.svg
    /^stub[-_]icon\.svg$/i,                       // Generic stub-icon.svg
    /^hundred[-_]?dollar[-_]?bill/i,              // US business / retail stub (Ben Franklin)
    /^benjamin[-_]?franklin/i,                    // Direct Franklin portrait used by US stubs
    /^usa[-_]?stub/i,
    /^united[-_]?states[-_]?stub/i,
    /^p[_-](history|economy|business|geography|sports|literature|science)\b/i, // Portal icons
  ];

  return TEMPLATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detect whether a Wikipedia top-level section heading is a standard appendix
 * section (References, External links, Further reading, etc.) rather than
 * prose content describing the article subject.
 *
 * Backend section counts in the SpaceCat opportunity feed typically reflect
 * only content sections, so excluding appendix sections from the live count
 * lets the evaluator compare like for like. Match runs on the lowercased,
 * trimmed heading text — punctuation-tolerant via word-boundary anchors.
 */
function isWikipediaAppendixSection(headingText: string): boolean {
  const normalized = headingText.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return false;

  const APPENDIX_HEADINGS: ReadonlySet<string> = new Set([
    'references',
    'external links',
    'further reading',
    'notes',
    'see also',
    'bibliography',
    'footnotes',
    'citations',
    'sources',
    'notes and references',
    'works cited',
    'literature',
    'gallery',
  ]);

  return APPENDIX_HEADINGS.has(normalized);
}

function parseNumberFromEvidenceItem(
  evidenceItems: string[],
  label: string,
): number | undefined {
  const entry = evidenceItems.find((item) => item.startsWith(`${label}:`));

  if (!entry) {
    return undefined;
  }

  const rawValue = entry.split(':').slice(1).join(':').trim();
  const parsedValue = Number.parseFloat(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function parseBooleanFromEvidenceItem(
  evidenceItems: string[],
  label: string,
): boolean | undefined {
  const entry = evidenceItems.find((item) => item.startsWith(`${label}:`));

  if (!entry) {
    return undefined;
  }

  const rawValue = entry.split(':').slice(1).join(':').trim().toLowerCase();

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  return undefined;
}

function parseStringFromEvidenceItem(
  evidenceItems: string[],
  label: string,
): string | undefined {
  const entry = evidenceItems.find((item) => item.startsWith(`${label}:`));
  const rawValue = entry?.split(':').slice(1).join(':').trim();
  return rawValue || undefined;
}

function parseRankFromEvidenceItem(
  evidenceItems: string[],
  label: string,
): { rank: number; of: number } | undefined {
  const rawValue = parseStringFromEvidenceItem(evidenceItems, label);

  if (!rawValue) {
    return undefined;
  }

  const match = rawValue.match(/^#(\d+)\s+of\s+(\d+)$/i);

  if (!match) {
    return undefined;
  }

  return {
    rank: Number.parseInt(match[1], 10),
    of: Number.parseInt(match[2], 10),
  };
}

function parseCompetitorPrevalenceFromEvidenceItem(
  evidenceItems: string[],
  label: string,
) {
  const rawValue = parseStringFromEvidenceItem(evidenceItems, label);

  if (!rawValue) {
    return undefined;
  }

  const match = rawValue.match(/^(\d+)\s+of\s+(\d+)\s+\(([\d.]+)%\)$/i);

  if (!match) {
    return undefined;
  }

  return {
    count: Number.parseInt(match[1], 10),
    total: Number.parseInt(match[2], 10),
    percentage: Number.parseFloat(match[3]),
  };
}

function parseListFromEvidenceItem(
  evidenceItems: string[],
  label: string,
): string[] | undefined {
  const rawValue = parseStringFromEvidenceItem(evidenceItems, label);

  if (!rawValue) {
    return undefined;
  }

  if (rawValue.toLowerCase() === 'none') {
    return [];
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractLastWikipediaHeadingFromHtml(html: string) {
  const headingMatches = Array.from(
    html.matchAll(
      /<(?:h[1-6])\b[^>]*>([\s\S]*?)<\/(?:h[1-6])>|<span[^>]*class="mw-headline"[^>]*>([\s\S]*?)<\/span>/gi,
    ),
  );
  const lastHeading =
    headingMatches.at(-1)?.[1] ?? headingMatches.at(-1)?.[2] ?? '';
  return stripHtmlTags(lastHeading);
}

function extractWikipediaMaintenanceContextFromHtml(html: string): WikipediaMaintenanceContext {
  const normalizedHtml = html.replace(/\r?\n/g, ' ');
  const sectionMarker = 'This section needs to be updated';
  const articleMarker = 'This article needs to be updated';
  const sectionMatch = normalizedHtml.match(
    /This section needs to be\s*(?:<[^>]+>\s*)?updated/i,
  );
  const articleMatch = normalizedHtml.match(/This article needs to be updated/i);
  const sectionIndex = sectionMatch?.index ?? -1;
  const articleIndex = articleMatch?.index ?? -1;

  if (sectionIndex === -1 && articleIndex === -1) {
    return {
      scope: 'unknown',
    };
  }

  if (sectionIndex !== -1 && (articleIndex === -1 || sectionIndex < articleIndex)) {
    const htmlBeforeWarning = normalizedHtml.slice(0, sectionIndex);
    const warningTextSlice = normalizedHtml.slice(sectionIndex, sectionIndex + 600);
    const warningText = trimMultilineText(stripHtmlTags(warningTextSlice))
      .match(/This section needs to be updated\.[\s\S]*?(?:\([^)]+\))?/i)?.[0];

    return {
      scope: 'section',
      sectionName: extractLastWikipediaHeadingFromHtml(htmlBeforeWarning) || undefined,
      warningText: trimMultilineText(warningText ?? sectionMarker),
    };
  }

  const warningTextSlice = normalizedHtml.slice(articleIndex, articleIndex + 600);
  const warningText = trimMultilineText(stripHtmlTags(warningTextSlice))
    .match(/This article needs to be updated\.[\s\S]*?(?:\([^)]+\))?/i)?.[0];

  return {
    scope: 'article',
    warningText: trimMultilineText(warningText ?? articleMarker),
  };
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
    sentimentRows: Array.isArray(candidate.sentimentRows)
      ? candidate.sentimentRows
          .filter(
            (
              entry,
            ): entry is {
              item: string;
              title?: unknown;
              sov: string;
              sentiment: string;
              timesCited?: unknown;
            } =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              !Array.isArray(entry) &&
              typeof (entry as { item?: unknown }).item === 'string' &&
              typeof (entry as { sov?: unknown }).sov === 'string' &&
              typeof (entry as { sentiment?: unknown }).sentiment === 'string',
          )
          .map((entry) => {
            const title =
              typeof entry.title === 'string' ? entry.title.trim() : '';
            const timesCited =
              typeof entry.timesCited === 'number' && Number.isFinite(entry.timesCited)
                ? entry.timesCited
                : undefined;
            return {
              item: entry.item.trim(),
              ...(title ? { title } : {}),
              sov: entry.sov.trim(),
              sentiment: entry.sentiment.trim(),
              ...(typeof timesCited === 'number' ? { timesCited } : {}),
            };
          })
      : [],
  };
}

function extractUrlCandidatesFromText(value: string) {
  const trimTrailingUrlPunctuation = (input: string) => {
    let nextValue = input.trim();

    while (nextValue) {
      const trailingCharacter = nextValue.charAt(nextValue.length - 1);

      if (trailingCharacter && /[.,!?;:'"]/u.test(trailingCharacter)) {
        nextValue = nextValue.slice(0, -1);
        continue;
      }

      if (trailingCharacter === ')') {
        const openCount = (nextValue.match(/\(/g) ?? []).length;
        const closeCount = (nextValue.match(/\)/g) ?? []).length;

        if (closeCount > openCount) {
          nextValue = nextValue.slice(0, -1);
          continue;
        }
      }

      if (trailingCharacter === ']') {
        const openCount = (nextValue.match(/\[/g) ?? []).length;
        const closeCount = (nextValue.match(/\]/g) ?? []).length;

        if (closeCount > openCount) {
          nextValue = nextValue.slice(0, -1);
          continue;
        }
      }

      break;
    }

    return nextValue;
  };

  return Array.from(
    new Set(
      Array.from(
        value.matchAll(
          /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi,
        ),
      )
        .map((match) =>
          normalizeAbsoluteUrl(trimTrailingUrlPunctuation(match[0] ?? '')),
        )
        .filter(Boolean),
    ),
  );
}

function normalizeSentimentBucket(value: string) {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue.includes('favorable')) {
    return 'Favorable';
  }

  if (normalizedValue.includes('unfavorable')) {
    return 'Unfavorable';
  }

  if (normalizedValue.includes('neutral')) {
    return 'Neutral';
  }

  if (normalizedValue.includes('no brand')) {
    return 'No brand mentions';
  }

  if (normalizedValue.includes('review')) {
    return 'Needs Review';
  }

  return 'Unknown';
}

function buildSentimentRowSummary(rows: SuggestionEvaluationRequest['sentimentRows']) {
  const buckets = rows.reduce<
    Map<
      string,
      {
        urlCount: number;
        totalTimesCited: number;
        knownTimesCitedCount: number;
      }
    >
  >((summary, row) => {
    const sentimentBucket = normalizeSentimentBucket(row.sentiment);
    const currentValue = summary.get(sentimentBucket) ?? {
      urlCount: 0,
      totalTimesCited: 0,
      knownTimesCitedCount: 0,
    };

    currentValue.urlCount += 1;

    if (typeof row.timesCited === 'number' && Number.isFinite(row.timesCited)) {
      currentValue.totalTimesCited += row.timesCited;
      currentValue.knownTimesCitedCount += 1;
    }

    summary.set(sentimentBucket, currentValue);
    return summary;
  }, new Map());

  return Array.from(buckets.entries()).map(([sentimentBucket, bucket]) => {
    const citationSuffix =
      bucket.knownTimesCitedCount > 0
        ? `, ${bucket.totalTimesCited} citations (times cited)`
        : '';

    return `${sentimentBucket}: ${bucket.urlCount} URL${bucket.urlCount === 1 ? '' : 's'}${citationSuffix}`;
  });
}

function buildLocalSuggestionContext(payload: SuggestionEvaluationRequest) {
  const isWikipedia = payload.opportunityType === 'Wikipedia';
  const evidenceItemLines = payload.evidenceItems
    .slice(0, isWikipedia ? 40 : 60)
    .map((item, index) => `Evidence item ${index + 1}: ${item}`);
  const summaryLines = buildSentimentRowSummary(payload.sentimentRows).map(
    (line) => `Summary: ${line}`,
  );
  const rowLines = payload.sentimentRows
    .slice(0, isWikipedia ? 8 : 40)
    .map((row, index) => {
      const parts = [`Row ${index + 1}`];
      if (row.item) parts.push(`URL=${row.item}`);
      if (row.title) parts.push(`Title=${row.title}`);
      if (row.sov) parts.push(`Extracted SOV=${row.sov}`);
      if (row.sentiment) parts.push(`Extracted Sentiment=${row.sentiment}`);
      if (typeof row.timesCited === 'number') {
        parts.push(`Times Cited=${row.timesCited}`);
      }
      return parts.join(' | ');
    });
  const sourceHints = extractUrlCandidatesFromText(payload.suggestionText)
    .slice(0, 8)
    .map((url) => `Mentioned source: ${url}`);

  return trimMultilineText(
    [...evidenceItemLines, ...summaryLines, ...sourceHints, ...rowLines].join('\n'),
  );
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

async function buildYoutubeSourceEvidenceFromBrightData(
  itemUrl: string,
  firstResult: Record<string, unknown>,
  env: ServerEnv,
): Promise<SourceEvidence> {
  const title = trimMultilineText(String(firstResult.title ?? ''));
  const description = trimMultilineText(String(firstResult.description ?? ''));
  const transcript = trimMultilineText(
    String(firstResult.formatted_transcript ?? firstResult.transcript ?? ''),
  );
  const channelName = trimMultilineText(String(firstResult.youtuber ?? ''));
  const channelUrl = trimMultilineText(String(firstResult.channel_url ?? ''));
  let comments: string[] = [];

  try {
    comments = await fetchBrightDataYoutubeCommentTexts(itemUrl, env);
  } catch {
    comments = [];
  }

  const evidenceText = clampEvidenceText(
    trimMultilineText(
      [
        title ? `Title: ${title}` : '',
        description ? `Description: ${description}` : '',
        channelName ? `Channel: ${channelName}` : '',
        channelUrl ? `Channel URL: ${channelUrl}` : '',
        transcript ? `Transcript:\n${transcript}` : '',
        comments.length > 0 ? `Comments:\n${comments.join('\n')}` : '',
      ].join('\n\n'),
    ),
  );
  const usedTranscript = transcript.length >= MIN_EVIDENCE_CHARACTERS;

  return {
    sourceType: 'youtube',
    sourceUrl: itemUrl,
    usedTranscript,
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
      comments[0] ||
      'Bright Data YouTube evidence could not be extracted.',
  };
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

  return buildYoutubeSourceEvidenceFromBrightData(itemUrl, firstResult, env);
}

async function fetchBrightDataYoutubeEvidenceAsync(
  itemUrl: string,
  env: ServerEnv,
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
            env.BRIGHTDATA_YOUTUBE_TRANSCRIPTION_LANGUAGE?.trim() || 'en',
        },
      ]),
    },
  );

  if (!triggerResponse.ok) {
    const errorText = await triggerResponse.text();
    throw new Error(
      errorText ||
        `Bright Data YouTube async trigger failed with ${triggerResponse.status}`,
    );
  }

  const triggerPayload = (await triggerResponse.json()) as { snapshot_id?: string };
  const snapshotId = triggerPayload.snapshot_id;

  if (!snapshotId) {
    throw new Error('Bright Data YouTube async trigger returned no snapshot_id.');
  }

  const parsedTimeout = Number.parseInt(
    env.BRIGHTDATA_YOUTUBE_ASYNC_TIMEOUT_MS?.trim() ?? '',
    10,
  );
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 45000;
  const pollIntervalMs = 4000;
  const deadlineMs = Date.now() + timeoutMs;

  let firstResult: Record<string, unknown> | undefined;

  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const progressResponse = await fetch(
      `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );

    if (!progressResponse.ok) {
      throw new Error(
        `Bright Data YouTube progress check failed with ${progressResponse.status}`,
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
          `Bright Data YouTube snapshot download failed with ${snapshotResponse.status}`,
        );
      }

      const snapshot = (await snapshotResponse.json()) as unknown;
      firstResult = Array.isArray(snapshot)
        ? (snapshot[0] as Record<string, unknown> | undefined)
        : (snapshot as Record<string, unknown> | undefined);
      break;
    }

    if (progress.status === 'failed') {
      throw new Error('Bright Data YouTube async crawl failed.');
    }
  }

  if (!firstResult || typeof firstResult !== 'object') {
    throw new Error('Bright Data YouTube async crawl timed out.');
  }

  return buildYoutubeSourceEvidenceFromBrightData(itemUrl, firstResult, env);
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

function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractWikipediaTitleFromUrl(value: string) {
  try {
    const normalizedValue = normalizeAbsoluteUrl(value);

    if (!normalizedValue) {
      return '';
    }

    const parsedUrl = new URL(normalizedValue);

    if (!parsedUrl.hostname.includes('wikipedia.org')) {
      return '';
    }

    return normalizeWikipediaTitle(parsedUrl.pathname.replace(/^\/wiki\//i, ''));
  } catch {
    return '';
  }
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

function computeWikipediaTitleAcronymScore(
  normalizedTitle: string,
  normalizedSearchTerm: string,
) {
  if (
    !normalizedSearchTerm ||
    normalizedSearchTerm.length < 2 ||
    normalizedSearchTerm.length > 5 ||
    normalizedSearchTerm.includes(' ')
  ) {
    return 0;
  }

  const titleTokens = normalizedTitle.split(' ').filter(Boolean);

  if (titleTokens.length < 2) {
    return 0;
  }

  const initials = titleTokens
    .map((token) => token[0])
    .filter(Boolean)
    .join('');

  return initials === normalizedSearchTerm ? 6 : 0;
}

function scoreWikipediaTitle(
  title: string,
  site: string,
  extraSearchTerms: string[] = [],
) {
  const normalizedTitle = normalizeComparableText(title);
  const searchTerms = [...buildWikipediaSearchTerms(site), ...extraSearchTerms];
  let score = 0;

  for (const searchTerm of searchTerms) {
    const normalizedSearchTerm = normalizeComparableText(searchTerm);

    if (!normalizedSearchTerm) {
      continue;
    }

    if (normalizedTitle === normalizedSearchTerm) {
      score += 8;
      continue;
    }

    if (normalizedTitle.includes(normalizedSearchTerm)) {
      score += 5;
      continue;
    }

    const normalizedSearchTokens = normalizedSearchTerm.split(' ').filter(Boolean);

    if (
      normalizedSearchTokens.length > 1 &&
      normalizedSearchTokens.every((token) => normalizedTitle.includes(token))
    ) {
      score += 3;
      continue;
    }

    const acronymScore = computeWikipediaTitleAcronymScore(
      normalizedTitle,
      normalizedSearchTerm,
    );

    if (acronymScore > 0) {
      score += acronymScore;
    }
  }

  return score;
}

function extractWikipediaTitleFromEvidenceItem(item: string, prefix: RegExp) {
  const directUrl = item.replace(prefix, '').trim();

  if (directUrl) {
    const directTitle = extractWikipediaTitleFromUrl(directUrl);

    if (directTitle) {
      return normalizeWikipediaTitle(directTitle);
    }
  }

  const fallbackTitle = extractWikipediaTitleFromUrl(item);

  if (fallbackTitle) {
    return normalizeWikipediaTitle(fallbackTitle);
  }

  for (const candidateUrl of extractUrlCandidatesFromText(item)) {
    const urlTitle = extractWikipediaTitleFromUrl(candidateUrl);

    if (urlTitle) {
      return normalizeWikipediaTitle(urlTitle);
    }
  }

  return '';
}

function extractWikipediaCompanyNameFromEvidence(evidenceItems: string[]) {
  for (const item of evidenceItems) {
    if (/^Wikipedia company:/i.test(item)) {
      const value = item.replace(/^Wikipedia company:\s*/i, '').trim();
      if (value) {
        return value;
      }
    }
  }
  return '';
}

function detectWikipediaPrimaryTitleMismatch(payload: SuggestionEvaluationRequest) {
  const primaryTitles: string[] = [];

  for (const item of payload.evidenceItems) {
    if (!/^Wikipedia URL:/i.test(item)) {
      continue;
    }

    const title = extractWikipediaTitleFromEvidenceItem(
      item,
      /^Wikipedia URL:\s*/i,
    );

    if (title) {
      primaryTitles.push(title);
    }
  }

  if (primaryTitles.length === 0) {
    return false;
  }

  const companyName = extractWikipediaCompanyNameFromEvidence(payload.evidenceItems);
  const extraSearchTerms = companyName ? [companyName] : [];

  return primaryTitles.every(
    (title) => scoreWikipediaTitle(title, payload.site, extraSearchTerms) === 0,
  );
}

function collectWikipediaTitlesFromPayload(payload: SuggestionEvaluationRequest) {
  const orderedTitles: string[] = [];
  const seenTitles = new Set<string>();
  const appendTitle = (title?: string) => {
    const normalizedTitle = normalizeWikipediaTitle(title ?? '');

    if (!normalizedTitle || seenTitles.has(normalizedTitle)) {
      return;
    }

    seenTitles.add(normalizedTitle);
    orderedTitles.push(normalizedTitle);
  };
  const appendTitlesFromSource = (source?: string) => {
    if (!source) {
      return;
    }

    appendTitle(extractWikipediaTitleFromUrl(source));

    for (const candidateUrl of extractUrlCandidatesFromText(source)) {
      appendTitle(extractWikipediaTitleFromUrl(candidateUrl));
    }
  };

  payload.evidenceItems
    .filter((item) => /^Wikipedia URL:/i.test(item))
    .forEach((item) => {
      const directUrl = item.replace(/^Wikipedia URL:\s*/i, '').trim();
      const directTitle = directUrl
        ? extractWikipediaTitleFromUrl(directUrl)
        : '';

      if (directTitle) {
        appendTitle(directTitle);
      } else {
        appendTitlesFromSource(item);
      }
    });

  payload.evidenceItems
    .filter((item) => /^Wikipedia competitor:/i.test(item))
    .forEach(appendTitlesFromSource);

  [
    payload.suggestionUrl ?? '',
    payload.suggestionText,
    ...payload.evidenceItems,
    ...payload.sentimentRows.map((row) => row.item),
  ].forEach(appendTitlesFromSource);

  return orderedTitles;
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
    let liveCategoryCount: number | undefined;
    let liveSectionCount: number | undefined;
    let liveContentSectionCount: number | undefined;
    let liveImageCount: number | undefined;

    if (!page || page.missing || !extract) {
      return {
        sourceType: 'web',
        sourceUrl,
        usedTranscript: false,
        transcriptStatus: 'not_applicable',
        status: 'insufficient_evidence',
        evidenceText: '',
        fallbackSnippet: `Wikipedia page "${title}" could not be loaded.`,
        maintenanceScope: 'unknown',
      };
    }

    let maintenanceContext: WikipediaMaintenanceContext = {
      scope: 'unknown',
    };

    try {
      const rawHtml = await fetchText(sourceUrl);
      maintenanceContext = extractWikipediaMaintenanceContextFromHtml(rawHtml);
    } catch {
      // Keep the article extract even if the live page probe fails.
    }

    let wikidataQid: string | undefined;
    try {
      const categoriesAndImagesPayload = await fetchText(
        `https://en.wikipedia.org/w/api.php?action=query&prop=categories|images|pageprops&redirects=1&cllimit=max&imlimit=max&clshow=!hidden&titles=${encodeURIComponent(
          title,
        )}&format=json`,
      );
      const parsedCategoriesAndImagesPayload = JSON.parse(categoriesAndImagesPayload) as {
        query?: {
          pages?: Record<
            string,
            {
              categories?: unknown[];
              images?: unknown[];
              pageprops?: { wikibase_item?: string };
            }
          >;
        };
      };
      const mediaWikiPage = Object.values(
        parsedCategoriesAndImagesPayload.query?.pages ?? {},
      )[0];
      if (Array.isArray(mediaWikiPage?.categories)) {
        liveCategoryCount = mediaWikiPage.categories.length;
      }
      if (Array.isArray(mediaWikiPage?.images)) {
        // The MediaWiki `prop=images` API returns EVERY File: link on the page,
        // including template/icon SVGs (Commons-logo, Increase/Decrease arrows,
        // category icons, sister-project logos, etc.) that aren't visible
        // content to a reader. We filter those out so the count matches what
        // a human would visually count on the article page.
        const contentImages = mediaWikiPage.images
          .map((img) => {
            if (img && typeof img === 'object' && 'title' in img) {
              const title = (img as { title?: unknown }).title;
              return typeof title === 'string' ? title : '';
            }
            return '';
          })
          .filter((title) => title && !isWikipediaTemplateImage(title));
        liveImageCount = contentImages.length;
      }
      const candidateQid = mediaWikiPage?.pageprops?.wikibase_item;
      if (typeof candidateQid === 'string' && /^Q\d+$/.test(candidateQid)) {
        wikidataQid = candidateQid;
      }
    } catch {
      // Keep the extract even if structured metric fetch fails.
    }

    // Fetch Wikidata entity stats so the LLM can verify claims like
    // "Wikidata entry has only N statements" or "Wikidata ID Q12345".
    // Without this, such claims always fall through to "Needs Review".
    let wikidataPropertyCount: number | undefined;
    let wikidataStatementCount: number | undefined;
    let wikidataSitelinkCount: number | undefined;
    let wikidataLabelCount: number | undefined;
    if (wikidataQid) {
      try {
        const wikidataPayload = await fetchText(
          `https://www.wikidata.org/wiki/Special:EntityData/${wikidataQid}.json`,
        );
        const parsedWikidata = JSON.parse(wikidataPayload) as {
          entities?: Record<
            string,
            {
              claims?: Record<string, unknown[]>;
              sitelinks?: Record<string, unknown>;
              labels?: Record<string, unknown>;
            }
          >;
        };
        const entity = parsedWikidata.entities?.[wikidataQid];
        if (entity) {
          if (entity.claims && typeof entity.claims === 'object') {
            const claimGroups = Object.values(entity.claims).filter((value) =>
              Array.isArray(value),
            ) as unknown[][];
            wikidataPropertyCount = claimGroups.length;
            wikidataStatementCount = claimGroups.reduce(
              (sum, group) => sum + group.length,
              0,
            );
          }
          if (entity.sitelinks && typeof entity.sitelinks === 'object') {
            wikidataSitelinkCount = Object.keys(entity.sitelinks).length;
          }
          if (entity.labels && typeof entity.labels === 'object') {
            wikidataLabelCount = Object.keys(entity.labels).length;
          }
        }
      } catch {
        // Wikidata fetch is best-effort — keep going even if it fails.
      }
    }

    try {
      const sectionsPayload = await fetchText(
        `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(
          title,
        )}&prop=sections&format=json`,
      );
      const parsedSectionsPayload = JSON.parse(sectionsPayload) as {
        parse?: {
          sections?: Array<{
            toclevel?: string | number;
            level?: string | number;
            line?: string;
          }>;
        };
      };
      const sections = parsedSectionsPayload.parse?.sections ?? [];
      const topLevelSections = sections.filter((section) => {
        const tocLevel = Number(section.toclevel ?? '');
        const level = Number(section.level ?? '');
        return tocLevel === 1 || level === 2;
      });
      if (topLevelSections.length > 0) {
        liveSectionCount = topLevelSections.length;
      } else if (sections.length > 0) {
        liveSectionCount = sections.length;
      }

      // Backend section counts typically reflect ONLY the prose/content
      // sections, not Wikipedia's standard appendix sections (References,
      // External links, Further reading, Notes, See also, Bibliography, etc.).
      // Compute a separate content-section count so the LLM can compare like
      // for like — otherwise an article with 6 content + 4 appendix sections
      // gets flagged Incorrect against a backend claim of "6 sections".
      const contentSections = topLevelSections.filter(
        (section) => !isWikipediaAppendixSection(section.line ?? ''),
      );
      if (contentSections.length > 0) {
        liveContentSectionCount = contentSections.length;
      }
    } catch {
      // Keep the extract even if structured metric fetch fails.
    }

    const liveWordCount = extract.split(/\s+/).filter(Boolean).length;

    const evidenceText = clampEvidenceText(
      trimMultilineText(
        [
          `Wikipedia title: ${title}`,
          typeof liveCategoryCount === 'number'
            ? `Live category count: ${liveCategoryCount}`
            : '',
          typeof liveSectionCount === 'number'
            ? `Live top-level section count: ${liveSectionCount}`
            : '',
          typeof liveContentSectionCount === 'number'
            ? `Live content section count (excluding References, External links, Further reading, Notes, See also, etc.): ${liveContentSectionCount}`
            : '',
          typeof liveImageCount === 'number'
            ? `Live image count (brand-relevant content images; excludes stub icons, sister-project logos, ambox/trend arrows, and other template chrome): ${liveImageCount}`
            : '',
          liveWordCount > 0 ? `Live word count: ${liveWordCount}` : '',
          wikidataQid ? `Wikidata QID: ${wikidataQid}` : '',
          typeof wikidataPropertyCount === 'number'
            ? `Wikidata distinct property count: ${wikidataPropertyCount}`
            : '',
          typeof wikidataStatementCount === 'number'
            ? `Wikidata total statement count: ${wikidataStatementCount}`
            : '',
          typeof wikidataSitelinkCount === 'number'
            ? `Wikidata sitelink count: ${wikidataSitelinkCount}`
            : '',
          typeof wikidataLabelCount === 'number'
            ? `Wikidata label language count: ${wikidataLabelCount}`
            : '',
          maintenanceContext.scope === 'section'
            ? `Maintenance warning scope: section-level`
            : maintenanceContext.scope === 'article'
              ? `Maintenance warning scope: article-level`
              : '',
          maintenanceContext.sectionName
            ? `Maintenance warning section: ${maintenanceContext.sectionName}`
            : '',
          maintenanceContext.warningText
            ? `Maintenance warning text: ${maintenanceContext.warningText}`
            : '',
          `Extract:\n${extract}`,
        ].join('\n\n'),
      ),
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
      maintenanceScope: maintenanceContext.scope,
      maintenanceSection: maintenanceContext.sectionName,
      maintenanceWarningText: maintenanceContext.warningText,
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
      maintenanceScope: 'unknown',
    };
  }
}

async function buildYoutubeEvidenceFromHtml(
  itemUrl: string,
  html: string,
  transcriptFetcher?: (url: string) => Promise<string>,
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
}

async function fetchYoutubeEvidence(
  itemUrl: string,
  env: ServerEnv,
): Promise<SourceEvidence> {
  if (getBrightDataApiKey(env)) {
    const asyncFallbackEnabled =
      (env.BRIGHTDATA_YOUTUBE_ASYNC_FALLBACK ?? '').trim().toLowerCase() === 'true';

    try {
      const syncEvidence = await fetchBrightDataYoutubeEvidence(itemUrl, env);

      if (
        asyncFallbackEnabled &&
        syncEvidence.transcriptStatus !== 'available_and_used' &&
        syncEvidence.transcriptStatus !== 'available_but_not_used'
      ) {
        try {
          const asyncEvidence = await fetchBrightDataYoutubeEvidenceAsync(itemUrl, env);
          return asyncEvidence.evidenceText.length > syncEvidence.evidenceText.length
            ? asyncEvidence
            : syncEvidence;
        } catch {
          return syncEvidence;
        }
      }

      return syncEvidence;
    } catch {
      if (asyncFallbackEnabled) {
        try {
          return await fetchBrightDataYoutubeEvidenceAsync(itemUrl, env);
        } catch {
          // Fall through to direct fetch if both Bright Data paths failed.
        }
      }
      // Fall through to HTML-based fallbacks if Bright Data datasets were unavailable.
    }
  }

  if (getBrightDataApiKey(env)) {
    try {
      const unlockerHtml = await fetchBrightDataUnlockerBody(itemUrl, env, 'raw');
      const unlockerEvidence = await buildYoutubeEvidenceFromHtml(
        itemUrl,
        unlockerHtml,
        (url) => fetchBrightDataUnlockerBody(url, env, 'raw'),
      );

      if (unlockerEvidence.evidenceText.length >= MIN_EVIDENCE_CHARACTERS) {
        return unlockerEvidence;
      }
    } catch {
      // Fall through to direct fetch.
    }
  }

  try {
    const html = await fetchText(itemUrl);
    return await buildYoutubeEvidenceFromHtml(itemUrl, html);
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
  env: ServerEnv,
): Promise<SuggestionEvidenceBundle> {
  if (payload.opportunityType === 'Wikipedia') {
    const wikipediaTitles = new Set<string>(collectWikipediaTitlesFromPayload(payload));

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
              .slice(0, MAX_WIKIPEDIA_SOURCE_COUNT)
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
      wikipediaTitleMismatch: detectWikipediaPrimaryTitleMismatch(payload),
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

  const suggestionTextUrls = extractUrlCandidatesFromText(payload.suggestionText);
  const candidateUrls = Array.from(
    new Set(
      (
        payload.opportunityType === 'Cited URLs'
          ? [
              ...payload.evidenceItems.map(normalizeAbsoluteUrl),
              ...payload.sentimentRows.map((row) => normalizeAbsoluteUrl(row.item)),
              ...suggestionTextUrls,
              payload.suggestionUrl ? normalizeAbsoluteUrl(payload.suggestionUrl) : '',
            ]
          : [
              payload.suggestionUrl ? normalizeAbsoluteUrl(payload.suggestionUrl) : '',
              ...payload.evidenceItems.map(normalizeAbsoluteUrl),
              ...payload.sentimentRows.map((row) => normalizeAbsoluteUrl(row.item)),
              ...suggestionTextUrls,
            ]
      ).filter(Boolean),
    ),
  ).slice(0, payload.opportunityType === 'Cited URLs' ? 5 : 3);

  if (candidateUrls.length === 0) {
    candidateUrls.push(normalizeAbsoluteUrl(payload.site));
  }

  const sources = await Promise.all(
    candidateUrls.map((url) => {
      if (payload.opportunityType === 'YouTube') {
        return fetchYoutubeEvidence(url, env);
      }

      if (payload.opportunityType === 'Reddit') {
        return fetchRedditEvidence(url, env);
      }

      return fetchWebEvidence(url, env);
    }),
  );

  const evidenceSections = sources
    .filter((source) => source.evidenceText)
    .map((source, index) => {
      const metadataParts: string[] = [`status=${source.status}`];
      if (source.transcriptStatus && source.transcriptStatus !== 'not_applicable') {
        metadataParts.push(`transcript=${source.transcriptStatus}`);
      }
      if (source.usedComments) {
        metadataParts.push('comments=included');
      }
      metadataParts.push(`evidence_chars=${source.evidenceText.length}`);
      return `Source ${index + 1} (${source.sourceType} | ${source.sourceUrl}) [${metadataParts.join(', ')}]:\n${source.evidenceText}`;
    });
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

  if (input.llmResult.verdict === 'Incorrect') {
    confidenceScore = 100 - confidenceScore;
  }

  return clampConfidenceScore(confidenceScore);
}

function buildSuggestionPrompt(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
) {
  const localSuggestionContext = buildLocalSuggestionContext(payload);

  return [
    'You are a quality engineer auditing suggestions generated from a backend analytics payload.',
    'Your job is to spot-check the backend: verify that the suggestion\'s claims match reality (fetched live pages and extracted rows), and flag genuine errors or hallucinations. Do not rubber-stamp backend aggregates — they can be wrong, stale, or miscounted.',
    'Be proportionate: tolerate small measurement differences that reflect counting conventions or natural drift, and reserve "Incorrect" for meaningful factual errors. When the central claim of a suggestion is broadly supported, prefer "Correct" even if a peripheral statistic is slightly off.',
    'Tolerance bands (differences WITHIN these are acceptable and should NOT flag the suggestion as Incorrect):',
    '  - Percentages and shares: ±2 percentage points (±0.5pp if a precise decimal is quoted).',
    '  - Counts of ANY magnitude (sections, images, categories, infobox fields, citations, references, word counts, etc.): ±10% of the larger value, OR ±1 absolute — whichever is LARGER. This means small numbers require small deltas (3 vs 5 is 40% off — FLAG it) while large numbers tolerate proportional drift (298 vs 300 is ~0.7% off — ACCEPT).',
    '  - Dates: same calendar day. Recency claims like "edits in last 30 days" within ±1 edit.',
    '  - Ranks: exact when the competitor set is knowable; otherwise treat rank as directionally correct if the ordering is consistent with the numeric evidence.',
    'Worked examples (settle the verdict using the formula — do NOT reproduce the arithmetic in your rationale):',
    '  - Backend says 1 image, live page shows 2. Tolerance=1 (max of 1 and 10% of 2). Delta=1, within → Correct.',
    '  - Backend says 3 sections, live page shows 5. Tolerance=1. Delta=2, exceeds → Incorrect.',
    '  - Backend says 6 images, live page shows 12. Tolerance≈1.2. Delta=6, exceeds → Incorrect.',
    '  - Backend says 298 references, live page shows 300. Tolerance=30. Delta=2, within → Correct.',
    '  - Backend says 46 citations, live page shows 48. Tolerance≈4.8. Delta=2, within → Correct.',
    'RATIONALE FORMAT (strict):',
    '  - Decide the verdict FIRST using the tolerance formula, then write the rationale.',
    '  - Rationale must be 1-3 sentences. State: live value, claim value, tolerance, delta, conclusion. Nothing else.',
    '  - Example shape: "Live page shows 2 images; the suggestion claims 1. Tolerance is ±1, delta is 1 — within tolerance, so the claim is correct."',
    '  - Do NOT show the arithmetic chain (no "10% of 2 = 0.2, max(1, 0.2) = 1, ..."), do NOT say "wait", "let me re-read", "actually", or "I\'ll mark this as", do NOT self-correct mid-paragraph. Settle the call before writing.',
    '  - The conclusion stated in your rationale MUST match the verdict field. If you wrote "within tolerance, so correct", the verdict field must be "Correct". A mismatch is the worst possible output.',
    'When a live fetched page contradicts a backend aggregate BEYOND tolerance, mark Incorrect and return a correctedSuggestion using the live value.',
    'When the suggestion\'s central claim is correct but a sub-claim cannot be verified from the evidence available (e.g., only one competitor page was fetched so a "N of M competitors" claim can\'t be fully recomputed), state that limitation in the rationale but still mark Correct with MEDIUM or HIGH confidence if the central claim itself is verified. Do not downgrade solely because peripheral aggregates were not independently reconstructed.',
    'Wikipedia-specific notes: (a) For section count claims, prefer the "Live content section count" (which already excludes References, External links, Further reading, Notes, See also, Bibliography, etc.) over the "Live top-level section count". Backend section counts almost always reflect content sections only. If the content-section count is unavailable, fall back to top-level count after manually subtracting any appendix sections you can identify. (b) Infobox field lists from the backend are flattened from the article\'s infobox template; when the live page clearly surfaces the same fields (by label or by equivalent prose), count that as verified. (c) For Wikidata claims (e.g., "Wikidata entry has N statements", "Wikidata ID Q12345"), use the "Wikidata QID", "Wikidata distinct property count", and "Wikidata total statement count" lines in the evidence. Backend "statement" counts typically map to the distinct property count (statements grouped by property); if neither distinct nor total matches within tolerance, the claim is Incorrect. (d) For Wikipedia IMAGE-count claims, the "Live image count" already excludes template chrome (stub-message icons like the Ben Franklin US-business-stub, sister-project logos, ambox decorations, trend arrows). Compare the backend\'s claim against this filtered number — do NOT add or imagine additional stub/chrome images into the count.',
    'Wikipedia opportunities do not have extracted Sentiment & SOV rows. For Wikipedia, use the current payload evidence items and fetched Wikipedia pages as the local source of truth.',
    'Distinguish article-level maintenance warnings from section-level warnings. If the evidence says "This section needs to be updated", do not describe the whole article as outdated. Name the affected section when the evidence provides it.',
    'For Cited URLs suggestions, use the local extracted Sentiment & SOV rows to verify which third-party URLs are part of the extracted opportunity context.',
    'For count-based claims, use the local extracted rows and their Times Cited values as the source of truth for URL counts and citation totals.',
    'Do not mark a suggestion incorrect just because fetched third-party pages do not expose citation totals; citation counts may come from the originating extracted dataset.',
    'Use fetched third-party pages primarily to verify whether those sources do or do not mention the target brand and whether the recommendation is directionally justified.',
    'For Reddit / YouTube / Cited URLs opportunities the local context contains:',
    '  (a) sentiment/SOV rows for the opportunity sources, each with URL, Title, Extracted SOV, Extracted Sentiment, and Times Cited — the Title is the single most reliable topical signal (e.g., a thread titled "Manulife RRSP" plainly concerns Manulife retirement plans even if the post body was not fetched);',
    '  (b) topic-level evidence items of the form `<Type> topic: <Topic title> | sentiment=... | <Brand> mentions=N`, plus `<Type> topic "X" analysis: <narrative>` and `<Type> topic "X" threads: <list of titles+URLs>`. These topic aggregates are derived from the whole opportunity dataset, not just the fetched pages, and they cover sources whose bodies may not appear in the fetched evidence.',
    'When a suggestion claims a topical area exists (e.g., favorable stock/dividend discussion, ETF comparison threads, employer retirement plan conversations), FIRST check the opportunity sources\' Titles and the topic evidence items for that theme. If a matching Title or topic exists in the opportunity context, the suggestion is grounded — mark Correct with MEDIUM or HIGH confidence, and cite the matching Title(s) in evidenceSnippet. Do not mark the suggestion hallucinated just because the fetched page bodies (limited to a few top-cited URLs) do not discuss that theme.',
    'Only mark a Reddit/YouTube/Cited URLs suggestion Incorrect when the opportunity context (sources + topics + fetched pages) together contradict the claim or offer no supporting thread title, topic, or analysis.',
    '',
    'About the fetched-evidence metadata header on each source (e.g., [status=success, transcript=not_available, evidence_chars=240]):',
    '  - This tells you what the fetch layer actually returned. A YouTube video with transcript=not_available means the video has no captions OR the captions were not captured; the fetched body is then limited to title + description + channel + comments.',
    '  - A thin fetched body for YouTube is common and expected (Shorts, no-caption videos, music videos). Do NOT treat a thin transcript as proof that the suggestion is ungrounded.',
    '  - `evidenceSufficient` reflects overall grounding (fetched body + local opportunity context + structured evidence items together), NOT fetched-body length. Set evidenceSufficient = true if the combined inputs — video title/description + opportunity topic context + relevant source titles — support judging the suggestion\'s central claim. Reserve evidenceSufficient = false for the case where ALL inputs are too sparse to judge in any direction.',
    '  - When you mark evidenceSufficient = false, state in your rationale exactly which inputs you looked at and why each was insufficient (e.g., "No matching topic, no fetched transcript, thin description, no relevant source titles").',
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
    'Local extracted opportunity context:',
    localSuggestionContext || 'None',
    '',
    'Fetched source evidence:',
    evidence.combinedEvidenceText,
  ].join('\n');
}

function collectWikipediaMaintenanceContext(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
): WikipediaMaintenanceContext {
  const sourceContext = evidence.sources.find(
    (source) => source.maintenanceScope && source.maintenanceScope !== 'unknown',
  );

  if (sourceContext) {
    return {
      scope: sourceContext.maintenanceScope ?? 'unknown',
      sectionName: sourceContext.maintenanceSection,
      warningText: sourceContext.maintenanceWarningText,
    };
  }

  const payloadContext: WikipediaMaintenanceContext = {
    scope: 'unknown',
  };

  for (const item of payload.evidenceItems) {
    if (/^Wikipedia maintenance scope:/i.test(item)) {
      const value = item.split(':').slice(1).join(':').trim().toLowerCase();
      payloadContext.scope =
        value === 'section-level'
          ? 'section'
          : value === 'article-level'
            ? 'article'
            : 'unknown';
      continue;
    }

    if (/^Wikipedia maintenance section:/i.test(item)) {
      payloadContext.sectionName = item.split(':').slice(1).join(':').trim();
      continue;
    }

    if (/^Wikipedia maintenance /i.test(item)) {
      const warningText = item.split(':').slice(1).join(':').trim();
      payloadContext.warningText = warningText || payloadContext.warningText;

      if (/^This section needs to be updated/i.test(warningText)) {
        payloadContext.scope = 'section';
      } else if (/^This article needs to be updated/i.test(warningText)) {
        payloadContext.scope = 'article';
      }
    }
  }

  return payloadContext;
}

function buildSectionSpecificWikipediaSuggestion(
  originalSuggestion: string,
  maintenanceContext: WikipediaMaintenanceContext,
) {
  const sectionLabel = maintenanceContext.sectionName
    ? `${maintenanceContext.sectionName} section`
    : 'affected section';
  const rewrittenSuggestion = originalSuggestion
    .replace(
      /Wikipedia has flagged this article as containing outdated information/gi,
      `Wikipedia has flagged the ${sectionLabel} as containing outdated information`,
    )
    .replace(/\bthis article\b/gi, `the ${sectionLabel}`)
    .replace(
      /Review all sections, especially those related to recent events, company developments, or product launches/gi,
      `Review the ${sectionLabel}, especially any material related to recent events, company developments, or product launches`,
    );

  if (rewrittenSuggestion !== originalSuggestion) {
    return rewrittenSuggestion;
  }

  return trimMultilineText(
    [
      `Wikipedia has flagged the ${sectionLabel} as containing outdated information.`,
      'Review that section, especially the material related to recent events, company developments, or product launches, and update it with current, verifiable information from independent sources.',
    ].join(' '),
  );
}

function applyWikipediaMaintenanceOverride(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
  llmResult: LlmSuggestionEvaluation,
): LlmSuggestionEvaluation {
  if (payload.opportunityType !== 'Wikipedia') {
    return llmResult;
  }

  const maintenanceContext = collectWikipediaMaintenanceContext(payload, evidence);
  const broadArticleClaim =
    /\bthis article\b/i.test(payload.suggestionText) &&
    /\boutdated|update/i.test(payload.suggestionText);

  if (maintenanceContext.scope !== 'section' || !broadArticleClaim) {
    return llmResult;
  }

  const sectionLabel = maintenanceContext.sectionName
    ? `${maintenanceContext.sectionName} section`
    : 'affected section';
  const warningText =
    maintenanceContext.warningText ?? 'This section needs to be updated.';

  return {
    ...llmResult,
    verdict: 'Incorrect',
    evidenceSufficient: true,
    confidence: maintenanceContext.sectionName ? 'high' : 'medium',
    rationale: trimMultilineText(
      [
        `The suggestion overstates the maintenance issue. Wikipedia's warning applies to the ${sectionLabel}, not the entire article.`,
        `The underlying warning text is: ${warningText}`,
      ].join(' '),
    ),
    evidenceSnippet: trimMultilineText(
      `Maintenance warning applies to the ${sectionLabel}: ${warningText}`,
    ),
    correctedSuggestion: buildSectionSpecificWikipediaSuggestion(
      payload.suggestionText,
      maintenanceContext,
    ),
  };
}

function applyWikipediaTitleMismatchOverride(
  evidence: SuggestionEvidenceBundle,
  llmResult: LlmSuggestionEvaluation,
): LlmSuggestionEvaluation {
  if (!evidence.wikipediaTitleMismatch) {
    return llmResult;
  }

  const sourceUrls = evidence.sources
    .map((source) => source.sourceUrl)
    .filter(Boolean);
  const sourceLabel =
    sourceUrls.length > 0 ? sourceUrls.join(', ') : 'the provided Wikipedia URL';

  return {
    ...llmResult,
    verdict: 'Needs Review',
    confidence: 'low',
    rationale: trimMultilineText(
      [
        `The Wikipedia page referenced in the payload (${sourceLabel}) does not appear to match the target site.`,
        'The evaluation may be based on the wrong article.',
        llmResult.rationale,
      ].join(' '),
    ),
    evidenceSnippet: trimMultilineText(
      [
        `Wikipedia title mismatch: the evaluated page (${sourceLabel}) may not be the correct article for this site.`,
        llmResult.evidenceSnippet,
      ].join(' '),
    ),
  };
}

function collectWikipediaQualityStatusContext(
  payload: SuggestionEvaluationRequest,
): WikipediaQualityStatusContext {
  const context: WikipediaQualityStatusContext = {};

  for (const item of payload.evidenceItems) {
    if (/^Wikipedia has Good Article status:/i.test(item)) {
      const value = item.split(':').slice(1).join(':').trim().toLowerCase();
      context.hasGoodArticle = value === 'true';
      continue;
    }

    if (/^Wikipedia has Featured Article status:/i.test(item)) {
      const value = item.split(':').slice(1).join(':').trim().toLowerCase();
      context.hasFeaturedArticle = value === 'true';
    }
  }

  return context;
}

function collectWikipediaDeterministicContext(
  payload: SuggestionEvaluationRequest,
): WikipediaDeterministicContext {
  const citationsRank = parseRankFromEvidenceItem(
    payload.evidenceItems,
    'Wikipedia citations rank',
  );
  const sectionsRank = parseRankFromEvidenceItem(
    payload.evidenceItems,
    'Wikipedia sections rank',
  );
  const imagesRank = parseRankFromEvidenceItem(
    payload.evidenceItems,
    'Wikipedia images rank',
  );
  const categoriesRank = parseRankFromEvidenceItem(
    payload.evidenceItems,
    'Wikipedia categories rank',
  );

  return {
    citationCount: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia citation count',
    ),
    avgCitations: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia industry average citations',
    ),
    citationsRank: citationsRank?.rank,
    citationsRankOf: citationsRank?.of,
    secondPlaceCitations: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia second place citations',
    ),
    citationsLeadOverSecondPlace: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia citations lead over second place',
    ),
    citationsLeadAboveAverage: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia citations lead above average',
    ),
    sectionCount: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia section count',
    ),
    avgSections: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia industry average sections',
    ),
    sectionsRank: sectionsRank?.rank,
    sectionsRankOf: sectionsRank?.of,
    imageCount: parseNumberFromEvidenceItem(payload.evidenceItems, 'Wikipedia image count'),
    avgImages: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia industry average images',
    ),
    imagesRank: imagesRank?.rank,
    imagesRankOf: imagesRank?.of,
    secondPlaceImages: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia second place images',
    ),
    imagesLeadOverSecondPlace: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia images lead over second place',
    ),
    categoryCount: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia category count',
    ),
    avgCategories: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia industry average categories',
    ),
    categoriesRank: categoriesRank?.rank,
    categoriesRankOf: categoriesRank?.of,
    categoriesComparison: parseStringFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia categories comparison',
    ),
    hasInfobox: parseBooleanFromEvidenceItem(payload.evidenceItems, 'Wikipedia has infobox'),
    hasNavbox: parseBooleanFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia has navigation box',
    ),
    hasSeeAlso: parseBooleanFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia has See also section',
    ),
    hasExternalLinks: parseBooleanFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia has External links section',
    ),
    competitorsAnalyzed: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia competitors analyzed',
    ),
    competitorsWithInfobox: parseCompetitorPrevalenceFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia competitors with infobox',
    ),
    competitorsWithNavigationBox: parseCompetitorPrevalenceFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia competitors with navigation box',
    ),
    competitorsWithSeeAlso: parseCompetitorPrevalenceFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia competitors with See also section',
    ),
    competitorsWithExternalLinks: parseCompetitorPrevalenceFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia competitors with External links section',
    ),
    infoboxFieldCount: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia infobox field count',
    ),
    infoboxFields: parseListFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia infobox fields',
    ),
    commonCompetitorInfoboxFields: parseListFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia common competitor infobox fields',
    ),
    missingCommonInfoboxFields: parseListFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia missing common infobox fields',
    ),
    lastEdited: parseStringFromEvidenceItem(payload.evidenceItems, 'Wikipedia last edited'),
    editCount30Days: parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia edits in last 30 days',
    ),
    hasGoodArticle: parseBooleanFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia has Good Article status',
    ),
    hasFeaturedArticle: parseBooleanFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia has Featured Article status',
    ),
  };
}

function parseNumberFromSourceEvidenceText(
  evidenceText: string,
  label: string,
): number | undefined {
  const line = evidenceText
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${label}:`));

  if (!line) {
    return undefined;
  }

  const rawValue = line.split(':').slice(1).join(':').trim();
  const parsedValue = Number.parseFloat(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function collectWikipediaFetchedMetricEntries(
  evidence: SuggestionEvidenceBundle,
): WikipediaFetchedMetricEntry[] {
  return evidence.sources
    .filter((source) => source.sourceUrl.includes('wikipedia.org'))
    .map((source) => {
      const titleLine = source.evidenceText
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith('Wikipedia title:'));
      const title = titleLine?.split(':').slice(1).join(':').trim() || undefined;

      return {
        title,
        sourceUrl: source.sourceUrl,
        categoryCount: parseNumberFromSourceEvidenceText(
          source.evidenceText,
          'Live category count',
        ),
        sectionCount: parseNumberFromSourceEvidenceText(
          source.evidenceText,
          'Live top-level section count',
        ),
        imageCount: parseNumberFromSourceEvidenceText(
          source.evidenceText,
          'Live image count',
        ),
        wordCount: parseNumberFromSourceEvidenceText(
          source.evidenceText,
          'Live word count',
        ),
      };
    });
}

function collectWikipediaFetchedCategoryComparison(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
): WikipediaFetchedCategoryComparison | null {
  const mainWikipediaTitle = extractWikipediaTitleFromUrl(
    parseStringFromEvidenceItem(payload.evidenceItems, 'Wikipedia URL') ?? '',
  );
  const fetchedEntries = collectWikipediaFetchedMetricEntries(evidence)
    .filter(
      (entry): entry is WikipediaFetchedMetricEntry & { title: string; categoryCount: number } =>
        typeof entry.title === 'string' && typeof entry.categoryCount === 'number',
    );

  if (fetchedEntries.length === 0) {
    return null;
  }

  const mainEntry =
    fetchedEntries.find(
      (entry) =>
        mainWikipediaTitle &&
        normalizeWikipediaTitle(entry.title) === normalizeWikipediaTitle(mainWikipediaTitle),
    ) ?? fetchedEntries[0];
  const rankedEntries = [...fetchedEntries].sort(
    (leftEntry, rightEntry) => rightEntry.categoryCount - leftEntry.categoryCount,
  );
  const distinctHigherValues = new Set(
    rankedEntries
      .filter((entry) => entry.categoryCount > mainEntry.categoryCount)
      .map((entry) => entry.categoryCount),
  );
  const average =
    rankedEntries.reduce((sum, entry) => sum + entry.categoryCount, 0) / rankedEntries.length;

  return {
    categoryCount: mainEntry.categoryCount,
    avgCategories: average,
    categoriesRank: distinctHigherValues.size + 1,
    categoriesRankOf: rankedEntries.length,
    categoriesComparison: rankedEntries
      .map((entry) => `${entry.title}=${entry.categoryCount}`)
      .join(', '),
    leaderName: rankedEntries[0]?.title,
    leaderCount: rankedEntries[0]?.categoryCount,
  };
}

function extractSuggestionIdToken(value?: string) {
  return (value ?? '').trim().toUpperCase();
}

function buildDeterministicSuggestionResult(input: {
  verdict: SuggestionEvaluationVerdict;
  confidence: LlmSuggestionEvaluation['confidence'];
  rationale: string;
  evidenceSnippet: string;
  correctedSuggestion?: string;
}): LlmSuggestionEvaluation {
  return {
    targetBrand: '',
    verdict: input.verdict,
    evidenceSufficient: input.verdict !== 'Needs Review',
    confidence: input.confidence,
    rationale: trimMultilineText(input.rationale),
    evidenceSnippet: trimMultilineText(input.evidenceSnippet),
    correctedSuggestion: trimMultilineText(input.correctedSuggestion ?? ''),
  };
}

function buildStructuredAssessmentRationale(input: {
  correctPoints?: string[];
  inaccuratePoints?: string[];
  finalDecision: string;
}) {
  const sections: string[] = [];

  if (input.correctPoints && input.correctPoints.length > 0) {
    sections.push(
      ['What\'s correct:', ...input.correctPoints.map((point) => `- ${point}`)].join('\n'),
    );
  }

  if (input.inaccuratePoints && input.inaccuratePoints.length > 0) {
    sections.push(
      [
        "What's inaccurate or unsupported:",
        ...input.inaccuratePoints.map((point) => `- ${point}`),
      ].join('\n'),
    );
  }

  sections.push(['Final decision:', `- ${input.finalDecision}`].join('\n'));

  return sections.join('\n\n');
}

function collectSuggestionSourceMismatchEvidenceItems(
  payload: SuggestionEvaluationRequest,
) {
  return payload.evidenceItems.filter(
    (item) =>
      /^Suggestion source mismatch:/i.test(item) ||
      /^Embedded opportunity payload suggestion text:/i.test(item) ||
      /^Suggestions endpoint suggestion text:/i.test(item) ||
      /^Embedded opportunity payload suggestion URL:/i.test(item) ||
      /^Suggestions endpoint suggestion URL:/i.test(item),
  );
}

function appendSuggestionSourceMismatchEvidence(
  payload: SuggestionEvaluationRequest,
  result: SuggestionEvaluationResult,
): SuggestionEvaluationResult {
  const mismatchEvidenceItems = collectSuggestionSourceMismatchEvidenceItems(payload);

  if (mismatchEvidenceItems.length === 0) {
    return result;
  }

  const mismatchSummary =
    mismatchEvidenceItems.find((item) => /^Suggestion source mismatch:/i.test(item)) ??
    'Suggestion source mismatch: Embedded opportunity payload and /suggestions endpoint disagree.';

  return {
    ...result,
    rationale: trimMultilineText([result.rationale, mismatchSummary].join(' ')),
    evidenceSnippet: trimMultilineText(
      [result.evidenceSnippet, ...mismatchEvidenceItems].filter(Boolean).join('\n'),
    ),
  };
}

function applyWikipediaQualityStatusOverride(
  payload: SuggestionEvaluationRequest,
  llmResult: LlmSuggestionEvaluation,
): LlmSuggestionEvaluation {
  if (payload.opportunityType !== 'Wikipedia') {
    return llmResult;
  }

  const qualityStatusContext = collectWikipediaQualityStatusContext(payload);

  if (
    typeof qualityStatusContext.hasGoodArticle !== 'boolean' ||
    typeof qualityStatusContext.hasFeaturedArticle !== 'boolean'
  ) {
    return llmResult;
  }

  const articleLacksQualityStatus =
    qualityStatusContext.hasGoodArticle === false &&
    qualityStatusContext.hasFeaturedArticle === false;
  const suggestionClaimsNoQualityStatus =
    /does not currently have featured article or good article status/i.test(
      payload.suggestionText,
    ) ||
    /consider working toward these quality ratings/i.test(payload.suggestionText);

  if (!articleLacksQualityStatus || !suggestionClaimsNoQualityStatus) {
    return llmResult;
  }

  return {
    ...llmResult,
    verdict: 'Correct',
    evidenceSufficient: true,
    confidence: 'high',
    rationale: trimMultilineText(
      'The suggestion is grounded in the Wikipedia analysis payload. The article does not have Featured Article or Good Article status, so the recommendation is factually supported.',
    ),
    evidenceSnippet:
      'Wikipedia has Featured Article status: false; Wikipedia has Good Article status: false',
    correctedSuggestion: '',
  };
}

function extractSuggestionMetric(
  suggestionText: string,
  pattern: RegExp,
): number | undefined {
  const match = suggestionText.match(pattern);

  if (!match?.[1]) {
    return undefined;
  }

  const parsedValue = Number.parseFloat(match[1]);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function matchesRoundedMetric(actualValue?: number, expectedValue?: number) {
  if (typeof actualValue !== 'number' || typeof expectedValue !== 'number') {
    return false;
  }

  return Math.abs(actualValue - expectedValue) < 0.15;
}

function evaluateWikipediaSuggestionDeterministically(
  payload: SuggestionEvaluationRequest,
  evidence: SuggestionEvidenceBundle,
): LlmSuggestionEvaluation | null {
  if (payload.opportunityType !== 'Wikipedia') {
    return null;
  }

  const suggestionId = extractSuggestionIdToken(payload.suggestionId);
  const context = collectWikipediaDeterministicContext(payload);
  const maintenanceContext = collectWikipediaMaintenanceContext(payload, evidence);
  const suggestionText = payload.suggestionText;

  if (suggestionId === 'ARTICLE_MAINTENANCE_OUTDATED') {
    if (maintenanceContext.scope === 'section') {
      return buildDeterministicSuggestionResult({
        verdict: 'Incorrect',
        confidence: maintenanceContext.sectionName ? 'high' : 'medium',
        rationale: `The suggestion overstates the maintenance issue. Wikipedia's warning applies to the ${maintenanceContext.sectionName ?? 'affected section'}, not the entire article.`,
        evidenceSnippet: `Maintenance warning applies to the ${maintenanceContext.sectionName ?? 'affected section'}: ${maintenanceContext.warningText ?? 'This section needs to be updated.'}`,
      });
    }

    if (maintenanceContext.scope === 'article') {
      return buildDeterministicSuggestionResult({
        verdict: 'Correct',
        confidence: 'high',
        rationale:
          "The suggestion is grounded. Wikipedia's maintenance warning applies to the article itself.",
        evidenceSnippet:
          maintenanceContext.warningText ??
          'Wikipedia article-level maintenance warning is present.',
      });
    }

    return buildDeterministicSuggestionResult({
      verdict: 'Needs Review',
      confidence: 'low',
      rationale:
        'The maintenance warning could not be scoped confidently from the current page evidence.',
      evidenceSnippet:
        maintenanceContext.warningText ?? 'No maintenance warning was confirmed on the live page.',
    });
  }

  if (suggestionId === 'ARTICLE_QUALITY_STATUS') {
    if (
      context.hasGoodArticle === false &&
      context.hasFeaturedArticle === false
    ) {
      return buildDeterministicSuggestionResult({
        verdict: 'Correct',
        confidence: 'high',
        rationale:
          'The suggestion matches the Wikipedia analysis payload. The article does not have Featured Article or Good Article status.',
        evidenceSnippet:
          'Wikipedia has Featured Article status: false; Wikipedia has Good Article status: false',
      });
    }

    if (
      context.hasGoodArticle === true ||
      context.hasFeaturedArticle === true
    ) {
      return buildDeterministicSuggestionResult({
        verdict: 'Incorrect',
        confidence: 'high',
        rationale:
          'The suggestion is contradicted by the Wikipedia analysis payload, which indicates the article already has an elevated quality status.',
        evidenceSnippet: `Wikipedia has Featured Article status: ${context.hasFeaturedArticle}; Wikipedia has Good Article status: ${context.hasGoodArticle}`,
      });
    }

    return null;
  }

  if (suggestionId === 'REFERENCES_LEADER') {
    const references = extractSuggestionMetric(suggestionText, /(\d+(?:\.\d+)?)\s+references/i);
    const rankMatch = suggestionText.match(/#(\d+)\s+of\s+(\d+)/i);
    const leadOverSecond = extractSuggestionMetric(
      suggestionText,
      /(\d+(?:\.\d+)?)\s+references ahead of the second-place company/i,
    );
    const average = extractSuggestionMetric(
      suggestionText,
      /industry average:\s*(\d+(?:\.\d+)?)\s+references/i,
    );
    const leadAboveAverage = extractSuggestionMetric(
      suggestionText,
      /your lead:\s*(\d+(?:\.\d+)?)\s+references above average/i,
    );
    const isMatch =
      matchesRoundedMetric(references, context.citationCount) &&
      (rankMatch
        ? Number.parseInt(rankMatch[1], 10) === context.citationsRank &&
          Number.parseInt(rankMatch[2], 10) === context.citationsRankOf
        : true) &&
      matchesRoundedMetric(leadOverSecond, context.citationsLeadOverSecondPlace) &&
      matchesRoundedMetric(average, context.avgCitations) &&
      matchesRoundedMetric(leadAboveAverage, context.citationsLeadAboveAverage);

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The reference leadership claim matches the structured Wikipedia analysis metrics for citation count, rank, gap to second place, and lead above average.'
        : 'The reference leadership claim does not match the structured Wikipedia analysis metrics for citations, ranking, or the reported gap.',
      evidenceSnippet: `Wikipedia citation count: ${context.citationCount}; Wikipedia citations rank: #${context.citationsRank} of ${context.citationsRankOf}; Wikipedia citations lead over second place: ${context.citationsLeadOverSecondPlace}; Wikipedia industry average citations: ${context.avgCitations}`,
    });
  }

  if (suggestionId === 'SECTIONS_LEADER') {
    const sections = extractSuggestionMetric(suggestionText, /(\d+(?:\.\d+)?)\s+sections/i);
    const rankMatch = suggestionText.match(/#(\d+)\s+of\s+(\d+)/i);
    const average = extractSuggestionMetric(
      suggestionText,
      /industry average:\s*(\d+(?:\.\d+)?)\s+sections/i,
    );
    const isMatch =
      matchesRoundedMetric(sections, context.sectionCount) &&
      (rankMatch
        ? Number.parseInt(rankMatch[1], 10) === context.sectionsRank &&
          Number.parseInt(rankMatch[2], 10) === context.sectionsRankOf
        : true) &&
      matchesRoundedMetric(average, context.avgSections);

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The sections leadership claim matches the structured Wikipedia analysis metrics for section count, ranking, and industry average.'
        : 'The sections leadership claim does not match the structured Wikipedia analysis metrics.',
      evidenceSnippet: `Wikipedia section count: ${context.sectionCount}; Wikipedia sections rank: #${context.sectionsRank} of ${context.sectionsRankOf}; Wikipedia industry average sections: ${context.avgSections}`,
    });
  }

  if (suggestionId === 'IMAGES_LEADER') {
    const images = extractSuggestionMetric(suggestionText, /(\d+(?:\.\d+)?)\s+images/i);
    const rankMatch = suggestionText.match(/#(\d+)\s+of\s+(\d+)/i);
    const leadOverSecond = extractSuggestionMetric(
      suggestionText,
      /(\d+(?:\.\d+)?)\s+images ahead of the second-place company/i,
    );
    const average = extractSuggestionMetric(
      suggestionText,
      /industry average:\s*(\d+(?:\.\d+)?)\s+images/i,
    );
    const isMatch =
      matchesRoundedMetric(images, context.imageCount) &&
      (rankMatch
        ? Number.parseInt(rankMatch[1], 10) === context.imagesRank &&
          Number.parseInt(rankMatch[2], 10) === context.imagesRankOf
        : true) &&
      matchesRoundedMetric(leadOverSecond, context.imagesLeadOverSecondPlace) &&
      matchesRoundedMetric(average, context.avgImages);

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The image leadership claim matches the structured Wikipedia analysis metrics for image count, ranking, and gap to second place.'
        : 'The image leadership claim does not match the structured Wikipedia analysis metrics.',
      evidenceSnippet: `Wikipedia image count: ${context.imageCount}; Wikipedia images rank: #${context.imagesRank} of ${context.imagesRankOf}; Wikipedia images lead over second place: ${context.imagesLeadOverSecondPlace}; Wikipedia industry average images: ${context.avgImages}`,
    });
  }

  if (suggestionId === 'CATEGORIES_ABOVE_AVERAGE') {
    const categories = extractSuggestionMetric(suggestionText, /(\d+(?:\.\d+)?)\s+categories/i);
    const rankMatch = suggestionText.match(/rank\s*#(\d+)\s+out of\s+(\d+)/i);
    const average = extractSuggestionMetric(
      suggestionText,
      /industry average of\s*(\d+(?:\.\d+)?)/i,
    );
    const claimsAboveAverage = /above average/i.test(suggestionText);
    const fetchedCategoryComparison = collectWikipediaFetchedCategoryComparison(
      payload,
      evidence,
    );
    const isBelowAverage =
      typeof context.categoryCount === 'number' &&
      typeof context.avgCategories === 'number' &&
      context.categoryCount < context.avgCategories;
    const payloadAndLiveAgree =
      fetchedCategoryComparison
        ? matchesRoundedMetric(
            fetchedCategoryComparison.categoryCount,
            context.categoryCount,
          ) &&
          matchesRoundedMetric(
            fetchedCategoryComparison.avgCategories,
            context.avgCategories,
          ) &&
          (typeof context.categoriesRank === 'number' &&
          typeof fetchedCategoryComparison.categoriesRank === 'number'
            ? context.categoriesRank === fetchedCategoryComparison.categoriesRank
            : true)
        : true;
    const numericMatch =
      matchesRoundedMetric(categories, context.categoryCount) &&
      (rankMatch
        ? Number.parseInt(rankMatch[1], 10) === context.categoriesRank &&
          Number.parseInt(rankMatch[2], 10) === context.categoriesRankOf
        : true) &&
      matchesRoundedMetric(average, context.avgCategories);
    const isMatch =
      numericMatch && !(claimsAboveAverage && isBelowAverage) && payloadAndLiveAgree;
    const expectedRank =
      typeof context.categoriesRank === 'number' &&
      typeof context.categoriesRankOf === 'number'
        ? `#${context.categoriesRank} of ${context.categoriesRankOf}`
        : 'unknown';
    const reportedRank = rankMatch ? `#${rankMatch[1]} of ${rankMatch[2]}` : 'not stated';
    const categoryLeadersMatch = suggestionText.match(
      /\*\*Industry Leader:\*\*\s*([^.]+)/i,
    );
    const categoryLeaders = categoryLeadersMatch?.[1]?.trim() || '';

    return buildDeterministicSuggestionResult({
      verdict: payloadAndLiveAgree ? (isMatch ? 'Correct' : 'Incorrect') : 'Needs Review',
      confidence: payloadAndLiveAgree ? 'high' : 'medium',
      rationale: isMatch
        ? 'The category suggestion aligns with the structured Wikipedia analysis metrics.'
        : trimMultilineText(
            [
              payloadAndLiveAgree
                ? 'The category suggestion conflicts with the structured Wikipedia analysis metrics.'
                : 'The category suggestion conflicts with the current payload metrics, and the live competitor-page fetches do not cleanly corroborate the same comparison snapshot.',
              typeof context.categoryCount === 'number' &&
              typeof context.avgCategories === 'number'
                ? `The article has ${context.categoryCount} categories while the industry average is ${context.avgCategories}, so it is below average rather than above average.`
                : '',
              rankMatch &&
              typeof context.categoriesRank === 'number' &&
              typeof context.categoriesRankOf === 'number' &&
              reportedRank !== expectedRank
                ? `The suggestion says the article ranks ${reportedRank}, but the payload ranks it ${expectedRank}.`
                : '',
              categoryLeaders && context.categoriesComparison
                ? `The industry-leader wording was checked against the comparison set: ${context.categoriesComparison}.`
                : '',
              fetchedCategoryComparison?.categoriesComparison
                ? `The live Wikipedia fetch comparison was: ${fetchedCategoryComparison.categoriesComparison}.`
                : '',
            ].join(' '),
          ),
      evidenceSnippet: trimMultilineText(
        [
          `Wikipedia category count: ${context.categoryCount}`,
          `Wikipedia categories rank: ${expectedRank}`,
          `Wikipedia industry average categories: ${context.avgCategories}`,
          context.categoriesComparison
            ? `Wikipedia categories comparison: ${context.categoriesComparison}`
            : '',
          fetchedCategoryComparison?.categoriesComparison
            ? `Live fetched categories comparison: ${fetchedCategoryComparison.categoriesComparison}`
            : '',
        ].filter(Boolean).join('; '),
      ),
    });
  }

  if (suggestionId === 'EXTERNAL_LINKS_ABOVE_AVERAGE') {
    const percentage = extractSuggestionMetric(
      suggestionText,
      /(\d+(?:\.\d+)?)%\s+of your competitors also have this section/i,
    );
    const isMatch =
      context.hasExternalLinks === true &&
      matchesRoundedMetric(
        percentage,
        context.competitorsWithExternalLinks?.percentage,
      );

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The suggestion matches the payload evidence: the article has an External links section and the competitor prevalence matches.'
        : 'The suggestion does not match the payload evidence for the External links section or competitor prevalence.',
      evidenceSnippet: `Wikipedia has External links section: ${context.hasExternalLinks}; Wikipedia competitors with External links section: ${context.competitorsWithExternalLinks?.count} of ${context.competitorsWithExternalLinks?.total} (${context.competitorsWithExternalLinks?.percentage}%)`,
    });
  }

  if (suggestionId === 'NAVBOX_ABOVE_AVERAGE') {
    const percentage = extractSuggestionMetric(
      suggestionText,
      /(\d+(?:\.\d+)?)%\s+of your competitors also have navigation boxes/i,
    );
    const isMatch =
      context.hasNavbox === true &&
      matchesRoundedMetric(
        percentage,
        context.competitorsWithNavigationBox?.percentage,
      );

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The suggestion matches the payload evidence: the article has a navigation box and the competitor prevalence matches.'
        : 'The suggestion does not match the payload evidence for navigation box presence or competitor prevalence.',
      evidenceSnippet: `Wikipedia has navigation box: ${context.hasNavbox}; Wikipedia competitors with navigation box: ${context.competitorsWithNavigationBox?.count} of ${context.competitorsWithNavigationBox?.total} (${context.competitorsWithNavigationBox?.percentage}%)`,
    });
  }

  if (suggestionId === 'SEE_ALSO_MISSING') {
    const isMatch =
      context.hasSeeAlso === false &&
      context.competitorsWithSeeAlso?.count === context.competitorsWithSeeAlso?.total;

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The suggestion matches the payload evidence: the article is missing a See also section and every competitor analyzed has one.'
        : 'The suggestion does not match the payload evidence for the See also section or competitor prevalence.',
      evidenceSnippet: `Wikipedia has See also section: ${context.hasSeeAlso}; Wikipedia competitors with See also section: ${context.competitorsWithSeeAlso?.count} of ${context.competitorsWithSeeAlso?.total} (${context.competitorsWithSeeAlso?.percentage}%)`,
    });
  }

  if (suggestionId === 'INFOBOX_COMPLETE') {
    const hasInfobox = context.hasInfobox === true;
    const infoboxFields = context.infoboxFields ?? [];
    const commonCompetitorInfoboxFields =
      context.commonCompetitorInfoboxFields ?? [];
    const missingCommonInfoboxFields =
      context.missingCommonInfoboxFields ?? [];
    const hasCompetitorBenchmark =
      commonCompetitorInfoboxFields.length > 0 &&
      typeof context.competitorsAnalyzed === 'number' &&
      context.competitorsAnalyzed > 1;
    const usesAbsoluteCompleteness =
      /\bcomplete infobox\b/i.test(suggestionText) ||
      /no missing fields were identified compared to competitors/i.test(suggestionText);
    const correctPoints: string[] = [];
    const inaccuratePoints: string[] = [];

    if (hasInfobox) {
      correctPoints.push(
        'The structured Wikipedia analysis confirms that the Land Rover page has an infobox.',
      );
    }

    if (infoboxFields.length > 0) {
      correctPoints.push(
        `The current payload lists these infobox fields: ${infoboxFields.join(', ')}.`,
      );
    }

    if (hasCompetitorBenchmark && missingCommonInfoboxFields.length === 0) {
      correctPoints.push(
        'Against the current competitor comparison set, no common competitor infobox fields were flagged as missing.',
      );
    }

    if (!hasInfobox) {
      inaccuratePoints.push(
        'The evidence does not support the suggestion\'s basic premise because infobox presence is not confirmed.',
      );
    }

    if (!hasCompetitorBenchmark) {
      inaccuratePoints.push(
        'The current evidence does not expose a stable competitor-field benchmark, so "complete compared to competitors" cannot be verified confidently.',
      );
    }

    if (missingCommonInfoboxFields.length > 0) {
      inaccuratePoints.push(
        `The comparison set still flags these common competitor fields as missing: ${missingCommonInfoboxFields.join(', ')}.`,
      );
    }

    if (
      hasInfobox &&
      hasCompetitorBenchmark &&
      missingCommonInfoboxFields.length === 0 &&
      usesAbsoluteCompleteness
    ) {
      inaccuratePoints.push(
        'The phrase "complete infobox" is stronger than the evidence alone. The current payload only proves that no common competitor fields were missing in this comparison set, not that the infobox satisfies a universal Wikipedia standard.',
      );
    }

    const evidenceSnippet = trimMultilineText(
      [
        `Wikipedia has infobox: ${context.hasInfobox}`,
        infoboxFields.length > 0
          ? `Wikipedia infobox fields: ${infoboxFields.join(', ')}`
          : '',
        commonCompetitorInfoboxFields.length > 0
          ? `Wikipedia common competitor infobox fields: ${commonCompetitorInfoboxFields.join(', ')}`
          : '',
        `Wikipedia missing common infobox fields: ${
          missingCommonInfoboxFields.length > 0
            ? missingCommonInfoboxFields.join(', ')
            : 'none'
        }`,
      ]
        .filter(Boolean)
        .join('; '),
    );

    if (!hasInfobox) {
      return buildDeterministicSuggestionResult({
        verdict: 'Incorrect',
        confidence: 'high',
        rationale: buildStructuredAssessmentRationale({
          correctPoints,
          inaccuratePoints,
          finalDecision:
            'The suggestion is not supported because the current evidence does not confirm the underlying infobox premise.',
        }),
        evidenceSnippet,
      });
    }

    if (!hasCompetitorBenchmark) {
      return buildDeterministicSuggestionResult({
        verdict: 'Needs Review',
        confidence: 'low',
        rationale: buildStructuredAssessmentRationale({
          correctPoints,
          inaccuratePoints,
          finalDecision:
            'The infobox is present, but the current evidence is too thin to certify the stronger comparative claim.',
        }),
        evidenceSnippet,
      });
    }

    if (missingCommonInfoboxFields.length > 0) {
      return buildDeterministicSuggestionResult({
        verdict: 'Incorrect',
        confidence: 'high',
        rationale: buildStructuredAssessmentRationale({
          correctPoints,
          inaccuratePoints,
          finalDecision:
            'The suggestion is contradicted by the comparison set because common competitor infobox fields are still missing.',
        }),
        evidenceSnippet,
      });
    }

    return buildDeterministicSuggestionResult({
      verdict: usesAbsoluteCompleteness ? 'Needs Review' : 'Correct',
      confidence: usesAbsoluteCompleteness ? 'medium' : 'high',
      rationale: buildStructuredAssessmentRationale({
        correctPoints,
        inaccuratePoints,
        finalDecision: usesAbsoluteCompleteness
          ? 'Mostly supported, but slightly overstated. The infobox is present and covers the current competitor comparison set, yet "complete infobox" is stronger than the evidence proves.'
          : 'Supported. The infobox is present and no common competitor infobox fields were flagged as missing in the current comparison set.',
      }),
      evidenceSnippet,
    });
  }

  if (suggestionId === 'ARTICLE_MAINTENANCE_STALE') {
    const lastEdited = parseStringFromEvidenceItem(payload.evidenceItems, 'Wikipedia last edited');
    const edits = parseNumberFromEvidenceItem(
      payload.evidenceItems,
      'Wikipedia edits in last 30 days',
    );
    const textDate = suggestionText.match(/last edited on ([0-9TZ:\-\.]+)/i)?.[1];
    const textEdits = extractSuggestionMetric(
      suggestionText,
      /with\s+(\d+(?:\.\d+)?)\s+edits?\s+in the last 30 days/i,
    );
    const isMatch =
      (!!textDate ? textDate === lastEdited : true) &&
      matchesRoundedMetric(textEdits, edits);

    return buildDeterministicSuggestionResult({
      verdict: isMatch ? 'Correct' : 'Incorrect',
      confidence: 'high',
      rationale: isMatch
        ? 'The staleness suggestion matches the payload evidence for the latest edit timestamp and recent edit count.'
        : 'The staleness suggestion does not match the payload evidence for the latest edit timestamp or recent edit count.',
      evidenceSnippet: `Wikipedia last edited: ${lastEdited}; Wikipedia edits in last 30 days: ${edits}`,
    });
  }

  return null;
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
  const bedrockApiKey = getBedrockBearerToken(env);
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

  const evidence = await fetchEvidenceForSuggestionRequest(payload, env);
  const deterministicWikipediaResult = evaluateWikipediaSuggestionDeterministically(
    payload,
    evidence,
  );

  if (deterministicWikipediaResult) {
    const adjustedResult = applyWikipediaTitleMismatchOverride(
      evidence,
      deterministicWikipediaResult,
    );

    return appendSuggestionSourceMismatchEvidence(payload, {
      verdict: adjustedResult.verdict,
      confidence: buildSuggestionConfidenceScore({
        llmResult: adjustedResult,
        fetchStatus: 'success',
      }),
      rationale: trimMultilineText(adjustedResult.rationale),
      evidenceSnippet:
        trimMultilineText(adjustedResult.evidenceSnippet) ||
        evidence.fallbackSnippet,
      correctedSuggestion: trimMultilineText(
        adjustedResult.correctedSuggestion,
      ),
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
      targetBrand: adjustedResult.targetBrand,
    });
  }

  if (
    evidence.status === 'fetch_failed' ||
    evidence.status === 'insufficient_evidence'
  ) {
    const weakEvidenceScore = evidence.status === 'fetch_failed' ? 12 : 28;

    return appendSuggestionSourceMismatchEvidence(payload, {
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
    });
  }

  const llmResponse = await fetchSuggestionLlmEvaluation(payload, evidence, env);
  const llmResult = applyWikipediaTitleMismatchOverride(
    evidence,
    applyWikipediaQualityStatusOverride(
      payload,
      applyWikipediaMaintenanceOverride(payload, evidence, llmResponse.evaluation),
    ),
  );

  return appendSuggestionSourceMismatchEvidence(payload, {
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
  });
}

function buildJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

export async function handleOffsiteSuggestionEvaluateRequest(
  request: Request,
  env: ServerEnv = {},
) {
  if (request.method !== 'POST') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const payload = await request.json();
    const result = await runOffsiteSuggestionEvaluation(payload, env);
    return buildJsonResponse(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unexpected suggestion evaluation error.';

    return buildJsonResponse({ error: message }, 500);
  }
}
