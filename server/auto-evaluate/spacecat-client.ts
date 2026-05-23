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

// Mirror of the dashboard's `normalizeOpportunityType` in
// src/features/off-site-dashboard/utils.ts. Duplicated here (rather than
// imported) because utils.ts pulls in browser-only modules; this server
// runs in a pure Node serverless context. Keep the two implementations in
// sync — they read the same SpaceCat payloads.
function classifyOpportunityType(
  rawValue: string,
): AutoEvalOpportunityType | undefined {
  if (!rawValue) return undefined;
  const typeValue = rawValue.trim().toLowerCase();
  const compactValue = typeValue.replace(/[^a-z0-9]+/g, '');
  if (!compactValue) return undefined;

  if (compactValue.includes('reddit')) return 'Reddit';
  if (compactValue.includes('youtube')) return 'YouTube';
  if (compactValue.includes('wikipedia')) return 'Wikipedia';

  // 'Prompt Gap' is in the dashboard's classifier but isn't a suggestion-
  // evaluation type, so we deliberately skip it here.

  if (
    compactValue === 'url' ||
    compactValue === 'urls' ||
    compactValue.includes('cited') ||
    compactValue.startsWith('url') ||
    compactValue.endsWith('urls')
  ) {
    return 'Cited URLs';
  }

  return undefined;
}

// The dashboard infers opportunity type from multiple signal fields when
// `type` itself is generic (e.g. "guidance"). We replicate that fallback
// so the cron never misses opportunities that the UI would surface.
const OPPORTUNITY_SIGNAL_KEYS = [
  'type',
  'opportunityType',
  'name',
  'kind',
  'category',
  'title',
  'description',
] as const;

function classifyOpportunityFromRecord(
  record: Record<string, unknown>,
): { opportunityType: AutoEvalOpportunityType; rawSignal: string } | undefined {
  for (const key of OPPORTUNITY_SIGNAL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      const opportunityType = classifyOpportunityType(candidate);
      if (opportunityType) {
        return { opportunityType, rawSignal: candidate };
      }
    }
  }
  return undefined;
}

interface RawSuggestionRecord {
  id?: unknown;
  suggestionId?: unknown;
  data?: unknown;
  evidence?: unknown;
  [key: string]: unknown;
}

// Cap the size of debug samples so a single oversized field can't blow
// up the JSON response or the GitHub Actions log.
function truncateForDebug(value: unknown, maxChars = 1200): unknown {
  const serialized = JSON.stringify(value, null, 2);
  if (!serialized) return value;
  return serialized.length > maxChars
    ? `${serialized.slice(0, maxChars - 1)}…`
    : serialized;
}

// SpaceCat's Reddit / YouTube / Cited URLs / Wikipedia suggestions all
// arrive with the body in `data.suggestionValue` as a markdown blob
// (Share of Voice tables, sentiment summaries, recommendations, etc.).
// The dashboard parses this into per-recommendation sub-suggestions via
// DOMParser-on-<details>; we cannot do that server-side without a Node
// DOM polyfill. For the MVP we treat the whole markdown as a single
// fact-checkable unit (one verdict per opportunity) — coarser than the
// dashboard but still useful for "tell me which analyses are wrong".
function extractSuggestionText(record: RawSuggestionRecord): string {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const candidates = [
    data.suggestionValue,
    data.suggestion,
    data.text,
    data.recommendation,
    data.body,
    data.value,
    data.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

// Pull the first http(s) URL out of any string field, then out of the
// markdown body. Used both as the "primary" suggestion URL (for issue
// linkbacks) and as evidence for the LLM evaluator.
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

function extractFirstUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(URL_REGEX);
  return match?.[0]?.replace(/[)\].,;:!?]+$/, '');
}

function extractSuggestionUrl(record: RawSuggestionRecord): string | undefined {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const directCandidates = [
    data.url,
    data.suggestionUrl,
    data.link,
    data.source,
    data.pageUrl,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const recommendations = Array.isArray(data.recommendations)
    ? (data.recommendations as unknown[])
    : [];
  for (const rec of recommendations) {
    if (!rec || typeof rec !== 'object') continue;
    const candidate = (rec as Record<string, unknown>).pageUrl;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return (
    extractFirstUrl(data.suggestionValue) ?? extractFirstUrl(data.suggestion)
  );
}

function extractEvidenceItems(record: RawSuggestionRecord): string[] {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const explicit =
    (Array.isArray(data.evidence) && data.evidence) ||
    (Array.isArray(record.evidence) && record.evidence) ||
    [];
  const explicitItems = (explicit as unknown[])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);

  const markdownUrls = (() => {
    const value = data.suggestionValue;
    if (typeof value !== 'string') return [] as string[];
    const matches = value.match(URL_REGEX) ?? [];
    return matches.map((url) => url.replace(/[)\].,;:!?]+$/, ''));
  })();

  // Dedupe while preserving order.
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...explicitItems, ...markdownUrls]) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
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

export interface ListOpportunitiesDiagnostics {
  rawCount: number;
  classifiedCount: number;
  unclassifiedRawTypes: string[];
}

export interface ListOpportunitiesResult {
  opportunities: RawSpacecatOpportunity[];
  diagnostics: ListOpportunitiesDiagnostics;
}

export async function listOpportunities(
  siteId: string,
  env: SpacecatClientEnv,
): Promise<ListOpportunitiesResult> {
  const { apiKey, baseUrl } = getCredentials(env);
  const url = `${baseUrl}/sites/${encodeURIComponent(siteId)}/opportunities`;
  const payload = await spacecatRequest<unknown>(url, apiKey);

  const opportunities: RawSpacecatOpportunity[] = [];
  const unclassifiedRawTypes = new Set<string>();
  const rawEntries = unwrapList(payload);

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id =
      (typeof record.id === 'string' && record.id) ||
      (typeof record.opportunityId === 'string' && record.opportunityId) ||
      '';
    if (!id) continue;

    const classification = classifyOpportunityFromRecord(record);
    if (!classification) {
      const fallbackSignal =
        (typeof record.type === 'string' && record.type) ||
        (typeof record.name === 'string' && record.name) ||
        '(no type/name)';
      unclassifiedRawTypes.add(fallbackSignal);
      continue;
    }

    opportunities.push({
      opportunityId: id,
      opportunityType: classification.opportunityType,
      rawType: classification.rawSignal,
      status: typeof record.status === 'string' ? record.status : '',
      suggestions: [],
    });
  }

  return {
    opportunities,
    diagnostics: {
      rawCount: rawEntries.length,
      classifiedCount: opportunities.length,
      unclassifiedRawTypes: Array.from(unclassifiedRawTypes).slice(0, 10),
    },
  };
}

export interface ListSuggestionsResult {
  suggestions: RawSpacecatSuggestion[];
  /**
   * Debug-only: when the parsed shape returns zero suggestions but the raw
   * payload had entries, expose one sample record so we can extend the
   * extractor without another deploy round-trip.
   */
  unparseableSample?: unknown;
  rawEntryCount: number;
}

export async function listSuggestions(
  siteId: string,
  opportunityId: string,
  opportunityType: AutoEvalOpportunityType,
  env: SpacecatClientEnv,
): Promise<ListSuggestionsResult> {
  const { apiKey, baseUrl } = getCredentials(env);
  const url = `${baseUrl}/sites/${encodeURIComponent(
    siteId,
  )}/opportunities/${encodeURIComponent(opportunityId)}/suggestions`;
  const payload = await spacecatRequest<unknown>(url, apiKey);

  const suggestions: RawSpacecatSuggestion[] = [];
  const rawEntries = unwrapList(payload);

  for (const entry of rawEntries) {
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

    suggestions.push({
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

  return {
    suggestions,
    rawEntryCount: rawEntries.length,
    unparseableSample:
      suggestions.length === 0 && rawEntries.length > 0
        ? truncateForDebug(rawEntries[0])
        : undefined,
  };
}
