import { SENTIMENT_EVALUATOR_VERSION } from './constants';
import type {
  CanonicalOpportunityType,
  SentimentEvaluationRequest,
  SentimentEvaluationResult,
  SentimentEvaluationStoredResult,
  SentimentEvaluationStore,
} from './types';

const SENTIMENT_EVALUATION_TYPES = new Set<CanonicalOpportunityType>([
  'Reddit',
  'YouTube',
  'Cited URLs',
]);
const URL_LIKE_PATTERN = /^https?:\/\//i;

function normalizeComparableItem(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return '';
  }

  if (URL_LIKE_PATTERN.test(trimmedValue)) {
    try {
      const url = new URL(trimmedValue);
      url.hash = '';
      return `${url.origin}${url.pathname}${url.search}`.toLowerCase();
    } catch {
      return trimmedValue.toLowerCase();
    }
  }

  return trimmedValue.replace(/\s+/g, ' ').toLowerCase();
}

export function isSentimentEvaluationType(
  value?: CanonicalOpportunityType,
): value is CanonicalOpportunityType {
  return value ? SENTIMENT_EVALUATION_TYPES.has(value) : false;
}

export function canEvaluateSentimentItem(item: string) {
  return URL_LIKE_PATTERN.test(item.trim());
}

export function buildSentimentRowKey(input: {
  site: string;
  siteId?: string;
  opportunityType: CanonicalOpportunityType;
  opportunityId: string;
  item: string;
}) {
  return [
    input.site.trim().toLowerCase(),
    input.siteId?.trim().toLowerCase() ?? '',
    input.opportunityType,
    input.opportunityId.trim().toLowerCase(),
    normalizeComparableItem(input.item),
  ].join('::');
}

export function createStoredSentimentEvaluation(
  rowKey: string,
  request: SentimentEvaluationRequest,
  result: SentimentEvaluationResult,
): SentimentEvaluationStoredResult {
  return {
    rowKey,
    extractedSentiment: request.extractedSentiment,
    extractedSov: request.extractedSov,
    ...result,
  };
}

export function createEmptySentimentEvaluationStore(): SentimentEvaluationStore {
  return {
    evaluatorVersion: SENTIMENT_EVALUATOR_VERSION,
    results: {},
  };
}

export function normalizeSentimentEvaluationStore(
  value: unknown,
): SentimentEvaluationStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptySentimentEvaluationStore();
  }

  const record = value as Partial<SentimentEvaluationStore>;

  if (record.evaluatorVersion !== SENTIMENT_EVALUATOR_VERSION) {
    return createEmptySentimentEvaluationStore();
  }

  const results =
    record.results && typeof record.results === 'object' && !Array.isArray(record.results)
      ? Object.entries(record.results).reduce<
          Record<string, SentimentEvaluationStoredResult>
        >((nextResults, [rowKey, result]) => {
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return nextResults;
          }

          const candidate = result as Partial<SentimentEvaluationStoredResult>;

          if (
            typeof candidate.rowKey !== 'string' ||
            typeof candidate.extractedSentiment !== 'string' ||
            typeof candidate.extractedSov !== 'string' ||
            typeof candidate.evaluatedSentiment !== 'string' ||
            typeof candidate.sentimentConfidence !== 'number' ||
            typeof candidate.evaluatedSov !== 'string' ||
            typeof candidate.sovConfidence !== 'number' ||
            typeof candidate.evaluatedTargetBrandSharePct !== 'number' ||
            typeof candidate.rationale !== 'string' ||
            typeof candidate.evidenceSnippet !== 'string' ||
            typeof candidate.evaluatedAt !== 'string' ||
            typeof candidate.evaluatorVersion !== 'string' ||
            !candidate.fetch ||
            typeof candidate.fetch !== 'object'
          ) {
            return nextResults;
          }

          nextResults[rowKey] = candidate as SentimentEvaluationStoredResult;
          return nextResults;
        }, {})
      : {};

  return {
    evaluatorVersion: SENTIMENT_EVALUATOR_VERSION,
    results,
  };
}

export function getConfidenceBand(score?: number) {
  const confidenceLevel = getConfidenceLevel(score);

  if (confidenceLevel === 'high') {
    return 'success';
  }

  if (confidenceLevel === 'medium') {
    return 'warning';
  }

  if (confidenceLevel === 'low') {
    return 'error';
  }

  return 'neutral';
}

export function getConfidenceLevel(score?: number) {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return 'unknown';
  }

  if (score >= 85) {
    return 'high';
  }

  if (score >= 60) {
    return 'medium';
  }

  return 'low';
}

export function getConfidenceLabel(score?: number) {
  const confidenceLevel = getConfidenceLevel(score);

  if (confidenceLevel === 'high') {
    return 'HIGH';
  }

  if (confidenceLevel === 'medium') {
    return 'MEDIUM';
  }

  if (confidenceLevel === 'low') {
    return 'LOW';
  }

  return '';
}

export function buildSentimentEvaluationRequest(input: {
  site: string;
  siteId?: string;
  opportunityType?: CanonicalOpportunityType;
  opportunityId?: string;
  item: string;
  title?: string;
  extractedSov: string;
  extractedSentiment: string;
  timesCited?: number;
}): SentimentEvaluationRequest | null {
  const opportunityId = input.opportunityId?.trim();

  if (
    !input.opportunityType ||
    !isSentimentEvaluationType(input.opportunityType) ||
    !opportunityId ||
    !canEvaluateSentimentItem(input.item)
  ) {
    return null;
  }

  const title = input.title?.trim();
  const timesCited =
    typeof input.timesCited === 'number' && Number.isFinite(input.timesCited)
      ? input.timesCited
      : undefined;

  return {
    site: input.site,
    siteId: input.siteId,
    opportunityType: input.opportunityType,
    opportunityId,
    item: input.item,
    ...(title ? { title } : {}),
    extractedSov: input.extractedSov,
    extractedSentiment: input.extractedSentiment,
    ...(typeof timesCited === 'number' ? { timesCited } : {}),
  };
}
