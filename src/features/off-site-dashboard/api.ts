import {
  buildStatusMessage,
  buildLookupCandidates,
  extractSiteId,
  normalizeApiBaseUrl,
  normalizeOpportunityCollection,
  normalizeSuggestionCollection,
  normalizeSiteInput,
} from './utils';
import type {
  FetchSiteParams,
  FetchSiteSuccessResult,
  OpportunityRecord,
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

function encodeBase64PathValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binaryString = '';
  bytes.forEach((byte) => {
    binaryString += String.fromCharCode(byte);
  });
  return encodeURIComponent(window.btoa(binaryString));
}

async function resolveSiteByDirectLookup(
  normalizedApiBaseUrl: string,
  apiKey: string,
  lookupCandidates: string[],
) {
  for (const candidate of lookupCandidates) {
    const encodedCandidate = encodeBase64PathValue(candidate);
    const lookupUrl = `${normalizedApiBaseUrl}/api/v1/sites/by-base-url/${encodedCandidate}`;

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
      `${normalizedApiBaseUrl}/api/v1/sites`,
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
    const suggestionsUrl =
      `${normalizedApiBaseUrl}/api/v1/sites/${encodeURIComponent(siteId)}` +
      `/opportunities/${encodeURIComponent(opportunity.opportunityId)}/suggestions`;
    const suggestionsPayload = await requestJson<unknown>(suggestionsUrl, apiKey);

    return {
      ...opportunity,
      suggestions: normalizeSuggestionCollection(suggestionsPayload),
    };
  } catch (error) {
    if (
      error instanceof SpacecatApiError &&
      (error.status === 403 || error.status === 404)
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

  const opportunitiesUrl = `${normalizedApiBaseUrl}/api/v1/sites/${encodeURIComponent(resolvedSiteId)}/opportunities`;
  const opportunitiesPayload = await requestJson<unknown>(opportunitiesUrl, apiKey);
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
    opportunities,
  };
}
