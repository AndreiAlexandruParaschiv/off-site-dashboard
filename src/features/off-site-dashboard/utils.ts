import { TARGET_OPPORTUNITY_TYPES } from './constants';
import type {
  CanonicalOpportunityType,
  DashboardRow,
  OpportunityRecord,
  SiteDashboardResult,
  SuggestionRecord,
} from './types';

const LOOKUP_SITE_KEYS = ['sites', 'items', 'data', 'results'] as const;
const OPPORTUNITY_KEYS = ['opportunities', 'items', 'data', 'results'] as const;
const SUGGESTION_KEYS = ['suggestions', 'items', 'data', 'results'] as const;
const SITE_URL_KEYS = [
  'baseURL',
  'baseUrl',
  'base_url',
  'url',
  'siteUrl',
  'siteURL',
] as const;
const OPPORTUNITY_SIGNAL_KEYS = [
  'type',
  'name',
  'kind',
  'category',
  'title',
  'description',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProtocol(value: string) {
  return /^[a-z]+:\/\//i.test(value);
}

function normalizeUrlParts(value: string) {
  const candidate = hasProtocol(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  url.search = '';
  url.hash = '';
  return url;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function getStringValue(
  record: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const rawValue = record[key];
    if (typeof rawValue === 'string' && rawValue.trim()) {
      return rawValue.trim();
    }
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return String(rawValue);
    }
  }

  return undefined;
}

function getArrayValue(
  record: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const rawValue = record[key];
    if (Array.isArray(rawValue)) {
      return rawValue;
    }
  }

  return [];
}

function extractCollection(
  value: unknown,
  preferredKeys: readonly string[],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of preferredKeys) {
    const nestedValue = value[key];
    if (Array.isArray(nestedValue)) {
      return nestedValue.filter(isRecord);
    }
  }

  for (const key of preferredKeys) {
    const nestedValue = value[key];
    if (isRecord(nestedValue)) {
      const nestedCollection = extractCollection(nestedValue, preferredKeys);
      if (nestedCollection.length > 0) {
        return nestedCollection;
      }
    }
  }

  return [];
}

function compareUrlLikeValues(left?: string, right?: string) {
  return normalizeComparableUrl(left) === normalizeComparableUrl(right);
}

function normalizeComparableHostname(value?: string) {
  if (!value) {
    return '';
  }

  try {
    return normalizeUrlParts(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .replace(/:\d+$/, '')
      .replace(/^www\./, '');
  }
}

function compareHostnameLikeValues(left?: string, right?: string) {
  const leftHost = normalizeComparableHostname(left);
  const rightHost = normalizeComparableHostname(right);

  if (!leftHost || !rightHost) {
    return false;
  }

  return leftHost === rightHost;
}

export function normalizeComparableUrl(value?: string) {
  if (!value) {
    return '';
  }

  try {
    const url = normalizeUrlParts(value);
    return stripTrailingSlash(`${url.origin}${url.pathname}`).toLowerCase();
  } catch {
    return stripTrailingSlash(value.trim()).toLowerCase();
  }
}

export function normalizeApiBaseUrl(value: string) {
  if (!value.trim()) {
    return '';
  }

  try {
    const url = normalizeUrlParts(value.trim());
    return stripTrailingSlash(url.origin);
  } catch {
    return stripTrailingSlash(value.trim());
  }
}

export function normalizeSiteInput(value: string) {
  if (!value.trim()) {
    return '';
  }

  try {
    const url = normalizeUrlParts(value.trim());
    const path = stripTrailingSlash(url.pathname);
    return `${url.origin}${path}`;
  } catch {
    return stripTrailingSlash(value.trim());
  }
}

export function normalizeSiteList(inputText: string) {
  const uniqueSites = new Set<string>();

  inputText
    .split(/\n|,/g)
    .map((value) => normalizeSiteInput(value))
    .filter(Boolean)
    .forEach((value) => uniqueSites.add(value));

  return Array.from(uniqueSites);
}

export function buildLookupCandidates(siteInput: string) {
  if (!siteInput.trim()) {
    return [];
  }

  try {
    const url = normalizeUrlParts(siteInput.trim());
    const pathSegments = stripTrailingSlash(url.pathname)
      .split('/')
      .filter(Boolean);
    const candidates: string[] = [];

    if (pathSegments.length > 0) {
      for (let length = pathSegments.length; length > 0; length -= 1) {
        candidates.push(`${url.origin}/${pathSegments.slice(0, length).join('/')}`);
      }
    }

    candidates.push(url.origin);
    candidates.push(url.hostname);

    if (url.hostname.startsWith('www.')) {
      candidates.push(url.hostname.replace(/^www\./, ''));
    } else {
      candidates.push(`www.${url.hostname}`);
    }

    return Array.from(new Set(candidates.map(stripTrailingSlash)));
  } catch {
    return [stripTrailingSlash(siteInput.trim())];
  }
}

export function normalizeOpportunityType(rawType: unknown) {
  if (rawType === null || rawType === undefined) {
    return null;
  }

  const typeValue = String(rawType).trim().toLowerCase();
  const compactValue = typeValue.replace(/[^a-z0-9]+/g, '');

  if (compactValue.includes('reddit')) {
    return 'Reddit';
  }

  if (compactValue.includes('youtube')) {
    return 'YouTube';
  }

  if (
    compactValue.includes('promptgap') ||
    compactValue.includes('prompgap') ||
    (compactValue.includes('prompt') && compactValue.includes('gap'))
  ) {
    return 'Prompt Gap';
  }

  if (
    compactValue === 'url' ||
    compactValue === 'urls' ||
    compactValue.includes('citedurl') ||
    compactValue.includes('citedurls') ||
    compactValue.includes('topcitedurl') ||
    compactValue.includes('topcitedurls') ||
    compactValue.startsWith('url') ||
    compactValue.endsWith('urls')
  ) {
    return 'Cited URLs';
  }

  if (compactValue.includes('wikipedia')) {
    return 'Wikipedia';
  }

  return null;
}

function flattenRecordSignals(record: Record<string, unknown>) {
  const signals: string[] = [];

  OPPORTUNITY_SIGNAL_KEYS.forEach((key) => {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      signals.push(value.trim());
    }
  });

  const tags = getArrayValue(record, ['tags', 'labels', 'keywords']);
  tags.forEach((tagValue) => {
    if (typeof tagValue === 'string' && tagValue.trim()) {
      signals.push(tagValue.trim());
      return;
    }

    if (isRecord(tagValue)) {
      const nestedTag = getStringValue(tagValue, ['name', 'label', 'value', 'type']);
      if (nestedTag) {
        signals.push(nestedTag);
      }
    }
  });

  return signals;
}

function inferOpportunityType(record: Record<string, unknown>) {
  const signals = flattenRecordSignals(record);

  if (signals.length === 0) {
    return null;
  }

  return normalizeOpportunityType(signals.join(' '));
}

export function extractSiteId(responsePayload: unknown, requestedSite: string) {
  const collection = extractCollection(responsePayload, LOOKUP_SITE_KEYS);

  if (collection.length === 0) {
    if (isRecord(responsePayload)) {
      const directSiteId = getStringValue(responsePayload, ['siteId', 'id']);
      if (directSiteId) {
        return {
          siteId: directSiteId,
          resolvedSiteUrl:
            getStringValue(responsePayload, SITE_URL_KEYS) ??
            requestedSite,
        };
      }

      const nestedData = responsePayload.data;
      if (isRecord(nestedData)) {
        const nestedSiteId = getStringValue(nestedData, ['siteId', 'id']);
        if (nestedSiteId) {
          return {
            siteId: nestedSiteId,
            resolvedSiteUrl:
              getStringValue(nestedData, SITE_URL_KEYS) ??
              requestedSite,
          };
        }
      }
    }

    return null;
  }

  const matchedSite =
    collection.find((site) =>
      compareUrlLikeValues(getStringValue(site, SITE_URL_KEYS), requestedSite),
    ) ??
    collection.find((site) =>
      compareHostnameLikeValues(getStringValue(site, SITE_URL_KEYS), requestedSite),
    );

  if (!matchedSite) {
    return null;
  }

  const siteId = getStringValue(matchedSite, ['siteId', 'id']);
  if (!siteId) {
    return null;
  }

  return {
    siteId,
    resolvedSiteUrl: getStringValue(matchedSite, SITE_URL_KEYS) ?? requestedSite,
  };
}

function extractFirstUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().startsWith('http')) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractFirstUrl(entry);
      if (url) {
        return url;
      }
    }
  }

  if (isRecord(value)) {
    return (
      getStringValue(value, ['url', 'href', 'link', 'sourceUrl', 'targetUrl']) ??
      extractFirstUrl(value.url ?? value.href ?? value.link ?? value.urls)
    );
  }

  return undefined;
}

function extractSuggestionTextValue(record: Record<string, unknown>) {
  const directText =
    getStringValue(record, [
      'text',
      'suggestionText',
      'body',
      'description',
      'title',
      'content',
      'summary',
      'snippet',
      'reasoning',
      'message',
    ]) ?? '';

  if (directText) {
    return directText;
  }

  const nestedData = record.data;
  if (isRecord(nestedData)) {
    const nestedText =
      getStringValue(nestedData, [
        'text',
        'suggestionText',
        'body',
        'description',
        'title',
        'content',
        'summary',
        'snippet',
        'reasoning',
        'message',
        'topic',
        'query',
      ]) ?? '';

    if (nestedText) {
      return nestedText;
    }
  }

  return '';
}

function normalizeSuggestion(record: Record<string, unknown>, index: number) {
  const suggestionText = extractSuggestionTextValue(record);
  const suggestionUrl =
    getStringValue(record, [
      'url',
      'href',
      'link',
      'targetUrl',
      'suggestionUrl',
    ]) ??
    extractFirstUrl(record.data);
  const suggestionId =
    getStringValue(record, ['suggestionId', 'id', 'uuid']) ??
    `suggestion-${index + 1}`;

  if (!suggestionText && !suggestionUrl && !suggestionId) {
    return null;
  }

  const normalizedSuggestion: SuggestionRecord = {
    suggestionId,
    suggestionText,
  };

  if (suggestionUrl) {
    normalizedSuggestion.suggestionUrl = suggestionUrl;
  }

  return normalizedSuggestion;
}

function normalizeOpportunity(record: Record<string, unknown>, index: number) {
  const opportunityStatus =
    getStringValue(record, ['status', 'opportunityStatus'])?.trim().toLowerCase() ??
    '';
  if (opportunityStatus === 'ignored') {
    return null;
  }

  const rawType =
    getStringValue(record, ['type', 'name', 'kind', 'category']) ?? '';
  const opportunityType =
    normalizeOpportunityType(rawType) ?? inferOpportunityType(record);

  if (!opportunityType) {
    return null;
  }

  const opportunityId =
    getStringValue(record, ['opportunityId', 'id', 'uuid']) ??
    `opportunity-${index + 1}`;
  const rawSuggestions = getArrayValue(record, [
    'suggestions',
    'items',
    'recommendations',
    'suggestionItems',
  ]);
  const suggestions = rawSuggestions
    .filter(isRecord)
    .map((suggestion, suggestionIndex) =>
      normalizeSuggestion(suggestion, suggestionIndex),
    )
    .filter((value): value is SuggestionRecord => value !== null);

  const normalizedOpportunity: OpportunityRecord = {
    opportunityId,
    opportunityType,
    rawType: rawType || opportunityType,
    suggestions,
  };

  return normalizedOpportunity;
}

export function normalizeOpportunityCollection(responsePayload: unknown) {
  const collection = extractCollection(responsePayload, OPPORTUNITY_KEYS);

  if (collection.length === 0) {
    if (isRecord(responsePayload)) {
      const directOpportunityId = getStringValue(responsePayload, [
        'opportunityId',
        'id',
      ]);
      if (directOpportunityId) {
        const directOpportunity = normalizeOpportunity(responsePayload, 0);
        return directOpportunity ? [directOpportunity] : [];
      }
    }
    return [];
  }

  return collection
    .map((record, index) => normalizeOpportunity(record, index))
    .filter((value): value is OpportunityRecord => value !== null);
}

export function normalizeSuggestionCollection(responsePayload: unknown) {
  const collection = extractCollection(responsePayload, SUGGESTION_KEYS);

  if (collection.length === 0) {
    if (isRecord(responsePayload)) {
      const directSuggestionId = getStringValue(responsePayload, [
        'suggestionId',
        'id',
        'uuid',
      ]);
      if (directSuggestionId) {
        const suggestion = normalizeSuggestion(responsePayload, 0);
        return suggestion ? [suggestion] : [];
      }
    }

    return [];
  }

  return collection
    .map((record, index) => normalizeSuggestion(record, index))
    .filter((value): value is SuggestionRecord => value !== null);
}

export function createIdleSiteResult(requestSite: string): SiteDashboardResult {
  return {
    requestSite,
    status: 'idle',
    statusMessage: 'Waiting for refresh',
    opportunities: [],
  };
}

export function countSuggestions(opportunities: OpportunityRecord[]) {
  return opportunities.reduce(
    (count, opportunity) => count + opportunity.suggestions.length,
    0,
  );
}

export function buildStatusMessage(opportunities: OpportunityRecord[]) {
  const suggestionCount = countSuggestions(opportunities);
  const uniqueTypeCount = new Set(
    opportunities.map((opportunity) => opportunity.opportunityType),
  ).size;
  const typeLabel = uniqueTypeCount === 1 ? 'type' : 'types';

  if (opportunities.length === 0) {
    return 'No matching opportunities found';
  }

  if (suggestionCount === 0) {
    return `${uniqueTypeCount} opportunity ${typeLabel} found`;
  }

  return `${uniqueTypeCount} opportunity ${typeLabel} / ${suggestionCount} suggestions`;
}

export function flattenSiteRows(siteResults: SiteDashboardResult[]) {
  const rows: DashboardRow[] = [];

  siteResults.forEach((siteResult) => {
    const sharedFields = {
      site: siteResult.requestSite,
      siteId: siteResult.siteId,
      lastUpdated: siteResult.lastUpdated,
    };

    if (siteResult.opportunities.length === 0) {
      rows.push({
        id: `${siteResult.requestSite}-summary`,
        ...sharedFields,
        status: siteResult.error ?? siteResult.statusMessage,
      });
      return;
    }

    siteResult.opportunities.forEach((opportunity) => {
      if (opportunity.suggestions.length === 0) {
        rows.push({
          id: `${siteResult.requestSite}-${opportunity.opportunityId}-empty`,
          ...sharedFields,
          opportunityType: opportunity.opportunityType,
          opportunityId: opportunity.opportunityId,
          status:
            siteResult.status === 'error'
              ? `Stale data - ${siteResult.error}`
              : 'No suggestions returned',
        });
        return;
      }

      opportunity.suggestions.forEach((suggestion) => {
        rows.push({
          id: [
            siteResult.requestSite,
            opportunity.opportunityId,
            suggestion.suggestionId,
          ].join('-'),
          ...sharedFields,
          opportunityType: opportunity.opportunityType,
          opportunityId: opportunity.opportunityId,
          suggestionId: suggestion.suggestionId,
          suggestionText: suggestion.suggestionText,
          suggestionUrl: suggestion.suggestionUrl,
          status:
            siteResult.status === 'error'
              ? `Stale data - ${siteResult.error}`
              : 'Ready',
        });
      });
    });
  });

  return rows;
}

export function formatTimestamp(timestamp?: string) {
  if (!timestamp) {
    return 'Never';
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function getStatusTone(status: SiteDashboardResult['status']) {
  if (status === 'success') {
    return 'success';
  }

  if (status === 'error') {
    return 'error';
  }

  if (status === 'loading') {
    return 'warning';
  }

  return 'neutral';
}

export function trimSuggestionText(value?: string) {
  if (!value) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

export function getOpportunityTypeSummary(rows: DashboardRow[]) {
  const buckets = TARGET_OPPORTUNITY_TYPES.reduce<
    Record<CanonicalOpportunityType, Set<string>>
  >(
    (nextBuckets, type) => {
      nextBuckets[type] = new Set<string>();
      return nextBuckets;
    },
    {
      Reddit: new Set<string>(),
      YouTube: new Set<string>(),
      'Cited URLs': new Set<string>(),
      'Prompt Gap': new Set<string>(),
      Wikipedia: new Set<string>(),
    },
  );

  rows.forEach((row) => {
    if (!row.opportunityType || !row.opportunityId) {
      return;
    }

    const opportunityKey = `${row.site}::${row.opportunityId}`;
    buckets[row.opportunityType].add(opportunityKey);
  });

  return TARGET_OPPORTUNITY_TYPES.reduce<Record<CanonicalOpportunityType, number>>(
    (summary, type) => {
      summary[type] = buckets[type].size;
      return summary;
    },
    {
      Reddit: 0,
      YouTube: 0,
      'Cited URLs': 0,
      'Prompt Gap': 0,
      Wikipedia: 0,
    },
  );
}
