import { SUGGESTION_EVALUATOR_VERSION } from './constants';
import type {
  CanonicalOpportunityType,
  SuggestionEvaluationRequest,
  SuggestionEvaluationResult,
  SuggestionEvaluationStoredResult,
  SuggestionEvaluationStore,
} from './types';

const SUGGESTION_EVALUATION_TYPES = new Set<CanonicalOpportunityType>([
  'Reddit',
  'YouTube',
  'Cited URLs',
  'Wikipedia',
]);

function normalizeComparableSuggestionValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeFingerprintValue(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function isSuggestionEvaluationType(
  value?: CanonicalOpportunityType,
): value is CanonicalOpportunityType {
  return value ? SUGGESTION_EVALUATION_TYPES.has(value) : false;
}

export function canEvaluateSuggestionItem(value: string) {
  return Boolean(value.trim());
}

export function buildSuggestionRowKey(input: {
  site: string;
  siteId?: string;
  opportunityType: CanonicalOpportunityType;
  opportunityId: string;
  suggestionId?: string;
  suggestionText: string;
}) {
  return [
    input.site.trim().toLowerCase(),
    input.siteId?.trim().toLowerCase() ?? '',
    input.opportunityType,
    input.opportunityId.trim().toLowerCase(),
    input.suggestionId?.trim().toLowerCase() ??
      normalizeComparableSuggestionValue(input.suggestionText),
  ].join('::');
}

export function createStoredSuggestionEvaluation(
  rowKey: string,
  request: SuggestionEvaluationRequest,
  result: SuggestionEvaluationResult,
): SuggestionEvaluationStoredResult {
  return {
    rowKey,
    requestFingerprint: buildSuggestionEvaluationRequestFingerprint(request),
    suggestionText: request.suggestionText,
    suggestionUrl: request.suggestionUrl,
    ...result,
  };
}

export function createEmptySuggestionEvaluationStore(): SuggestionEvaluationStore {
  return {
    evaluatorVersion: SUGGESTION_EVALUATOR_VERSION,
    results: {},
  };
}

export function normalizeSuggestionEvaluationStore(
  value: unknown,
): SuggestionEvaluationStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptySuggestionEvaluationStore();
  }

  const record = value as Partial<SuggestionEvaluationStore>;

  if (record.evaluatorVersion !== SUGGESTION_EVALUATOR_VERSION) {
    return createEmptySuggestionEvaluationStore();
  }

  const results =
    record.results && typeof record.results === 'object' && !Array.isArray(record.results)
      ? Object.entries(record.results).reduce<
          Record<string, SuggestionEvaluationStoredResult>
        >((nextResults, [rowKey, result]) => {
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return nextResults;
          }

          const candidate = result as Partial<SuggestionEvaluationStoredResult>;

          if (
            typeof candidate.rowKey !== 'string' ||
            typeof candidate.requestFingerprint !== 'string' ||
            typeof candidate.suggestionText !== 'string' ||
            typeof candidate.verdict !== 'string' ||
            typeof candidate.confidence !== 'number' ||
            typeof candidate.rationale !== 'string' ||
            typeof candidate.evidenceSnippet !== 'string' ||
            typeof candidate.correctedSuggestion !== 'string' ||
            typeof candidate.evaluatedAt !== 'string' ||
            typeof candidate.evaluatorVersion !== 'string' ||
            !Array.isArray(candidate.evidenceSources)
          ) {
            return nextResults;
          }

          nextResults[rowKey] = candidate as SuggestionEvaluationStoredResult;
          return nextResults;
        }, {})
      : {};

  return {
    evaluatorVersion: SUGGESTION_EVALUATOR_VERSION,
    results,
  };
}

export function buildSuggestionEvaluationRequestFingerprint(
  request: SuggestionEvaluationRequest,
) {
  const normalizedEvidenceItems = request.evidenceItems
    .map((item) => normalizeFingerprintValue(item))
    .filter(Boolean)
    .sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
  const normalizedSentimentRows = request.sentimentRows
    .map((row) => ({
      item: normalizeFingerprintValue(row.item),
      title: normalizeFingerprintValue(row.title ?? ''),
      sov: normalizeFingerprintValue(row.sov),
      sentiment: normalizeFingerprintValue(row.sentiment),
      timesCited:
        typeof row.timesCited === 'number' && Number.isFinite(row.timesCited)
          ? row.timesCited
          : null,
    }))
    .sort((leftRow, rightRow) =>
      `${leftRow.item}::${leftRow.title}::${leftRow.sov}::${leftRow.sentiment}::${leftRow.timesCited}`.localeCompare(
        `${rightRow.item}::${rightRow.title}::${rightRow.sov}::${rightRow.sentiment}::${rightRow.timesCited}`,
      ),
    );

  return JSON.stringify({
    site: normalizeFingerprintValue(request.site).toLowerCase(),
    siteId: normalizeFingerprintValue(request.siteId ?? '').toLowerCase(),
    opportunityType: request.opportunityType,
    opportunityId: normalizeFingerprintValue(request.opportunityId).toLowerCase(),
    suggestionId: normalizeFingerprintValue(request.suggestionId ?? '').toLowerCase(),
    suggestionText: normalizeComparableSuggestionValue(request.suggestionText),
    suggestionUrl: normalizeFingerprintValue(request.suggestionUrl ?? ''),
    evidenceItems: normalizedEvidenceItems,
    sentimentRows: normalizedSentimentRows,
  });
}

export function buildSuggestionEvaluationRequest(input: {
  site: string;
  siteId?: string;
  opportunityType?: CanonicalOpportunityType;
  opportunityId?: string;
  suggestionId?: string;
  suggestionText: string;
  suggestionUrl?: string;
  evidenceItems: string[];
  sentimentRows: Array<{
    item: string;
    title?: string;
    sov: string;
    sentiment: string;
    timesCited?: number;
  }>;
}): SuggestionEvaluationRequest | null {
  const opportunityId = input.opportunityId?.trim();
  const suggestionText = input.suggestionText.trim();

  if (
    !input.opportunityType ||
    !isSuggestionEvaluationType(input.opportunityType) ||
    !opportunityId ||
    !canEvaluateSuggestionItem(suggestionText)
  ) {
    return null;
  }

  return {
    site: input.site,
    siteId: input.siteId,
    opportunityType: input.opportunityType,
    opportunityId,
    suggestionId: input.suggestionId?.trim() || undefined,
    suggestionText,
    suggestionUrl: input.suggestionUrl?.trim() || undefined,
    evidenceItems: input.evidenceItems,
    sentimentRows: input.sentimentRows
      .map((row) => {
        const title = row.title?.trim();
        return {
          item: row.item.trim(),
          ...(title ? { title } : {}),
          sov: row.sov.trim(),
          sentiment: row.sentiment.trim(),
          timesCited:
            typeof row.timesCited === 'number' && Number.isFinite(row.timesCited)
              ? row.timesCited
              : undefined,
        };
      })
      .filter((row) => row.item || row.title || row.sov || row.sentiment),
  };
}
