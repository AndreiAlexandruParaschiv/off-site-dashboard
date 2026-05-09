import { TARGET_OPPORTUNITY_TYPES } from './constants';
import type {
  CanonicalOpportunityType,
  DashboardRow,
  OpportunityPresenceState,
  OpportunityRecord,
  SentimentItemRecord,
  SiteDashboardResult,
  SuggestionRecordStatus,
  SuggestionRecord,
} from './types';

const LOOKUP_SITE_KEYS = ['sites', 'items', 'data', 'results'] as const;
const OPPORTUNITY_KEYS = ['opportunities', 'items', 'data', 'results'] as const;
const SUGGESTION_KEYS = ['suggestions', 'items', 'data', 'results'] as const;
const STRATEGIC_RECOMMENDATION_TYPES = new Set<CanonicalOpportunityType>([
  'Reddit',
  'YouTube',
  'Cited URLs',
]);
const SENTIMENT_TABLE_TYPES = new Set<CanonicalOpportunityType>([
  'Reddit',
  'YouTube',
  'Cited URLs',
]);
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

interface NormalizedSuggestionPayload {
  suggestions: SuggestionRecord[];
  sentimentItems: SentimentItemRecord[];
}

export function normalizeSuggestionStatus(rawValue: unknown): SuggestionRecordStatus {
  const normalizedValue = String(rawValue ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();

  if (normalizedValue === 'NEW') {
    return 'NEW';
  }

  if (normalizedValue === 'PENDING_VALIDATION') {
    return 'PENDING_VALIDATION';
  }

  if (normalizedValue === 'OUTDATED') {
    return 'OUTDATED';
  }

  if (normalizedValue === 'IGNORED') {
    return 'IGNORED';
  }

  if (normalizedValue === 'FIXED') {
    return 'FIXED';
  }

  return 'UNKNOWN';
}

export function isCurrentSuggestionStatus(status?: SuggestionRecordStatus) {
  return (
    status === undefined ||
    status === 'UNKNOWN' ||
    status === 'NEW' ||
    status === 'PENDING_VALIDATION'
  );
}

function getNumberValue(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const rawValue = record[key];

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return rawValue;
    }

    if (typeof rawValue === 'string' && rawValue.trim()) {
      const parsedValue = Number.parseFloat(rawValue.trim().replace(/,/g, ''));

      if (Number.isFinite(parsedValue)) {
        return parsedValue;
      }
    }
  }

  return undefined;
}

function formatMetricValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

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

function normalizeAbsoluteUrl(value?: string) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    return trimmedValue;
  }

  return `https://${trimmedValue.replace(/^\/+/, '')}`;
}

function trimTrailingUrlPunctuation(value: string) {
  let nextValue = value.trim();

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
}

function extractUrlCandidatesFromText(value?: string) {
  if (!value) {
    return [];
  }

  return Array.from(
    new Set(
      Array.from(
        value.matchAll(
          /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi,
        ),
      )
        .map((match) => normalizeAbsoluteUrl(trimTrailingUrlPunctuation(match[0] ?? '')))
        .filter(Boolean),
    ),
  );
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
    const normalizedPath = stripTrailingSlash(url.pathname);
    const apiPath = normalizedPath && normalizedPath !== '/' ? normalizedPath : '/api/v1';
    return stripTrailingSlash(`${url.origin}${apiPath}`);
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
    // `includes('cited')` covers cited-urls, top-cited-urls, AND
    // cited-analysis (the backend's current name for the Cited URLs
    // opportunity type). The narrower citedurl(s) / topcitedurl(s)
    // rules above are kept as explicit anchors so the intent stays
    // readable even if `cited` ever needs scoping.
    compactValue.includes('cited') ||
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

export function createEmptyOpportunityPresence() {
  return {
    Reddit: 'missing',
    YouTube: 'missing',
    'Cited URLs': 'missing',
    'Prompt Gap': 'missing',
    Wikipedia: 'missing',
  } satisfies Record<CanonicalOpportunityType, OpportunityPresenceState>;
}

export function summarizeOpportunityPresence(responsePayload: unknown) {
  const collection = extractCollection(responsePayload, OPPORTUNITY_KEYS);
  const records =
    collection.length > 0
      ? collection
      : isRecord(responsePayload)
        ? [responsePayload]
        : [];
  const statusBuckets = TARGET_OPPORTUNITY_TYPES.reduce<
    Record<
      CanonicalOpportunityType,
      { hasIgnored: boolean; hasNew: boolean; hasVisible: boolean }
    >
  >(
    (nextBuckets, type) => {
      nextBuckets[type] = {
        hasIgnored: false,
        hasNew: false,
        hasVisible: false,
      };
      return nextBuckets;
    },
    {
      Reddit: { hasIgnored: false, hasNew: false, hasVisible: false },
      YouTube: { hasIgnored: false, hasNew: false, hasVisible: false },
      'Cited URLs': { hasIgnored: false, hasNew: false, hasVisible: false },
      'Prompt Gap': { hasIgnored: false, hasNew: false, hasVisible: false },
      Wikipedia: { hasIgnored: false, hasNew: false, hasVisible: false },
    },
  );

  records.forEach((record) => {
    const rawType =
      getStringValue(record, ['type', 'name', 'kind', 'category']) ?? '';
    const opportunityType =
      normalizeOpportunityType(rawType) ?? inferOpportunityType(record);

    if (!opportunityType) {
      return;
    }

    const opportunityStatus =
      getStringValue(record, ['status', 'opportunityStatus'])?.trim().toLowerCase() ??
      '';

    if (opportunityStatus === 'ignored') {
      statusBuckets[opportunityType].hasIgnored = true;
      return;
    }

    if (opportunityStatus === 'new') {
      statusBuckets[opportunityType].hasNew = true;
    }

    statusBuckets[opportunityType].hasVisible = true;
  });

  return TARGET_OPPORTUNITY_TYPES.reduce<
    Record<CanonicalOpportunityType, OpportunityPresenceState>
  >((presence, type) => {
    const bucket = statusBuckets[type];

    if (bucket.hasIgnored && bucket.hasVisible) {
      if (bucket.hasNew) {
        presence[type] = 'exists_new_ignored';
        return presence;
      }

      presence[type] = 'exists_mixed';
      return presence;
    }

    if (bucket.hasVisible) {
      presence[type] = 'exists';
      return presence;
    }

    if (bucket.hasIgnored) {
      presence[type] = 'exists_ignored_only';
      return presence;
    }

    presence[type] = 'missing';
    return presence;
  }, createEmptyOpportunityPresence());
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

function normalizeTextContent(value?: string | null) {
  if (!value) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value: string) {
  return value
    .split('\n')
    .map((line) => normalizeTextContent(line))
    .filter(Boolean)
    .join('\n');
}

function getSuggestionValue(record: Record<string, unknown>) {
  const directValue =
    getStringValue(record, ['suggestionValue', 'value', 'content']) ?? '';

  if (directValue) {
    return directValue;
  }

  const nestedData = record.data;
  if (isRecord(nestedData)) {
    return (
      getStringValue(nestedData, ['suggestionValue', 'value', 'content']) ?? ''
    );
  }

  return '';
}

function extractRecommendationSection(value: string) {
  const headingMatch = /^#{1,6}\s*Strategic Recommendations\b.*$/im.exec(value);

  if (!headingMatch) {
    return '';
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const sectionBody = value.slice(sectionStart);
  const nextBoundaryMatch = /\n---\s*\n|\n#{1,6}\s+/i.exec(sectionBody);
  const sectionEnd = nextBoundaryMatch ? nextBoundaryMatch.index : sectionBody.length;

  return sectionBody.slice(0, sectionEnd).trim();
}

function createPlainTextFromHtmlFragment(fragment: string) {
  if (typeof DOMParser === 'undefined') {
    return normalizeTextContent(fragment.replace(/<[^>]+>/g, ' '));
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${fragment}</div>`, 'text/html');
  const root = document.body.firstElementChild;

  if (!root) {
    return '';
  }

  root.querySelectorAll('br').forEach((element) => {
    element.replaceWith(document.createTextNode('\n'));
  });

  root.querySelectorAll('li').forEach((element) => {
    element.prepend(document.createTextNode('- '));
    element.append(document.createTextNode('\n'));
  });

  root
    .querySelectorAll(
      'p, div, ul, ol, table, tr, h1, h2, h3, h4, h5, h6, summary',
    )
    .forEach((element) => {
      element.append(document.createTextNode('\n'));
    });

  return normalizeMultilineText(root.textContent ?? '');
}

function extractRecommendationUrl(detailsElement: Element) {
  const firstLink = detailsElement.querySelector('a[href]');
  const href = firstLink?.getAttribute('href')?.trim();

  if (!href) {
    return undefined;
  }

  return /^https?:\/\//i.test(href) ? href : undefined;
}

function extractFirstMarkdownLinkUrl(value: string) {
  const linkMatch = /\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(value);
  return linkMatch?.[1]?.trim();
}

function extractFirstHtmlLinkUrl(value: string) {
  if (typeof DOMParser === 'undefined' || !/<a\b/i.test(value)) {
    return undefined;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${value}</div>`, 'text/html');
  const href = document.querySelector('a[href]')?.getAttribute('href')?.trim();

  return href && /^https?:\/\//i.test(href) ? href : undefined;
}

function normalizeMarkdownCellValue(
  value: string,
  options: { preferLinkUrl?: boolean } = {},
) {
  if (!value.trim()) {
    return '';
  }

  if (options.preferLinkUrl) {
    const linkUrl = extractFirstMarkdownLinkUrl(value);
    if (linkUrl) {
      return linkUrl;
    }

    const htmlLinkUrl = extractFirstHtmlLinkUrl(value);
    if (htmlLinkUrl) {
      return htmlLinkUrl;
    }
  }

  const normalizedValue = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/gi, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '');

  return createPlainTextFromHtmlFragment(normalizedValue);
}

function splitMarkdownTableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isMarkdownTableSeparator(line: string) {
  const cells = splitMarkdownTableCells(line);

  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, '')))
  );
}

function extractMarkdownTables(value: string) {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      !isMarkdownTableRow(lines[index]) ||
      !isMarkdownTableRow(lines[index + 1]) ||
      !isMarkdownTableSeparator(lines[index + 1])
    ) {
      continue;
    }

    const headers = splitMarkdownTableCells(lines[index]);
    const rows: string[][] = [];
    index += 2;

    while (index < lines.length && isMarkdownTableRow(lines[index])) {
      const cells = splitMarkdownTableCells(lines[index]);
      const normalizedCells = headers.map((_, cellIndex) => cells[cellIndex] ?? '');
      rows.push(normalizedCells);
      index += 1;
    }

    tables.push({ headers, rows });
    index -= 1;
  }

  return tables;
}

function extractHtmlTables(value: string) {
  if (typeof DOMParser === 'undefined' || !/<table\b/i.test(value)) {
    return [] as Array<{ headers: string[]; rows: string[][] }>;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${value}</div>`, 'text/html');

  return Array.from(document.querySelectorAll('table')).flatMap((table) => {
    const tableRows = Array.from(table.querySelectorAll('tr')).filter(
      (row) =>
        row.closest('table') === table &&
        row.querySelectorAll('th, td').length > 0,
    );

    if (tableRows.length === 0) {
      return [];
    }

    const headerRow =
      tableRows.find((row) => row.querySelectorAll('th').length > 0) ?? tableRows[0];
    const headerCells = Array.from(headerRow.querySelectorAll('th, td')).filter(
      (cell) => cell.closest('tr') === headerRow,
    );
    const headers = headerCells.map((cell) =>
      createPlainTextFromHtmlFragment(cell.innerHTML),
    );

    if (headers.length === 0) {
      return [];
    }

    const rows = tableRows
      .filter((row) => row !== headerRow)
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('th, td')).filter(
          (cell) => cell.closest('tr') === row,
        );

        return headers.map(
          (_, cellIndex) =>
            cells[cellIndex]?.innerHTML ?? '',
        );
      })
      .filter((row) =>
        row.some((cell) => createPlainTextFromHtmlFragment(cell).trim()),
      );

    if (rows.length === 0) {
      return [];
    }

    return [{ headers, rows }];
  });
}

function extractSentimentItemsFromSuggestionValue(
  suggestionValue: string,
): SentimentItemRecord[] {
  const tables = [
    ...extractMarkdownTables(suggestionValue),
    ...extractHtmlTables(suggestionValue),
  ];

  return tables.flatMap((table) => {
    const normalizedHeaders = table.headers.map((header) =>
      normalizeTextContent(header).toLowerCase(),
    );
    const sovIndex = normalizedHeaders.findIndex(
      (header) => header === 'sov' || header.includes('share of voice'),
    );
    const sentimentIndex = normalizedHeaders.findIndex(
      (header) =>
        header === 'sentiment' || header.includes('brand sentiment'),
    );
    const timesCitedIndex = normalizedHeaders.findIndex(
      (header) =>
        header === 'times cited' ||
        header.includes('times cited') ||
        header === 'citations' ||
        header.includes('citation'),
    );

    if (sovIndex === -1 || sentimentIndex === -1) {
      return [];
    }

    const preferredItemIndex = normalizedHeaders.findIndex((header) =>
      ['item', 'url', 'thread', 'video', 'page', 'article', 'post', 'source', 'prompt'].some(
        (candidate) =>
          header === candidate ||
          header.startsWith(`${candidate} `) ||
          header.includes(`${candidate} (`),
      ),
    );
    const itemIndex =
      preferredItemIndex !== -1
        ? preferredItemIndex
        : normalizedHeaders.findIndex(
            (_, headerIndex) =>
              headerIndex !== sovIndex && headerIndex !== sentimentIndex,
          );

    if (itemIndex === -1) {
      return [];
    }

    return table.rows
      .map((row) => {
        const item = normalizeMarkdownCellValue(row[itemIndex] ?? '', {
          preferLinkUrl: true,
        });
        const sov = normalizeMarkdownCellValue(row[sovIndex] ?? '');
        const sentiment = normalizeMarkdownCellValue(row[sentimentIndex] ?? '');
        const timesCitedRaw =
          timesCitedIndex !== -1
            ? normalizeMarkdownCellValue(row[timesCitedIndex] ?? '')
            : '';
        const timesCitedMatch = timesCitedRaw.match(/\d[\d,]*/);
        const timesCited = timesCitedMatch
          ? Number.parseInt(timesCitedMatch[0].replace(/,/g, ''), 10)
          : undefined;

        if (!item && !sov && !sentiment) {
          return null;
        }

        return {
          item,
          sov,
          sentiment,
          ...(typeof timesCited === 'number' && Number.isFinite(timesCited)
            ? { timesCited }
            : {}),
        } satisfies SentimentItemRecord;
      })
      .filter((value): value is SentimentItemRecord => value !== null);
  });
}

function extractStrategicRecommendationSuggestions(
  suggestionValue: string,
  suggestionId: string,
): SuggestionRecord[] {
  if (typeof DOMParser === 'undefined') {
    return [] as SuggestionRecord[];
  }

  const recommendationSection = extractRecommendationSection(suggestionValue);
  const recommendationSource = recommendationSection || suggestionValue;

  if (!recommendationSource) {
    return [] as SuggestionRecord[];
  }

  const detailsMatches = recommendationSource.match(/<details\b[\s\S]*?<\/details>/gi);
  if (!detailsMatches || detailsMatches.length === 0) {
    const plainSection = normalizeMultilineText(
      createPlainTextFromHtmlFragment(recommendationSource),
    );

    return plainSection
      ? [
          {
            suggestionId,
            suggestionText: plainSection,
            status: 'UNKNOWN',
          },
        ]
      : [];
  }

  const parser = new DOMParser();

  return detailsMatches
    .map((detailsMarkup, recommendationIndex) => {
      const document = parser.parseFromString(`<div>${detailsMarkup}</div>`, 'text/html');
      const detailsElement = document.querySelector('details');

      if (!detailsElement) {
        return null;
      }

      const summaryElement = detailsElement.querySelector('summary');
      const summaryText = normalizeTextContent(summaryElement?.textContent);

      if (!summaryText) {
        return null;
      }

      const priorityMatch = /\b(HIGH|MEDIUM|LOW)\b/i.exec(summaryText);
      const cleanedTitle = summaryText
        .replace(/\b(HIGH|MEDIUM|LOW)\b/i, '')
        .replace(/[▼▾]+$/u, '')
        .replace(/^\s*\d+\.\s*/, '')
        .trim();

      const contentBlocks = Array.from(detailsElement.children)
        .filter((element) => element !== summaryElement)
        .map((element) => createPlainTextFromHtmlFragment(element.innerHTML))
        .map((value) => normalizeTextContent(value))
        .filter(Boolean);

      const suggestionParts = [
        priorityMatch ? `[${priorityMatch[1].toUpperCase()}] ${cleanedTitle}` : cleanedTitle,
        ...contentBlocks,
      ];
      const suggestionText = normalizeMultilineText(suggestionParts.join('\n\n'));

      if (!suggestionText) {
        return null;
      }

      const normalizedSuggestion: SuggestionRecord = {
        suggestionId: `${suggestionId}-rec-${recommendationIndex + 1}`,
        suggestionText,
        status: 'UNKNOWN',
      };
      const recommendationUrl = extractRecommendationUrl(detailsElement);

      if (recommendationUrl) {
        normalizedSuggestion.suggestionUrl = recommendationUrl;
      }

      return normalizedSuggestion;
    })
    .filter((value): value is SuggestionRecord => value !== null);
}

function createEmptySuggestionPayload(): NormalizedSuggestionPayload {
  return {
    suggestions: [],
    sentimentItems: [],
  };
}

function normalizeSuggestion(
  record: Record<string, unknown>,
  index: number,
  opportunityType?: CanonicalOpportunityType,
): NormalizedSuggestionPayload | null {
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
  const rawSuggestionId = getStringValue(record, ['suggestionId', 'id', 'uuid']);
  const suggestionId = rawSuggestionId ?? `suggestion-${index + 1}`;
  const suggestionStatus = normalizeSuggestionStatus(record.status);
  const suggestionValue = getSuggestionValue(record);
  const fallbackSuggestionText =
    !suggestionText && suggestionValue
      ? createPlainTextFromHtmlFragment(suggestionValue)
      : '';
  const evidenceItems = Array.from(
    new Set(
      [
        suggestionUrl ? normalizeAbsoluteUrl(suggestionUrl) : '',
        ...extractUrlCandidatesFromText(suggestionText),
        ...extractUrlCandidatesFromText(fallbackSuggestionText ?? ''),
        ...extractUrlCandidatesFromText(suggestionValue ?? ''),
      ].filter(Boolean),
    ),
  );
  const sentimentItems =
    opportunityType &&
    SENTIMENT_TABLE_TYPES.has(opportunityType) &&
    suggestionValue
      ? extractSentimentItemsFromSuggestionValue(suggestionValue)
      : [];

  if (
    opportunityType &&
    STRATEGIC_RECOMMENDATION_TYPES.has(opportunityType) &&
    suggestionValue
  ) {
    const strategicSuggestions = extractStrategicRecommendationSuggestions(
      suggestionValue,
      suggestionId,
    );

    if (strategicSuggestions.length > 0) {
      return {
        suggestions: strategicSuggestions,
        sentimentItems,
      };
    }
  }

  if (!suggestionText && !fallbackSuggestionText && !suggestionUrl && !rawSuggestionId) {
    return sentimentItems.length > 0
      ? {
          suggestions: [],
          sentimentItems,
        }
      : null;
  }

  const normalizedSuggestion: SuggestionRecord = {
    suggestionId,
    suggestionText: suggestionText || fallbackSuggestionText,
    status: suggestionStatus,
  };

  if (suggestionUrl) {
    normalizedSuggestion.suggestionUrl = suggestionUrl;
  }

  if (evidenceItems.length > 0) {
    normalizedSuggestion.evidenceItems = evidenceItems;
  }

  return {
    suggestions: [normalizedSuggestion],
    sentimentItems,
  };
}

function getOpportunitySuggestionRecords(record: Record<string, unknown>) {
  const directSuggestions = getArrayValue(record, SUGGESTION_KEYS).filter(isRecord);

  if (directSuggestions.length > 0) {
    return directSuggestions;
  }

  const nestedData = record.data;

  if (isRecord(nestedData)) {
    const nestedSuggestions = getArrayValue(nestedData, SUGGESTION_KEYS).filter(isRecord);

    if (nestedSuggestions.length > 0) {
      return nestedSuggestions;
    }

    const nestedFullAnalysis = nestedData.fullAnalysis;

    if (isRecord(nestedFullAnalysis)) {
      const analysisSuggestions = getArrayValue(
        nestedFullAnalysis,
        SUGGESTION_KEYS,
      ).filter(isRecord);

      if (analysisSuggestions.length > 0) {
        return analysisSuggestions;
      }
    }
  }

  return [] as Record<string, unknown>[];
}

const ANALYTICS_INSIGHTS_SECTION_KEYS = ['content', 'combined'] as const;

function getAnalyticsInsightsContentSources(
  record: Record<string, unknown>,
): Record<string, unknown>[] {
  const data = record.data;
  if (!isRecord(data)) return [];
  const dashboard = data.dashboard;
  if (!isRecord(dashboard)) return [];
  const analytics = dashboard.analytics;
  if (!isRecord(analytics)) return [];
  const performance = analytics.performance;
  if (!isRecord(performance)) return [];
  const insights = performance.insights;
  if (!isRecord(insights)) return [];

  for (const sectionKey of ANALYTICS_INSIGHTS_SECTION_KEYS) {
    const section = insights[sectionKey];
    if (isRecord(section) && Array.isArray(section.sources)) {
      return section.sources.filter(isRecord);
    }
  }

  return [];
}

function extractAnalyticsInsightsSentimentItems(
  record: Record<string, unknown>,
): SentimentItemRecord[] {
  const sources = getAnalyticsInsightsContentSources(record);
  if (sources.length === 0) return [];

  const items = sources
    .map((source) => {
      const url = getStringValue(source, ['url']) ?? '';
      const title = getStringValue(source, ['title']) ?? '';
      const item = url || title;

      const mentions = isRecord(source.mentions) ? source.mentions : null;
      const brandMentions = mentions && isRecord(mentions.brand) ? mentions.brand : null;
      const brandName = brandMentions
        ? (getStringValue(brandMentions, ['name']) ?? '')
        : '';
      const sovPercent = brandMentions
        ? getNumberValue(brandMentions, ['mentionsPercent'])
        : undefined;
      const sov =
        typeof sovPercent === 'number'
          ? brandName
            ? `${brandName}: ${formatMetricValue(sovPercent)}%`
            : `${formatMetricValue(sovPercent)}%`
          : '';

      // Extract competitor brand names from mentions.others (array of { name, mentionsPercent, ... })
      const competitorMentions =
        mentions && Array.isArray(mentions.others)
          ? (mentions.others as unknown[]).filter(isRecord)
          : [];
      const competitors = competitorMentions
        .map((c) => getStringValue(c, ['name']) ?? '')
        .filter(Boolean);

      const sentimentRecord = isRecord(source.sentiment) ? source.sentiment : null;
      const sentiment = sentimentRecord
        ? (getStringValue(sentimentRecord, ['label']) ?? '')
        : '';

      const citations = getNumberValue(source, ['citations']);

      if (!item && !sov && !sentiment && typeof citations !== 'number') {
        return null;
      }

      return {
        item,
        ...(title && title !== item ? { title } : {}),
        sov,
        sentiment,
        ...(competitors.length > 0 ? { competitors } : {}),
        ...(typeof citations === 'number' && Number.isFinite(citations)
          ? { timesCited: citations }
          : {}),
      } satisfies SentimentItemRecord;
    })
    .filter((value): value is SentimentItemRecord => value !== null);

  const hasAnyCitedItems = items.some(
    (item) => typeof item.timesCited === 'number' && item.timesCited > 0,
  );

  if (!hasAnyCitedItems) {
    return items;
  }

  return items.filter(
    (item) => item.timesCited === undefined || item.timesCited > 0,
  );
}

function truncateAnalysisText(value: string, maxLength = 320) {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractAnalyticsInsightsTopicEvidence(
  record: Record<string, unknown>,
  opportunityType: CanonicalOpportunityType,
): string[] {
  const data = record.data;
  if (!isRecord(data)) return [];
  const dashboard = data.dashboard;
  if (!isRecord(dashboard)) return [];
  const analytics = dashboard.analytics;
  if (!isRecord(analytics)) return [];
  const performance = analytics.performance;
  if (!isRecord(performance)) return [];
  const insights = performance.insights;
  if (!isRecord(insights)) return [];

  const evidence: string[] = [];
  const sectionKeys = [...ANALYTICS_INSIGHTS_SECTION_KEYS, 'comments'] as const;

  for (const sectionKey of sectionKeys) {
    const section = insights[sectionKey];
    if (!isRecord(section)) continue;
    const topics = Array.isArray(section.topics) ? section.topics.filter(isRecord) : [];
    if (topics.length === 0) continue;

    const sectionLabel = sectionKey === 'combined' ? '' : ` (${sectionKey})`;

    for (const topic of topics) {
      const title = getStringValue(topic, ['title']) ?? '';
      if (!title) continue;

      const sentimentRecord = isRecord(topic.sentiment) ? topic.sentiment : null;
      const sentimentLabel = sentimentRecord
        ? (getStringValue(sentimentRecord, ['label']) ?? '')
        : '';
      const sentimentScore = sentimentRecord
        ? getNumberValue(sentimentRecord, ['score'])
        : undefined;
      const mentionsRecord = isRecord(topic.mentions) ? topic.mentions : null;
      const brandMentions =
        mentionsRecord && isRecord(mentionsRecord.brand) ? mentionsRecord.brand : null;
      const brandMentionCount = brandMentions
        ? getNumberValue(brandMentions, ['mentions'])
        : undefined;
      const brandMentionName = brandMentions
        ? (getStringValue(brandMentions, ['name']) ?? '')
        : '';

      const headerParts = [`${opportunityType} topic${sectionLabel}: ${title}`];
      if (sentimentLabel) {
        const scoreSuffix =
          typeof sentimentScore === 'number'
            ? ` (${sentimentScore.toFixed(2)})`
            : '';
        headerParts.push(`sentiment=${sentimentLabel}${scoreSuffix}`);
      }
      if (typeof brandMentionCount === 'number' && brandMentionName) {
        headerParts.push(`${brandMentionName} mentions=${brandMentionCount}`);
      }
      evidence.push(headerParts.join(' | '));

      const analysis = getStringValue(topic, ['analysis']) ?? '';
      if (analysis) {
        evidence.push(
          `${opportunityType} topic "${title}" analysis: ${truncateAnalysisText(analysis)}`,
        );
      }

      const bindings = isRecord(topic.bindings) ? topic.bindings : null;
      const boundSources = bindings && Array.isArray(bindings.sources)
        ? bindings.sources.filter(isRecord)
        : [];

      if (boundSources.length > 0) {
        const formattedSources = boundSources
          .slice(0, 12)
          .map((source) => {
            const url = getStringValue(source, ['url']) ?? '';
            const sourceTitle = getStringValue(source, ['title']) ?? '';
            if (sourceTitle && url) return `"${sourceTitle}" (${url})`;
            return sourceTitle || url;
          })
          .filter(Boolean);

        if (formattedSources.length > 0) {
          const overflow =
            boundSources.length > formattedSources.length
              ? ` + ${boundSources.length - formattedSources.length} more`
              : '';
          evidence.push(
            `${opportunityType} topic "${title}" threads: ${formattedSources.join('; ')}${overflow}`,
          );
        }
      }

      const boundSuggestions = bindings && Array.isArray(bindings.suggestions)
        ? bindings.suggestions.filter(isRecord)
        : [];
      if (boundSuggestions.length > 0) {
        const suggestionTitles = boundSuggestions
          .map((suggestion) => getStringValue(suggestion, ['title']) ?? '')
          .filter(Boolean)
          .slice(0, 6);
        if (suggestionTitles.length > 0) {
          evidence.push(
            `${opportunityType} topic "${title}" related suggestions: ${suggestionTitles.join('; ')}`,
          );
        }
      }
    }
  }

  return evidence;
}

function isNormalizedWikipediaUrl(value: string) {
  try {
    const parsedUrl = new URL(value);
    return /(^|\.)wikipedia\.org$/i.test(parsedUrl.hostname);
  } catch {
    return false;
  }
}

function normalizeWikipediaUrlCandidate(value?: string) {
  const normalizedValue = normalizeAbsoluteUrl(value);

  if (!normalizedValue || !isNormalizedWikipediaUrl(normalizedValue)) {
    return '';
  }

  return normalizedValue;
}

function getWikipediaAnalysisRecord(record: Record<string, unknown>) {
  const nestedData = record.data;

  if (isRecord(nestedData) && isRecord(nestedData.fullAnalysis)) {
    return nestedData.fullAnalysis;
  }

  if (isRecord(record.fullAnalysis)) {
    return record.fullAnalysis;
  }

  return null;
}

function buildWikipediaOpportunityEvidenceItems(record: Record<string, unknown>) {
  const evidenceItems: string[] = [];
  const wikipediaUrl = extractWikipediaOpportunityUrl(record);

  if (wikipediaUrl) {
    evidenceItems.push(`Wikipedia URL: ${wikipediaUrl}`);
  }

  const fullAnalysis = getWikipediaAnalysisRecord(record);

  if (!fullAnalysis) {
    return evidenceItems;
  }
  const company = getStringValue(fullAnalysis, ['company', 'name']);
  const citationCount = getNumberValue(fullAnalysis, ['citationCount']);
  const avgCitations = getNumberValue(fullAnalysis, ['avgCitations']);
  const sectionCount = getNumberValue(fullAnalysis, ['sectionCount']);
  const avgSections = getNumberValue(fullAnalysis, ['avgSections']);
  const imageCount = getNumberValue(fullAnalysis, ['imageCount']);
  const avgImages = getNumberValue(fullAnalysis, ['avgImages']);
  const categoryCount = getNumberValue(fullAnalysis, ['categoryCount']);
  const avgCategories = getNumberValue(fullAnalysis, ['avgCategories']);
  const wordCount = getNumberValue(fullAnalysis, ['contentLengthWords']);
  const lastEdited = getStringValue(fullAnalysis, ['lastEdited']);
  const editCount30Days = getNumberValue(fullAnalysis, ['editCount30Days']);
  const hasGoodArticle = fullAnalysis.hasGoodArticle;
  const hasFeaturedArticle = fullAnalysis.hasFeaturedArticle;
  const hasInfobox = fullAnalysis.hasInfobox;
  const hasNavbox = fullAnalysis.hasNavbox;
  const hasSeeAlso = fullAnalysis.hasSeeAlso;
  const hasExternalLinks = fullAnalysis.hasExternalLinks;
  const infoboxFields =
    isRecord(fullAnalysis.infoboxFields) ? fullAnalysis.infoboxFields : null;

  if (company) {
    evidenceItems.push(`Wikipedia company: ${company}`);
  }

  if (typeof citationCount === 'number') {
    evidenceItems.push(`Wikipedia citation count: ${citationCount}`);
  }

  if (typeof avgCitations === 'number') {
    evidenceItems.push(`Wikipedia industry average citations: ${avgCitations}`);
  }

  if (typeof sectionCount === 'number') {
    evidenceItems.push(`Wikipedia section count: ${sectionCount}`);
  }

  if (typeof avgSections === 'number') {
    evidenceItems.push(`Wikipedia industry average sections: ${avgSections}`);
  }

  if (typeof imageCount === 'number') {
    evidenceItems.push(`Wikipedia image count: ${imageCount}`);
  }

  if (typeof avgImages === 'number') {
    evidenceItems.push(`Wikipedia industry average images: ${avgImages}`);
  }

  if (typeof categoryCount === 'number') {
    evidenceItems.push(`Wikipedia category count: ${categoryCount}`);
  }

  if (typeof avgCategories === 'number') {
    evidenceItems.push(`Wikipedia industry average categories: ${avgCategories}`);
  }

  if (typeof wordCount === 'number') {
    evidenceItems.push(`Wikipedia word count: ${wordCount}`);
  }

  if (lastEdited) {
    evidenceItems.push(`Wikipedia last edited: ${lastEdited}`);
  }

  if (typeof editCount30Days === 'number') {
    evidenceItems.push(`Wikipedia edits in last 30 days: ${editCount30Days}`);
  }

  if (typeof hasInfobox === 'boolean') {
    evidenceItems.push(`Wikipedia has infobox: ${hasInfobox}`);
  }

  if (typeof hasNavbox === 'boolean') {
    evidenceItems.push(`Wikipedia has navigation box: ${hasNavbox}`);
  }

  if (typeof hasSeeAlso === 'boolean') {
    evidenceItems.push(`Wikipedia has See also section: ${hasSeeAlso}`);
  }

  if (typeof hasExternalLinks === 'boolean') {
    evidenceItems.push(`Wikipedia has External links section: ${hasExternalLinks}`);
  }

  if (typeof hasGoodArticle === 'boolean') {
    evidenceItems.push(`Wikipedia has Good Article status: ${hasGoodArticle}`);
  }

  if (typeof hasFeaturedArticle === 'boolean') {
    evidenceItems.push(`Wikipedia has Featured Article status: ${hasFeaturedArticle}`);
  }

  const maintenanceWarnings = getArrayValue(fullAnalysis, ['maintenanceWarnings'])
    .filter(isRecord)
    .flatMap((warning) => {
      const warningType = getStringValue(warning, ['type']) ?? 'warning';
      const warningText = getStringValue(warning, ['text']) ?? '';
      const normalizedWarningText = warningText.toLowerCase();
      const maintenanceScope = normalizedWarningText.startsWith('this section')
        ? 'section-level'
        : normalizedWarningText.startsWith('this article')
          ? 'article-level'
          : '';

      return warningText
        ? [
            `Wikipedia maintenance ${warningType}: ${warningText}`,
            maintenanceScope
              ? `Wikipedia maintenance scope: ${maintenanceScope}`
              : '',
          ].filter(Boolean)
        : [];
    })
    .filter(Boolean);

  evidenceItems.push(...maintenanceWarnings);

  const others = getArrayValue(fullAnalysis, ['others']).filter(isRecord);

  const buildBooleanPrevalenceEvidence = (
    label: string,
    selfValue: unknown,
    competitorKey: string,
  ) => {
    if (typeof selfValue === 'boolean') {
      evidenceItems.push(`Wikipedia ${label}: ${selfValue}`);
    }

    const competitorCount = others.length;

    if (competitorCount === 0) {
      return;
    }

    const matchingCompetitorCount = others.filter(
      (competitor) => typeof competitor[competitorKey] === 'boolean' && competitor[competitorKey] === true,
    ).length;
    const percentage = (matchingCompetitorCount / competitorCount) * 100;

    evidenceItems.push(
      `Wikipedia competitors with ${label}: ${matchingCompetitorCount} of ${competitorCount} (${formatMetricValue(
        percentage,
      )}%)`,
    );
  };

  buildBooleanPrevalenceEvidence('infobox', hasInfobox, 'hasInfobox');
  buildBooleanPrevalenceEvidence('navigation box', hasNavbox, 'hasNavbox');
  buildBooleanPrevalenceEvidence('See also section', hasSeeAlso, 'hasSeeAlso');
  buildBooleanPrevalenceEvidence(
    'External links section',
    hasExternalLinks,
    'hasExternalLinks',
  );

  if (others.length > 0) {
    evidenceItems.push(`Wikipedia competitors analyzed: ${others.length + 1}`);
  }

  if (infoboxFields) {
    const infoboxFieldNames = Object.keys(infoboxFields).map((fieldName) => fieldName.trim());

    evidenceItems.push(`Wikipedia infobox field count: ${infoboxFieldNames.length}`);

    if (infoboxFieldNames.length > 0) {
      evidenceItems.push(
        `Wikipedia infobox fields: ${infoboxFieldNames.join(', ')}`,
      );
    }

    const competitorInfoboxFieldCounts = new Map<string, number>();

    others.forEach((competitor) => {
      if (!isRecord(competitor.infoboxFields)) {
        return;
      }

      Object.keys(competitor.infoboxFields).forEach((fieldName) => {
        const normalizedFieldName = fieldName.trim();
        competitorInfoboxFieldCounts.set(
          normalizedFieldName,
          (competitorInfoboxFieldCounts.get(normalizedFieldName) ?? 0) + 1,
        );
      });
    });

    const competitorThreshold = Math.max(1, Math.ceil(others.length / 2));
    const commonCompetitorFields = Array.from(competitorInfoboxFieldCounts.entries())
      .filter(([, count]) => count >= competitorThreshold)
      .map(([fieldName]) => fieldName)
      .sort((leftField, rightField) => leftField.localeCompare(rightField));
    const missingCommonFields = commonCompetitorFields.filter(
      (fieldName) => !infoboxFieldNames.includes(fieldName),
    );

    evidenceItems.push(
      `Wikipedia common competitor infobox fields: ${
        commonCompetitorFields.length > 0
          ? commonCompetitorFields.join(', ')
          : 'none'
      }`,
    );
    evidenceItems.push(
      `Wikipedia missing common infobox fields: ${
        missingCommonFields.length > 0 ? missingCommonFields.join(', ') : 'none'
      }`,
    );
  }

  const companyLabel = company ?? 'Company';
  const buildMetricRankingEvidence = (
    label: string,
    selfValue: number | undefined,
    competitorKey: readonly string[],
    averageValue?: number,
  ) => {
    if (typeof selfValue !== 'number') {
      return;
    }

    const rankedValues = [
      { name: companyLabel, value: selfValue },
      ...others
        .map((competitor) => ({
          name: getStringValue(competitor, ['name']) ?? 'Unknown',
          value: getNumberValue(competitor, competitorKey),
        }))
        .filter(
          (entry): entry is { name: string; value: number } =>
            typeof entry.value === 'number',
        ),
    ].sort((leftEntry, rightEntry) => rightEntry.value - leftEntry.value);

    if (rankedValues.length === 0) {
      return;
    }

    // Match dense ranking semantics: rank is 1 + distinct higher values.
    const rank =
      new Set(
        rankedValues
          .filter((entry) => entry.value > selfValue)
          .map((entry) => entry.value),
      ).size + 1;
    evidenceItems.push(
      `Wikipedia ${label} rank: #${rank} of ${rankedValues.length}`,
    );

    if (rank === 1 && rankedValues.length > 1) {
      const secondPlace = rankedValues[1];
      evidenceItems.push(`Wikipedia second place ${label}: ${secondPlace.value}`);
      evidenceItems.push(
        `Wikipedia ${label} lead over second place: ${formatMetricValue(
          selfValue - secondPlace.value,
        )}`,
      );
    }

    if (typeof averageValue === 'number') {
      evidenceItems.push(
        `Wikipedia ${label} lead above average: ${formatMetricValue(
          selfValue - averageValue,
        )}`,
      );
    }

    evidenceItems.push(
      `Wikipedia ${label} comparison: ${rankedValues
        .map((entry) => `${entry.name}=${formatMetricValue(entry.value)}`)
        .join(', ')}`,
    );
  };

  buildMetricRankingEvidence(
    'citations',
    citationCount,
    ['citationCount'],
    avgCitations,
  );
  buildMetricRankingEvidence(
    'sections',
    sectionCount,
    ['sectionCount'],
    avgSections,
  );
  buildMetricRankingEvidence(
    'images',
    imageCount,
    ['imageCount'],
    avgImages,
  );
  buildMetricRankingEvidence(
    'categories',
    categoryCount,
    ['categoryCount'],
    avgCategories,
  );

  const competitorWordCounts = others
    .map((competitor) => getNumberValue(competitor, ['contentLengthWords']))
    .filter((value): value is number => typeof value === 'number');
  const avgWords =
    typeof wordCount === 'number' && competitorWordCounts.length > 0
      ? (wordCount + competitorWordCounts.reduce((sum, value) => sum + value, 0)) /
        (competitorWordCounts.length + 1)
      : undefined;

  buildMetricRankingEvidence(
    'word count',
    wordCount,
    ['contentLengthWords'],
    avgWords,
  );

  others.forEach((competitor) => {
    const competitorName = getStringValue(competitor, ['name']) ?? 'Unknown';
    const competitorUrl = getStringValue(competitor, ['url']) ?? '';
    const competitorCitationCount = getNumberValue(competitor, ['citationCount']);
    const competitorSectionCount = getNumberValue(competitor, ['sectionCount']);
    const competitorImageCount = getNumberValue(competitor, ['imageCount']);
    const competitorCategoryCount = getNumberValue(competitor, ['categoryCount']);
    const competitorWordCount = getNumberValue(competitor, ['contentLengthWords']);
    const competitorHasInfobox = competitor.hasInfobox;
    const competitorHasLeadImage = competitor.hasLeadImage;
    const competitorHasNavbox = competitor.hasNavbox;
    const competitorHasExternalLinks = competitor.hasExternalLinks;
    const competitorHasSeeAlso = competitor.hasSeeAlso;
    const parts = [
      `Wikipedia competitor: ${competitorName}`,
      competitorUrl ? `URL=${normalizeAbsoluteUrl(competitorUrl)}` : '',
      typeof competitorCitationCount === 'number'
        ? `citations=${competitorCitationCount}`
        : '',
      typeof competitorSectionCount === 'number'
        ? `sections=${competitorSectionCount}`
        : '',
      typeof competitorCategoryCount === 'number'
        ? `categories=${competitorCategoryCount}`
        : '',
      typeof competitorWordCount === 'number' ? `words=${competitorWordCount}` : '',
      typeof competitorImageCount === 'number' ? `images=${competitorImageCount}` : '',
      typeof competitorHasInfobox === 'boolean'
        ? `infobox=${competitorHasInfobox}`
        : '',
      typeof competitorHasLeadImage === 'boolean'
        ? `leadImage=${competitorHasLeadImage}`
        : '',
      typeof competitorHasNavbox === 'boolean' ? `navbox=${competitorHasNavbox}` : '',
      typeof competitorHasExternalLinks === 'boolean'
        ? `externalLinks=${competitorHasExternalLinks}`
        : '',
      typeof competitorHasSeeAlso === 'boolean'
        ? `seeAlso=${competitorHasSeeAlso}`
        : '',
    ].filter(Boolean);

    if (parts.length > 0) {
      evidenceItems.push(parts.join(' | '));
    }
  });

  return Array.from(new Set(evidenceItems));
}

function extractWikipediaOpportunityUrl(record: Record<string, unknown>) {
  const nestedData = record.data;
  const fullAnalysis = getWikipediaAnalysisRecord(record);
  const candidateValues = [
    getStringValue(record, ['wikipediaUrl', 'wikiUrl', 'pageUrl']),
    isRecord(nestedData)
      ? getStringValue(nestedData, ['wikipediaUrl', 'wikiUrl', 'pageUrl', 'url'])
      : undefined,
    fullAnalysis
      ? getStringValue(fullAnalysis, [
          'wikipediaUrl',
          'wikiUrl',
          'pageUrl',
          'pageURL',
          'url',
        ])
      : undefined,
  ];

  for (const value of candidateValues) {
    const normalizedWikipediaUrl = normalizeWikipediaUrlCandidate(value);

    if (normalizedWikipediaUrl) {
      return normalizedWikipediaUrl;
    }
  }

  return undefined;
}

function normalizeOpportunity(record: Record<string, unknown>, index: number) {
  const opportunityStatus =
    getStringValue(record, ['status', 'opportunityStatus'])?.trim().toLowerCase() ??
    '';

  const rawType =
    getStringValue(record, ['type', 'name', 'kind', 'category']) ?? '';
  const opportunityType =
    normalizeOpportunityType(rawType) ?? inferOpportunityType(record);

  if (!opportunityType) {
    return null;
  }

  if (!TARGET_OPPORTUNITY_TYPES.includes(opportunityType)) {
    return null;
  }

  const opportunityId =
    getStringValue(record, ['opportunityId', 'id', 'uuid']) ??
    `opportunity-${index + 1}`;
  const rawSuggestions = getOpportunitySuggestionRecords(record);
  const normalizedSuggestionPayloads = rawSuggestions
    .filter(isRecord)
    .map((suggestion, suggestionIndex) =>
      normalizeSuggestion(
        suggestion,
        suggestionIndex,
        opportunityType,
      ),
    )
    .filter(
      (value): value is NormalizedSuggestionPayload => value !== null,
    );
  const suggestions = normalizedSuggestionPayloads.flatMap(
    (payload) => payload.suggestions,
  );
  const legacySentimentItems = normalizedSuggestionPayloads.flatMap(
    (payload) => payload.sentimentItems,
  );
  const sentimentItems =
    legacySentimentItems.length === 0 &&
    SENTIMENT_TABLE_TYPES.has(opportunityType)
      ? extractAnalyticsInsightsSentimentItems(record)
      : legacySentimentItems;
  const opportunityEvidenceItems =
    opportunityType === 'Wikipedia'
      ? buildWikipediaOpportunityEvidenceItems(record)
      : SENTIMENT_TABLE_TYPES.has(opportunityType)
        ? extractAnalyticsInsightsTopicEvidence(record, opportunityType)
        : [];
  const suggestionsWithOpportunityEvidence = suggestions.map((suggestion) => ({
    ...suggestion,
    evidenceItems: Array.from(
      new Set([
        ...(suggestion.evidenceItems ?? []),
        ...opportunityEvidenceItems,
      ]),
    ),
  }));

  const normalizedOpportunity: OpportunityRecord = {
    opportunityId,
    opportunityType,
    opportunityStatus,
    rawType: rawType || opportunityType,
    wikipediaUrl:
      opportunityType === 'Wikipedia'
        ? extractWikipediaOpportunityUrl(record)
        : undefined,
    suggestions: suggestionsWithOpportunityEvidence,
    sentimentItems,
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

  const normalizedOpportunities = collection
    .map((record, index) => normalizeOpportunity(record, index))
    .filter((value): value is OpportunityRecord => value !== null);

  return normalizedOpportunities;
}

export function normalizeSuggestionCollection(
  responsePayload: unknown,
  opportunityType?: CanonicalOpportunityType,
) {
  const collection = extractCollection(responsePayload, SUGGESTION_KEYS);

  if (collection.length === 0) {
    if (isRecord(responsePayload)) {
      const directSuggestionId = getStringValue(responsePayload, [
        'suggestionId',
        'id',
        'uuid',
      ]);
      if (directSuggestionId) {
        const suggestions = normalizeSuggestion(
          responsePayload,
          0,
          opportunityType,
        );
        return suggestions ?? createEmptySuggestionPayload();
      }
    }

    return createEmptySuggestionPayload();
  }

  const suggestionPayloads = collection
    .map((record, index) =>
      normalizeSuggestion(record, index, opportunityType),
    )
    .filter((value): value is NormalizedSuggestionPayload => value !== null);

  return {
    suggestions: suggestionPayloads.flatMap((payload) => payload.suggestions),
    sentimentItems: suggestionPayloads.flatMap(
      (payload) => payload.sentimentItems,
    ),
  };
}

export function createIdleSiteResult(requestSite: string): SiteDashboardResult {
  return {
    requestSite,
    status: 'idle',
    statusMessage: 'Waiting for refresh',
    opportunityPresence: createEmptyOpportunityPresence(),
    opportunities: [],
  };
}

export function countSuggestions(opportunities: OpportunityRecord[]) {
  return opportunities.reduce(
    (count, opportunity) =>
      count +
      opportunity.suggestions.filter((suggestion) =>
        isCurrentSuggestionStatus(suggestion.status),
      ).length,
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
        if (!isCurrentSuggestionStatus(suggestion.status)) {
          return;
        }

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

  return normalizeMultilineText(value);
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
