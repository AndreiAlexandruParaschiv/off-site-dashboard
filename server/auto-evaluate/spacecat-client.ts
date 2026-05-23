// Server-side SpaceCat REST client used by the auto-evaluation cron.
//
// This intentionally duplicates a slim subset of the browser-side client
// (src/features/off-site-dashboard/api.ts) so the cron worker can run in a
// pure Node serverless environment without pulling in any browser-only
// dependencies (Vite import.meta.env, window.btoa, window.setTimeout).

const DEFAULT_SPACECAT_API_BASE_URL =
  'https://spacecat.experiencecloud.live/api/v1';

const UPSTREAM_REQUEST_TIMEOUT_MS = 15000;

export type SpacecatClientEnv = {
  SPACECAT_API_KEY?: string;
  SPACECAT_API_BASE_URL?: string;
};

export type AutoEvalOpportunityType =
  | 'Reddit'
  | 'YouTube'
  | 'Cited URLs'
  | 'Wikipedia';

export interface RawSpacecatSuggestion {
  suggestionId: string;
  suggestionText: string;
  suggestionUrl?: string;
  evidenceItems: string[];
}

export interface RawSpacecatOpportunity {
  opportunityId: string;
  opportunityType: AutoEvalOpportunityType;
  rawType: string;
  status: string;
  suggestions: RawSpacecatSuggestion[];
}

function normalizeApiBaseUrl(value?: string) {
  return (value?.trim() || DEFAULT_SPACECAT_API_BASE_URL).replace(/\/+$/, '');
}

function getCredentials(env: SpacecatClientEnv) {
  const apiKey = env.SPACECAT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'SPACECAT_API_KEY is not configured. Auto-evaluation requires the managed SpaceCat credentials.',
    );
  }
  return { apiKey, baseUrl: normalizeApiBaseUrl(env.SPACECAT_API_BASE_URL) };
}

async function spacecatRequest<T>(
  url: string,
  apiKey: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `SpaceCat ${response.status} ${response.statusText} for ${url}: ${detail.slice(0, 200)}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// Build the lookup candidates the upstream `sites/by-base-url/{b64}` accepts.
// We try https://host, https://www.host, and host alone so a bare domain
// like "gmc.com" still resolves.
function buildLookupCandidates(siteInput: string): string[] {
  const trimmed = siteInput.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return [];
  }

  let host = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).host;
    } catch {
      host = trimmed;
    }
  }
  host = host.replace(/^www\./i, '');

  return [
    `https://${host}`,
    `https://www.${host}`,
    host,
    `http://${host}`,
  ];
}

// Use the runtime-agnostic global `btoa` (available in Node ≥16 and any
// Vercel runtime) so we do not depend on @types/node. SpaceCat lookup URLs
// are pure ASCII, so we do not need a UTF-8 → binary intermediate.
function encodeBase64(value: string) {
  return globalThis.btoa(value);
}

interface RawSiteRecord {
  id?: unknown;
  siteId?: unknown;
  baseURL?: unknown;
  baseUrl?: unknown;
  url?: unknown;
}

function extractSiteIdFromRecord(record: RawSiteRecord) {
  const id = record.id ?? record.siteId;
  if (typeof id === 'string' && id.trim()) {
    return id.trim();
  }
  return undefined;
}

export async function resolveSiteId(
  siteInput: string,
  env: SpacecatClientEnv,
): Promise<{ siteId: string; siteUrl: string }> {
  const { apiKey, baseUrl } = getCredentials(env);

  for (const candidate of buildLookupCandidates(siteInput)) {
    const lookupUrl = `${baseUrl}/sites/by-base-url/${encodeURIComponent(
      encodeBase64(candidate),
    )}`;
    try {
      const payload = await spacecatRequest<RawSiteRecord | RawSiteRecord[]>(
        lookupUrl,
        apiKey,
      );
      const record = Array.isArray(payload) ? payload[0] : payload;
      if (!record) {
        continue;
      }
      const siteId = extractSiteIdFromRecord(record);
      if (siteId) {
        const resolvedUrl =
          (typeof record.baseURL === 'string' && record.baseURL.trim()) ||
          (typeof record.baseUrl === 'string' && record.baseUrl.trim()) ||
          (typeof record.url === 'string' && record.url.trim()) ||
          candidate;
        return { siteId, siteUrl: resolvedUrl };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /\b404\b/.test(error.message)
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Could not resolve siteId for "${siteInput}" via SpaceCat /sites/by-base-url.`,
  );
}

const KNOWN_TYPES: Record<string, AutoEvalOpportunityType> = {
  reddit: 'Reddit',
  youtube: 'YouTube',
  'youtube-video': 'YouTube',
  'cited-urls': 'Cited URLs',
  'cited urls': 'Cited URLs',
  citedurl: 'Cited URLs',
  'citation-gap': 'Cited URLs',
  wikipedia: 'Wikipedia',
};

// Conservative classifier: only match well-known raw type strings. The
// dashboard has richer fuzzy classification, but for the cron we prefer
// false negatives (skip the suggestion) over false positives (waste an
// LLM/BrightData call on an unrelated opportunity). Anything missed here
// stays in the dashboard for manual evaluation.
function classifyOpportunityType(
  rawType: string,
): AutoEvalOpportunityType | undefined {
  const normalized = rawType.trim().toLowerCase();
  if (KNOWN_TYPES[normalized]) {
    return KNOWN_TYPES[normalized];
  }
  if (normalized.includes('reddit')) return 'Reddit';
  if (normalized.includes('youtube')) return 'YouTube';
  if (normalized.includes('wikipedia') || normalized.includes('wiki')) {
    return 'Wikipedia';
  }
  if (normalized.includes('cited') || normalized.includes('citation')) {
    return 'Cited URLs';
  }
  return undefined;
}

interface RawSuggestionRecord {
  id?: unknown;
  suggestionId?: unknown;
  data?: unknown;
  evidence?: unknown;
}

function extractSuggestionText(record: RawSuggestionRecord): string {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const candidates = [
    data.suggestion,
    data.text,
    data.recommendation,
    data.body,
    data.value,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function extractSuggestionUrl(record: RawSuggestionRecord): string | undefined {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const candidates = [data.url, data.suggestionUrl, data.link, data.source];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractEvidenceItems(record: RawSuggestionRecord): string[] {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const raw =
    (Array.isArray(data.evidence) && data.evidence) ||
    (Array.isArray(record.evidence) && record.evidence) ||
    [];
  return (raw as unknown[])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function unwrapList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['suggestions', 'opportunities', 'items', 'data', 'results']) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return [];
}

interface RawOpportunityRecord {
  id?: unknown;
  opportunityId?: unknown;
  type?: unknown;
  opportunityType?: unknown;
  status?: unknown;
  suggestions?: unknown;
}

export async function listOpportunities(
  siteId: string,
  env: SpacecatClientEnv,
): Promise<RawSpacecatOpportunity[]> {
  const { apiKey, baseUrl } = getCredentials(env);
  const url = `${baseUrl}/sites/${encodeURIComponent(siteId)}/opportunities`;
  const payload = await spacecatRequest<unknown>(url, apiKey);

  const result: RawSpacecatOpportunity[] = [];

  for (const entry of unwrapList(payload)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as RawOpportunityRecord;
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.opportunityId === 'string'
          ? record.opportunityId
          : '';
    if (!id) continue;
    const rawType =
      (typeof record.type === 'string' && record.type) ||
      (typeof record.opportunityType === 'string' && record.opportunityType) ||
      '';
    const opportunityType = classifyOpportunityType(rawType);
    if (!opportunityType) continue;

    result.push({
      opportunityId: id,
      opportunityType,
      rawType,
      status: typeof record.status === 'string' ? record.status : '',
      suggestions: [],
    });
  }

  return result;
}

export async function listSuggestions(
  siteId: string,
  opportunityId: string,
  opportunityType: AutoEvalOpportunityType,
  env: SpacecatClientEnv,
): Promise<RawSpacecatSuggestion[]> {
  const { apiKey, baseUrl } = getCredentials(env);
  const url = `${baseUrl}/sites/${encodeURIComponent(
    siteId,
  )}/opportunities/${encodeURIComponent(opportunityId)}/suggestions`;
  const payload = await spacecatRequest<unknown>(url, apiKey);

  const result: RawSpacecatSuggestion[] = [];

  for (const entry of unwrapList(payload)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as RawSuggestionRecord;
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.suggestionId === 'string'
          ? record.suggestionId
          : '';
    const suggestionText = extractSuggestionText(record);
    if (!id || !suggestionText) continue;

    result.push({
      suggestionId: id,
      suggestionText,
      suggestionUrl: extractSuggestionUrl(record),
      evidenceItems: extractEvidenceItems(record),
    });
  }

  // Opportunity type is captured here so callers can build evaluation
  // requests without re-classifying. Currently unused by the loop but kept
  // in the function signature for future filtering (e.g. skipping certain
  // types per-site).
  void opportunityType;

  return result;
}
