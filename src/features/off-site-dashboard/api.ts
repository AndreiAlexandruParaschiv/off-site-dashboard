import {
  buildStatusMessage,
  buildLookupCandidates,
  summarizeOpportunityPresence,
  extractSiteId,
  normalizeApiBaseUrl,
  normalizeOpportunityCollection,
  normalizeSuggestionCollection,
  normalizeSiteInput,
} from './utils';
import { EVALUATOR_API_PATH, SUGGESTION_EVALUATOR_API_PATH } from './constants';
import type {
  FetchSiteParams,
  FetchSiteSuccessResult,
  OpportunityRecord,
  SentimentEvaluationRequest,
  SentimentEvaluationResult,
  SuggestionEvaluationRequest,
  SuggestionEvaluationResult,
} from './types';

const API_HEADERS = {
  Accept: 'application/json',
};

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
  attempt = 0,
): Promise<T> {
  try {
    const trimmedApiKey = apiKey.trim();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${trimmedApiKey}`,
        'x-api-key': trimmedApiKey,
      },
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '2', 10);
      const waitSeconds = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : 2;

      if (attempt < 1) {
        await sleep(waitSeconds * 1000);
        return requestJson<T>(url, apiKey, attempt + 1);
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
  const response = await fetch(url, {
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

async function resolveSiteByDirectLookup(
  normalizedApiBaseUrl: string,
  apiKey: string,
  lookupCandidates: string[],
) {
  for (const candidate of lookupCandidates) {
    const encodedCandidate = encodeBase64PathValue(candidate);
    const lookupUrl = buildApiUrl(
      normalizedApiBaseUrl,
      `sites/by-base-url/${encodedCandidate}`,
    );

    try {
      const lookupResponse = await requestJson<unknown>(lookupUrl, apiKey);
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
) {
  try {
    const lookupResponse = await requestJson<unknown>(
      buildApiUrl(normalizedApiBaseUrl, 'sites'),
      apiKey,
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
) {
  try {
    const suggestionsUrl = buildApiUrl(
      normalizedApiBaseUrl,
      `sites/${encodeURIComponent(siteId)}/opportunities/${encodeURIComponent(
        opportunity.opportunityId,
      )}/suggestions`,
    );
    const suggestionsPayload = await requestJson<unknown>(suggestionsUrl, apiKey);
    const normalizedSuggestions = normalizeSuggestionCollection(
      suggestionsPayload,
      opportunity.opportunityType,
    );

    return {
      ...opportunity,
      suggestions: normalizedSuggestions.suggestions,
      sentimentItems: normalizedSuggestions.sentimentItems,
    };
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
}: FetchSiteParams): Promise<FetchSiteSuccessResult> {
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const normalizedSiteInput = normalizeSiteInput(siteInput);
  const lookupCandidates = buildLookupCandidates(normalizedSiteInput);

  if (!normalizedApiBaseUrl) {
    throw new SpacecatApiError('API base URL is required.');
  }

  if (!apiKey.trim()) {
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
  );
  const enumeratedLookupMatch =
    directLookupMatch ??
    (await resolveSiteByEnumeratingAllSites(
      normalizedApiBaseUrl,
      apiKey,
      lookupCandidates,
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
  const opportunitiesPayload = await requestJson<unknown>(opportunitiesUrl, apiKey);
  const opportunityPresence = summarizeOpportunityPresence(opportunitiesPayload);
  const normalizedOpportunities = normalizeOpportunityCollection(opportunitiesPayload);
  const opportunities = await Promise.all(
    normalizedOpportunities.map((opportunity) =>
      fetchSuggestionsForOpportunity(
        normalizedApiBaseUrl,
        apiKey,
        resolvedSiteId,
        opportunity,
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
