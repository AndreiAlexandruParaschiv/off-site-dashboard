// Server-side SpaceCat REST client used by the auto-evaluation cron.
//
// This intentionally duplicates a slim subset of the browser-side client
// (src/features/off-site-dashboard/api.ts) so the cron worker can run in a
// pure Node serverless environment without pulling in any browser-only
// dependencies (Vite import.meta.env, window.btoa, window.setTimeout).

import {
  canRemintSession,
  getSpacecatAuthHeaders,
  hasManagedAuth,
  resetS2SCache,
  type SpacecatS2SEnv,
} from '../auth/spacecat-s2s.js';

const DEFAULT_SPACECAT_API_BASE_URL =
  'https://llmo.experiencecloud.live/api/v1';

const UPSTREAM_REQUEST_TIMEOUT_MS = 15000;

export type SpacecatClientEnv = SpacecatS2SEnv & {
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
  /**
   * `classified`: opportunity-level signals identified the off-site type.
   * `inspect`: opportunity is a catchall (e.g. generic-opportunity); we
   * need to classify each suggestion individually by its content.
   */
  classification:
    | { mode: 'classified'; opportunityType: AutoEvalOpportunityType }
    | { mode: 'inspect' };
  rawType: string;
  status: string;
  suggestions: RawSpacecatSuggestion[];
}

function normalizeApiBaseUrl(value?: string) {
  return (value?.trim() || DEFAULT_SPACECAT_API_BASE_URL).replace(/\/+$/, '');
}

function getBaseUrl(env: SpacecatClientEnv): string {
  return normalizeApiBaseUrl(env.SPACECAT_API_BASE_URL);
}

async function buildHeaders(
  env: SpacecatClientEnv,
): Promise<Record<string, string>> {
  if (hasManagedAuth(env)) {
    return { accept: 'application/json', ...(await getSpacecatAuthHeaders(env)) };
  }
  const apiKey = env.SPACECAT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'No SpaceCat auth configured. Set SPACECAT_SESSION_TOKEN, IMS_SP_* (S2S), SPACECAT_IMS_ACCESS_TOKEN (user login), or SPACECAT_API_KEY.',
    );
  }
  return { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
}

async function spacecatRequest<T>(
  url: string,
  env: SpacecatClientEnv,
): Promise<T> {
  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: await buildHeaders(env),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response = await doFetch();
  if (response.status === 401 && canRemintSession(env)) {
    resetS2SCache();
    response = await doFetch();
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `SpaceCat ${response.status} ${response.statusText} for ${url}: ${detail.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
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
  const baseUrl = getBaseUrl(env);

  for (const candidate of buildLookupCandidates(siteInput)) {
    const lookupUrl = `${baseUrl}/sites/by-base-url/${encodeURIComponent(
      encodeBase64(candidate),
    )}`;
    try {
      const payload = await spacecatRequest<RawSiteRecord | RawSiteRecord[]>(
        lookupUrl,
        env,
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

// Hard skip list — on-page / technical SEO opportunity types that have
// no off-site analysis. Avoids wasting SpaceCat /suggestions fetches and
// LLM cycles. Keep lowercase; matched after `.toLowerCase().trim()`.
const SKIP_OPPORTUNITY_RAW_TYPES = new Set([
  'prerender',
  'readability',
  'faq',
  'meta-tags',
  'summarization',
  'canonical',
  'toc',
  'high-organic-low-ctr',
  'sitemap',
  'alt-text',
  'cwv',
  'paid-traffic',
  'generic-autofix-edge',
]);

// Types that don't classify on opportunity-level fields BUT may contain
// off-site analyses in their suggestions' content. We fetch their
// suggestions and inspect each one individually.
const INSPECT_OPPORTUNITY_RAW_TYPES = new Set([
  'generic-opportunity',
]);

export type OpportunityClassification =
  | {
      mode: 'classified';
      opportunityType: AutoEvalOpportunityType;
      rawSignal: string;
    }
  | { mode: 'inspect'; rawSignal: string }
  | { mode: 'skip'; rawSignal: string };

export function classifyOpportunityFromRecord(
  record: Record<string, unknown>,
): OpportunityClassification {
  const rawTypeValue =
    (typeof record.type === 'string' && record.type) ||
    (typeof record.opportunityType === 'string' && record.opportunityType) ||
    '';
  const normalizedRawType = rawTypeValue.trim().toLowerCase();

  if (SKIP_OPPORTUNITY_RAW_TYPES.has(normalizedRawType)) {
    return { mode: 'skip', rawSignal: rawTypeValue || '(no type)' };
  }

  for (const key of OPPORTUNITY_SIGNAL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      const opportunityType = classifyOpportunityType(candidate);
      if (opportunityType) {
        return { mode: 'classified', opportunityType, rawSignal: candidate };
      }
    }
  }

  if (INSPECT_OPPORTUNITY_RAW_TYPES.has(normalizedRawType)) {
    return { mode: 'inspect', rawSignal: rawTypeValue || '(no type)' };
  }

  return { mode: 'skip', rawSignal: rawTypeValue || '(no type)' };
}

/**
 * For opportunities that didn't classify on opportunity-level fields
 * (e.g. generic-opportunity), inspect a single suggestion's content
 * (markdown body, structured title/rationale) and decide whether it is
 * actually a Reddit / YouTube / Cited URLs / Wikipedia analysis.
 */
export function classifySuggestionContent(
  record: RawSuggestionRecord,
): AutoEvalOpportunityType | undefined {
  const data = (record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const signals: string[] = [];
  for (const key of ['suggestionValue', 'title', 'rationale', 'body']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      signals.push(value);
    }
  }
  if (Array.isArray(data.actionItems)) {
    for (const item of data.actionItems as unknown[]) {
      if (typeof item === 'string' && item.trim()) {
        signals.push(item);
      }
    }
  }
  if (signals.length === 0) return undefined;

  return classifyOpportunityType(signals.join(' '));
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

// SpaceCat returns suggestions in (at least) two different shapes,
// depending on opportunity type:
//
// Shape A — markdown blob:
//   data.suggestionValue = "# Key Insights\n| Metric | Value | ..."
//   (Share of Voice, sentiment, recommendations rendered as markdown)
//
// Shape B — structured strategic recommendation:
//   data.title       = "Strengthen High-Trust Coverage"
//   data.priority    = "low" | "medium" | "high"
//   data.rationale   = "4 favorable URLs with 282 citations..."
//   data.actionItems = ["Reach out to www.healthline.com ...", ...]
//
// Both shapes need a single string `suggestionText` for the LLM
// evaluator. The dashboard breaks Shape A into per-recommendation
// sub-suggestions via DOMParser; we cannot do that server-side without
// a Node DOM polyfill, so the cron MVP treats each shape as a single
// fact-checkable unit (one verdict per opportunity).

function joinNonEmpty(lines: ReadonlyArray<string>): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n');
}

function extractStructuredRecommendationText(
  data: Record<string, unknown>,
): string {
  const titleRaw = typeof data.title === 'string' ? data.title.trim() : '';
  const priorityRaw =
    typeof data.priority === 'string' ? data.priority.trim() : '';
  const rationaleRaw =
    typeof data.rationale === 'string' ? data.rationale.trim() : '';
  const actionItemsRaw = Array.isArray(data.actionItems)
    ? (data.actionItems as unknown[])
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    : [];

  if (!titleRaw && !rationaleRaw && actionItemsRaw.length === 0) {
    return '';
  }

  const headline = priorityRaw
    ? `[${priorityRaw.toUpperCase()}] ${titleRaw}`.trim()
    : titleRaw;

  const actionItemsBlock =
    actionItemsRaw.length > 0
      ? `Action items:\n${actionItemsRaw.map((item) => `- ${item}`).join('\n')}`
      : '';

  return joinNonEmpty([headline, rationaleRaw, actionItemsBlock]);
}

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

  return extractStructuredRecommendationText(data);
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

  const actionItemUrl = Array.isArray(data.actionItems)
    ? (data.actionItems as unknown[])
        .map((entry) => extractFirstUrl(entry))
        .find(Boolean)
    : undefined;

  return (
    extractFirstUrl(data.suggestionValue) ??
    extractFirstUrl(data.suggestion) ??
    extractFirstUrl(data.rationale) ??
    actionItemUrl
  );
}

function collectUrlsFromString(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const matches = value.match(URL_REGEX) ?? [];
  return matches.map((url) => url.replace(/[)\].,;:!?]+$/, ''));
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

  const actionItemUrls = Array.isArray(data.actionItems)
    ? (data.actionItems as unknown[]).flatMap((entry) =>
        collectUrlsFromString(entry),
      )
    : [];

  const candidateUrls = [
    ...collectUrlsFromString(data.suggestionValue),
    ...collectUrlsFromString(data.rationale),
    ...actionItemUrls,
  ];

  // Dedupe while preserving order.
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...explicitItems, ...candidateUrls]) {
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
  inspectCount: number;
  skippedCount: number;
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
  const baseUrl = getBaseUrl(env);
  const url = `${baseUrl}/sites/${encodeURIComponent(siteId)}/opportunities`;
  const payload = await spacecatRequest<unknown>(url, env);

  const opportunities: RawSpacecatOpportunity[] = [];
  const unclassifiedRawTypes = new Set<string>();
  let inspectCount = 0;
  let skippedCount = 0;
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

    if (classification.mode === 'skip') {
      skippedCount += 1;
      unclassifiedRawTypes.add(classification.rawSignal);
      continue;
    }

    if (classification.mode === 'inspect') {
      inspectCount += 1;
      opportunities.push({
        opportunityId: id,
        classification: { mode: 'inspect' },
        rawType: classification.rawSignal,
        status: typeof record.status === 'string' ? record.status : '',
        suggestions: [],
      });
      continue;
    }

    opportunities.push({
      opportunityId: id,
      classification: {
        mode: 'classified',
        opportunityType: classification.opportunityType,
      },
      rawType: classification.rawSignal,
      status: typeof record.status === 'string' ? record.status : '',
      suggestions: [],
    });
  }

  return {
    opportunities,
    diagnostics: {
      rawCount: rawEntries.length,
      classifiedCount: opportunities.filter(
        (opportunity) => opportunity.classification.mode === 'classified',
      ).length,
      inspectCount,
      skippedCount,
      unclassifiedRawTypes: Array.from(unclassifiedRawTypes).slice(0, 10),
    },
  };
}

export interface ClassifiedSuggestion {
  suggestion: RawSpacecatSuggestion;
  opportunityType: AutoEvalOpportunityType;
}

export interface ListSuggestionsResult {
  suggestions: ClassifiedSuggestion[];
  /**
   * Debug-only: when the parsed shape returns zero suggestions but the raw
   * payload had entries, expose one sample record so we can extend the
   * extractor without another deploy round-trip.
   */
  unparseableSample?: unknown;
  rawEntryCount: number;
  /**
   * Number of suggestions that parsed correctly but whose content did
   * not match any off-site type (only relevant for `inspect` mode).
   */
  unclassifiedByContentCount: number;
}

/**
 * Fetch and parse the suggestions for one opportunity.
 *
 * @param fallbackType When the parent opportunity was classified at the
 * opportunity level, pass its type and every parsed suggestion adopts it.
 * When undefined (i.e. the parent was 'inspect' mode), each suggestion is
 * classified individually by its content, and those that don't match an
 * off-site type are dropped (and counted in
 * `unclassifiedByContentCount`).
 */
export async function listSuggestions(
  siteId: string,
  opportunityId: string,
  fallbackType: AutoEvalOpportunityType | undefined,
  env: SpacecatClientEnv,
): Promise<ListSuggestionsResult> {
  const baseUrl = getBaseUrl(env);
  const url = `${baseUrl}/sites/${encodeURIComponent(
    siteId,
  )}/opportunities/${encodeURIComponent(opportunityId)}/suggestions`;
  const payload = await spacecatRequest<unknown>(url, env);

  const suggestions: ClassifiedSuggestion[] = [];
  let unclassifiedByContentCount = 0;
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

    const opportunityType =
      fallbackType ?? classifySuggestionContent(record);
    if (!opportunityType) {
      unclassifiedByContentCount += 1;
      continue;
    }

    suggestions.push({
      opportunityType,
      suggestion: {
        suggestionId: id,
        suggestionText,
        suggestionUrl: extractSuggestionUrl(record),
        evidenceItems: extractEvidenceItems(record),
      },
    });
  }

  return {
    suggestions,
    unclassifiedByContentCount,
    rawEntryCount: rawEntries.length,
    unparseableSample:
      suggestions.length === 0 && rawEntries.length > 0
        ? truncateForDebug(rawEntries[0])
        : undefined,
  };
}
