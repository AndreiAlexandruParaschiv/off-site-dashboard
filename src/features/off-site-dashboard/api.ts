import {
  buildStatusMessage,
  buildLookupCandidates,
  inferOpportunityType,
  summarizeOpportunityPresence,
  extractSiteId,
  normalizeApiBaseUrl,
  normalizeOpportunityCollection,
  normalizeOpportunityType,
  normalizeSuggestionCollection,
  normalizeSiteInput,
} from './utils';
import {
  DEFAULT_API_BASE_URL,
  EVALUATOR_API_PATH,
  EVALUATOR_CACHE_CLEAR_API_PATH,
  SPACECAT_PROXY_API_PATH,
  SPACECAT_PROXY_CONFIG_API_PATH,
  SUGGESTION_EVALUATOR_API_PATH,
  WIKIPEDIA_URL_EVALUATOR_API_PATH,
} from './constants';
import type {
  CanonicalOpportunityType,
  FetchSiteParams,
  FetchSiteSuccessResult,
  OpportunityRecord,
  SentimentEvaluationRequest,
  SentimentEvaluationResult,
  SpacecatProxyConfig,
  SuggestionRecord,
  SuggestionEvaluationRequest,
  SuggestionEvaluationResult,
  WikipediaUrlEvaluationRequest,
  WikipediaUrlEvaluationResult,
} from './types';

const API_HEADERS = {
  Accept: 'application/json',
};

const SERVER_API_BASE_URL = normalizeServerApiBaseUrl(
  import.meta.env.VITE_SERVER_API_BASE_URL ||
    import.meta.env.VITE_BACKEND_BASE_URL ||
    '',
);

function normalizeServerApiBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function buildInternalApiUrl(path: string) {
  return SERVER_API_BASE_URL ? `${SERVER_API_BASE_URL}${path}` : path;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function readErrorMessage(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as Record<string, unknown>;
      const message = payload.message ?? payload.error ?? payload.detail;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }

    const text = await response.text();
    return text.trim();
  } catch {
    return '';
  }
}

export class SpacecatApiError extends Error {
  status?: number;

  retryAfterSeconds?: number;

  constructor(
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'SpacecatApiError';
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

async function requestJson<T>(
  url: string,
  apiKey: string,
  proxyConfig?: SpacecatProxyConfig,
  attempt = 0,
): Promise<T> {
  try {
    const trimmedApiKey = apiKey.trim();
    const useProxy = proxyConfig?.configured === true;
    const response = await fetch(
      useProxy
        ? `${buildInternalApiUrl(SPACECAT_PROXY_API_PATH)}?target=${encodeURIComponent(url)}`
        : url,
      {
        method: 'GET',
        cache: 'no-store',
        headers: useProxy
          ? {
              ...API_HEADERS,
            }
          : {
              ...API_HEADERS,
              Authorization: `Bearer ${trimmedApiKey}`,
              'x-api-key': trimmedApiKey,
            },
      },
    );

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '2', 10);
      const waitSeconds = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : 2;

      if (attempt < 1) {
        await sleep(waitSeconds * 1000);
        return requestJson<T>(url, apiKey, proxyConfig, attempt + 1);
      }

      throw new SpacecatApiError(
        `Rate limited by SpaceCat API. Retry after about ${waitSeconds} seconds.`,
        {
          status: 429,
          retryAfterSeconds: waitSeconds,
        },
      );
    }

    if (!response.ok) {
      const detail = await readErrorMessage(response);

      if (response.status === 401 || response.status === 403) {
        throw new SpacecatApiError(
          detail || 'API key rejected or missing access to this site or endpoint.',
          { status: response.status },
        );
      }

      if (response.status === 404) {
        throw new SpacecatApiError(detail || 'Requested endpoint was not found.', {
          status: 404,
        });
      }

      throw new SpacecatApiError(
        detail || `SpaceCat API request failed with ${response.status}.`,
        { status: response.status },
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SpacecatApiError) {
      throw error;
    }

    console.error('SpaceCat API request failed.', error);
    throw new SpacecatApiError(
      'Network or CORS error. If the API blocks browser requests, use a server-side proxy.',
    );
  }
}

async function requestLocalJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(buildInternalApiUrl(url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new SpacecatApiError(
      detail || `Evaluator request failed with ${response.status}.`,
      { status: response.status },
    );
  }

  return (await response.json()) as T;
}

function encodeBase64PathValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binaryString = '';
  bytes.forEach((byte) => {
    binaryString += String.fromCharCode(byte);
  });
  return encodeURIComponent(window.btoa(binaryString));
}

function buildApiUrl(baseUrl: string, path: string) {
  return `${normalizeApiBaseUrl(baseUrl)}/${path.replace(/^\/+/, '')}`;
}

function normalizeComparableSuggestionValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildSuggestionLookupKey(
  suggestion: Pick<SuggestionRecord, 'suggestionId' | 'suggestionText'>,
) {
  return (
    suggestion.suggestionId?.trim().toLowerCase() ||
    normalizeComparableSuggestionValue(suggestion.suggestionText)
  );
}

function truncateSuggestionEvidenceValue(value: string, maxLength = 220) {
  const normalizedValue = value.replace(/\s+/g, ' ').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1).trimEnd()}…`;
}

function collectEmbeddedSuggestionEvidenceItems(opportunity: OpportunityRecord) {
  return Array.from(
    new Set(
      opportunity.suggestions.flatMap((suggestion) =>
        (suggestion.evidenceItems ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
  );
}

function buildSuggestionSourceMismatchEvidenceItems(
  embeddedSuggestion: SuggestionRecord | undefined,
  fetchedSuggestion: SuggestionRecord,
) {
  if (!embeddedSuggestion) {
    return [] as string[];
  }

  const embeddedText = embeddedSuggestion.suggestionText.trim();
  const fetchedText = fetchedSuggestion.suggestionText.trim();
  const embeddedUrl = embeddedSuggestion.suggestionUrl?.trim() ?? '';
  const fetchedUrl = fetchedSuggestion.suggestionUrl?.trim() ?? '';
  const textMismatch =
    normalizeComparableSuggestionValue(embeddedText) !==
    normalizeComparableSuggestionValue(fetchedText);
  const urlMismatch =
    Boolean(embeddedUrl || fetchedUrl) &&
    normalizeComparableSuggestionValue(embeddedUrl) !==
      normalizeComparableSuggestionValue(fetchedUrl);

  if (!textMismatch && !urlMismatch) {
    return [] as string[];
  }

  const suggestionLabel =
    fetchedSuggestion.suggestionId?.trim() ||
    embeddedSuggestion.suggestionId?.trim() ||
    truncateSuggestionEvidenceValue(fetchedText || embeddedText, 80);

  const mismatchEvidenceItems = [
    `Suggestion source mismatch: Embedded opportunity payload and /suggestions endpoint disagree for ${suggestionLabel}. Evaluator uses the /suggestions endpoint because it matches the LLMO UI.`,
  ];

  if (textMismatch) {
    mismatchEvidenceItems.push(
      `Embedded opportunity payload suggestion text: ${truncateSuggestionEvidenceValue(
        embeddedText,
      )}`,
    );
    mismatchEvidenceItems.push(
      `Suggestions endpoint suggestion text: ${truncateSuggestionEvidenceValue(
        fetchedText,
      )}`,
    );
  }

  if (urlMismatch) {
    mismatchEvidenceItems.push(
      `Embedded opportunity payload suggestion URL: ${embeddedUrl || 'None'}`,
    );
    mismatchEvidenceItems.push(
      `Suggestions endpoint suggestion URL: ${fetchedUrl || 'None'}`,
    );
  }

  return mismatchEvidenceItems;
}

function mergeFetchedSuggestionsIntoOpportunity(
  opportunity: OpportunityRecord,
  fetchedCollection: ReturnType<typeof normalizeSuggestionCollection>,
) {
  const shouldUseFetchedCollection =
    fetchedCollection.suggestions.length > 0 || fetchedCollection.sentimentItems.length > 0;

  if (!shouldUseFetchedCollection) {
    return opportunity;
  }

  const embeddedEvidenceItems = collectEmbeddedSuggestionEvidenceItems(opportunity);
  const embeddedSuggestionsByKey = new Map(
    opportunity.suggestions.map((suggestion) => [
      buildSuggestionLookupKey(suggestion),
      suggestion,
    ]),
  );

  const mergedSuggestions = fetchedCollection.suggestions.map((suggestion) => {
    const embeddedSuggestion = embeddedSuggestionsByKey.get(
      buildSuggestionLookupKey(suggestion),
    );
    const mismatchEvidenceItems = buildSuggestionSourceMismatchEvidenceItems(
      embeddedSuggestion,
      suggestion,
    );

    return {
      ...suggestion,
      evidenceItems: Array.from(
        new Set([
          ...mismatchEvidenceItems,
          ...(suggestion.evidenceItems ?? []),
          ...embeddedEvidenceItems,
        ]),
      ),
    };
  });

  return {
    ...opportunity,
    suggestions: mergedSuggestions,
    sentimentItems:
      fetchedCollection.sentimentItems.length > 0
        ? fetchedCollection.sentimentItems
        : opportunity.sentimentItems,
  };
}

async function resolveSiteByDirectLookup(
  normalizedApiBaseUrl: string,
  apiKey: string,
  lookupCandidates: string[],
  proxyConfig?: SpacecatProxyConfig,
) {
  for (const candidate of lookupCandidates) {
    const encodedCandidate = encodeBase64PathValue(candidate);
    const lookupUrl = buildApiUrl(
      normalizedApiBaseUrl,
      `sites/by-base-url/${encodedCandidate}`,
    );

    try {
      const lookupResponse = await requestJson<unknown>(
        lookupUrl,
        apiKey,
        proxyConfig,
      );
      const resolvedSite = extractSiteId(lookupResponse, candidate);

      if (resolvedSite) {
        return resolvedSite;
      }
    } catch (error) {
      if (error instanceof SpacecatApiError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  return null;
}

async function resolveSiteByEnumeratingAllSites(
  normalizedApiBaseUrl: string,
  apiKey: string,
  lookupCandidates: string[],
  proxyConfig?: SpacecatProxyConfig,
) {
  try {
    const lookupResponse = await requestJson<unknown>(
      buildApiUrl(normalizedApiBaseUrl, 'sites'),
      apiKey,
      proxyConfig,
    );

    for (const candidate of lookupCandidates) {
      const resolvedSite = extractSiteId(lookupResponse, candidate);
      if (resolvedSite) {
        return resolvedSite;
      }
    }
  } catch (error) {
    if (
      error instanceof SpacecatApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      return null;
    }

    throw error;
  }

  return null;
}

async function fetchSuggestionsForOpportunity(
  normalizedApiBaseUrl: string,
  apiKey: string,
  siteId: string,
  opportunity: OpportunityRecord,
  proxyConfig?: SpacecatProxyConfig,
) {
  const shouldFetchSuggestionEndpoint =
    opportunity.opportunityType === 'Wikipedia' ||
    opportunity.suggestions.length === 0;

  if (!shouldFetchSuggestionEndpoint) {
    return opportunity;
  }

  try {
    const suggestionsUrl = buildApiUrl(
      normalizedApiBaseUrl,
      `sites/${encodeURIComponent(siteId)}/opportunities/${encodeURIComponent(
        opportunity.opportunityId,
      )}/suggestions`,
    );
    const suggestionsPayload = await requestJson<unknown>(
      suggestionsUrl,
      apiKey,
      proxyConfig,
    );
    const normalizedSuggestions = normalizeSuggestionCollection(
      suggestionsPayload,
      opportunity.opportunityType,
    );
    return mergeFetchedSuggestionsIntoOpportunity(opportunity, normalizedSuggestions);
  } catch (error) {
    if (
      error instanceof SpacecatApiError &&
      (error.status === 403 ||
        error.status === 404 ||
        (typeof error.status === 'number' && error.status >= 500))
    ) {
      return opportunity;
    }

    throw error;
  }
}

export async function fetchSiteDashboardData({
  apiBaseUrl,
  apiKey,
  siteInput,
  proxyConfig,
}: FetchSiteParams): Promise<FetchSiteSuccessResult> {
  const normalizedApiBaseUrl = normalizeApiBaseUrl(
    proxyConfig?.configured ? proxyConfig.apiBaseUrl : apiBaseUrl,
  );
  const normalizedSiteInput = normalizeSiteInput(siteInput);
  const lookupCandidates = buildLookupCandidates(normalizedSiteInput);

  if (!normalizedApiBaseUrl) {
    throw new SpacecatApiError('API base URL is required.');
  }

  if (!proxyConfig?.configured && !apiKey.trim()) {
    throw new SpacecatApiError('API key is required.');
  }

  if (lookupCandidates.length === 0) {
    throw new SpacecatApiError('At least one site URL is required.');
  }

  let resolvedSiteId: string | undefined;
  let resolvedSiteUrl: string | undefined;

  const directLookupMatch = await resolveSiteByDirectLookup(
    normalizedApiBaseUrl,
    apiKey,
    lookupCandidates,
    proxyConfig,
  );
  const enumeratedLookupMatch =
    directLookupMatch ??
    (await resolveSiteByEnumeratingAllSites(
      normalizedApiBaseUrl,
      apiKey,
      lookupCandidates,
      proxyConfig,
    ));

  if (enumeratedLookupMatch) {
    resolvedSiteId = enumeratedLookupMatch.siteId;
    resolvedSiteUrl = enumeratedLookupMatch.resolvedSiteUrl;
  }

  if (!resolvedSiteId) {
    throw new SpacecatApiError(
      `No siteId could be resolved for ${normalizedSiteInput}.`,
      { status: 404 },
    );
  }

  const opportunitiesUrl = buildApiUrl(
    normalizedApiBaseUrl,
    `sites/${encodeURIComponent(resolvedSiteId)}/opportunities`,
  );
  const opportunitiesPayload = await requestJson<unknown>(
    opportunitiesUrl,
    apiKey,
    proxyConfig,
  );
  const opportunityPresence = summarizeOpportunityPresence(opportunitiesPayload);
  const normalizedOpportunities = normalizeOpportunityCollection(opportunitiesPayload);
  const opportunities = await Promise.all(
    normalizedOpportunities.map((opportunity) =>
      fetchSuggestionsForOpportunity(
        normalizedApiBaseUrl,
        apiKey,
        resolvedSiteId,
        opportunity,
        proxyConfig,
      ),
    ),
  );

  return {
    requestSite: normalizedSiteInput,
    resolvedSiteUrl: resolvedSiteUrl ?? normalizedSiteInput,
    siteId: resolvedSiteId,
    status: 'success',
    statusMessage: buildStatusMessage(opportunities),
    lastUpdated: new Date().toISOString(),
    opportunityPresence,
    opportunities,
  };
}

export async function evaluateSentimentRow(
  payload: SentimentEvaluationRequest,
): Promise<SentimentEvaluationResult> {
  return requestLocalJson<SentimentEvaluationResult>(EVALUATOR_API_PATH, payload);
}

export async function evaluateSuggestionRow(
  payload: SuggestionEvaluationRequest,
): Promise<SuggestionEvaluationResult> {
  return requestLocalJson<SuggestionEvaluationResult>(
    SUGGESTION_EVALUATOR_API_PATH,
    payload,
  );
}

export async function evaluateWikipediaUrl(
  payload: WikipediaUrlEvaluationRequest,
): Promise<WikipediaUrlEvaluationResult> {
  return requestLocalJson<WikipediaUrlEvaluationResult>(
    WIKIPEDIA_URL_EVALUATOR_API_PATH,
    payload,
  );
}

/**
 * Clear the server-side in-memory evaluator cache (and the brand-profile
 * cache that piggybacks on it). The next evaluation runs end-to-end fresh.
 *
 * Server returns { ok, cleared, brandProfilesCleared, clearedAt }.
 * Note: in Vercel production each warm container has its own cache; this
 * call only clears the instance that handles the request.
 */
export async function clearEvaluatorCache(): Promise<{
  cleared: number;
  brandProfilesCleared: number;
  clearedAt: string;
}> {
  const response = await fetch(buildInternalApiUrl(EVALUATOR_CACHE_CLEAR_API_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new SpacecatApiError(
      detail || `Evaluator cache clear failed with ${response.status}.`,
      { status: response.status },
    );
  }
  return (await response.json()) as {
    cleared: number;
    brandProfilesCleared: number;
    clearedAt: string;
  };
}

// === Suggestions Patcher API ===
//
// The patcher works against the raw SpaceCat suggestion shape (NOT the
// trimmed SuggestionRecord used elsewhere in the dashboard). The raw
// payload preserves every field the server returns so the user can
// edit the full data, copy/paste between suggestions, etc.

export interface RawOpportunitySummary {
  id: string;
  type: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  /**
   * Canonical opportunity classification, computed via the same two-step
   * classifier the Opportunities tab uses (raw type → tag/signal inference
   * fallback). Consumers like the Suggestions Patcher should filter on this
   * field rather than re-running their own classifier so the dashboard
   * stays consistent across surfaces. May be undefined if the opportunity
   * couldn't be classified.
   */
  canonicalType?: CanonicalOpportunityType;
}

export interface RawSuggestion {
  id: string;
  opportunityId: string;
  type: string;
  rank?: number;
  status?: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function fetchSiteOpportunitySummaries(args: {
  apiBaseUrl: string;
  apiKey: string;
  siteId: string;
  proxyConfig?: SpacecatProxyConfig;
}): Promise<RawOpportunitySummary[]> {
  const url = buildApiUrl(
    args.apiBaseUrl,
    `sites/${encodeURIComponent(args.siteId)}/opportunities`,
  );
  const payload = await requestJson<unknown>(url, args.apiKey, args.proxyConfig);
  const items = Array.isArray(payload) ? payload : [];
  return items
    .map((item): RawOpportunitySummary | null => {
      const record = asRecord(item);
      const id = asString(record.id);
      const type = asString(record.type);
      if (!id || !type) return null;
      // Two-step classifier — same path the Opportunities tab uses. Step 1
      // matches on the raw `type` string. Step 2 falls back to scanning
      // tags/labels/keywords for cases like an opportunity whose type is
      // unrecognized but tags include "TopCitedUrls".
      const canonicalType =
        ((normalizeOpportunityType(type) ?? inferOpportunityType(record)) as
          | CanonicalOpportunityType
          | null) ?? undefined;
      return {
        id,
        type,
        title: asString(record.title),
        status: asString(record.status),
        updatedAt: asString(record.updatedAt),
        canonicalType,
      };
    })
    .filter((entry): entry is RawOpportunitySummary => entry !== null);
}

export async function fetchOpportunitySuggestionsRaw(args: {
  apiBaseUrl: string;
  apiKey: string;
  siteId: string;
  opportunityId: string;
  proxyConfig?: SpacecatProxyConfig;
}): Promise<RawSuggestion[]> {
  const url = buildApiUrl(
    args.apiBaseUrl,
    `sites/${encodeURIComponent(args.siteId)}/opportunities/${encodeURIComponent(
      args.opportunityId,
    )}/suggestions`,
  );
  const payload = await requestJson<unknown>(url, args.apiKey, args.proxyConfig);
  const items = Array.isArray(payload) ? payload : [];
  return items
    .map((item): RawSuggestion | null => {
      const record = asRecord(item);
      const id = asString(record.id);
      const type = asString(record.type);
      const opportunityId = asString(record.opportunityId);
      if (!id || !type || !opportunityId) return null;
      return {
        id,
        opportunityId,
        type,
        rank: asNumber(record.rank),
        status: asString(record.status),
        data: asRecord(record.data),
        createdAt: asString(record.createdAt),
        updatedAt: asString(record.updatedAt),
        updatedBy: asString(record.updatedBy),
      };
    })
    .filter((entry): entry is RawSuggestion => entry !== null);
}

/**
 * PATCH a single suggestion's `data` payload. The body shape matches the
 * SpaceCat API's expected partial-update format: { data: { ...partial } }.
 * Returns the server's response payload (typically the updated suggestion).
 */
export async function patchSuggestion(args: {
  apiBaseUrl: string;
  apiKey: string;
  siteId: string;
  opportunityId: string;
  suggestionId: string;
  partialData: Record<string, unknown>;
  proxyConfig?: SpacecatProxyConfig;
}): Promise<RawSuggestion> {
  const url = buildApiUrl(
    args.apiBaseUrl,
    `sites/${encodeURIComponent(args.siteId)}/opportunities/${encodeURIComponent(
      args.opportunityId,
    )}/suggestions/${encodeURIComponent(args.suggestionId)}`,
  );
  const useProxy = args.proxyConfig?.configured === true;
  const requestUrl = useProxy
    ? `${buildInternalApiUrl(SPACECAT_PROXY_API_PATH)}?target=${encodeURIComponent(url)}`
    : url;
  const trimmedApiKey = args.apiKey.trim();

  const response = await fetch(requestUrl, {
    method: 'PATCH',
    cache: 'no-store',
    headers: useProxy
      ? {
          ...API_HEADERS,
          'content-type': 'application/json',
        }
      : {
          ...API_HEADERS,
          'content-type': 'application/json',
          Authorization: `Bearer ${trimmedApiKey}`,
          'x-api-key': trimmedApiKey,
        },
    body: JSON.stringify({ data: args.partialData }),
  });

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new SpacecatApiError(
      detail || `Failed to patch suggestion (HTTP ${response.status}).`,
      { status: response.status },
    );
  }

  const result = (await response.json()) as RawSuggestion;
  return result;
}

export async function fetchSpacecatProxyConfig(): Promise<SpacecatProxyConfig> {
  try {
    const response = await fetch(buildInternalApiUrl(SPACECAT_PROXY_CONFIG_API_PATH), {
      method: 'GET',
      cache: 'no-store',
      headers: API_HEADERS,
    });

    if (!response.ok) {
      return {
        configured: false,
        apiBaseUrl: DEFAULT_API_BASE_URL,
      };
    }

    const payload = (await response.json()) as Partial<SpacecatProxyConfig>;
    return {
      configured: payload.configured === true,
      apiBaseUrl:
        typeof payload.apiBaseUrl === 'string' && payload.apiBaseUrl.trim()
          ? payload.apiBaseUrl.trim()
          : DEFAULT_API_BASE_URL,
    };
  } catch {
    return {
      configured: false,
      apiBaseUrl: DEFAULT_API_BASE_URL,
    };
  }
}
