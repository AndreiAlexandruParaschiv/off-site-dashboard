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

export type DerivedEvaluationVerdict =
  | 'Correct'
  | 'Incorrect'
  | 'Needs Review'
  | 'Not evaluated';

// Allowed slack between the backend's extracted target-brand share and the
// evaluator's recomputed share before we flag the SOV verdict as Incorrect.
// Stated as ABSOLUTE percentage points (so 10 means "60% vs 50% is fine").
// SOV is inherently fuzzy — different counting strategies (raw mentions,
// weighted by position, deduped per comment, etc.) can disagree by several
// points without either side being wrong, so we use a wide margin.
const SENTIMENT_SOV_TOLERANCE_POINTS = 10;

function normalizeDerivedComparableValue(value: string) {
  return (
    value
      // Strip leading emoji / special symbols (same pattern as getSentimentLabel in the UI).
      // SpaceCat API may return sentiments like "😐 Neutral" — without this the comparison
      // would see "😐 neutral" vs "neutral" and incorrectly produce an Incorrect verdict.
      .replace(/^[\p{Emoji_Presentation}\p{So}\uFE0F\s]+/u, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

function parsePercentageValue(value: string): number | null {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize a brand name for comparison (lowercase, alphanumeric only).
 */
function normalizeBrandKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract the target brand's percentage share from an extracted SOV string.
 *
 * Resolution order:
 *   1. If the target brand appears in a labeled segment ("Brand: XX%" or "Brand XX%"),
 *      return its percentage.
 *   2. If the SOV contains other brand-labeled segments but the target brand is
 *      absent from all of them, the target's share is genuinely 0% (the backend
 *      omits brands with zero mentions).
 *   3. Otherwise, fall back to the first number found in the string. This covers
 *      unlabeled inputs like "100%" or when no target brand is provided.
 *
 * Examples:
 *   extractTargetBrandSharePct("Sun Life: 60%, Manulife: 40%", "Manulife") → 40
 *   extractTargetBrandSharePct("Manulife: 100%", "Manulife") → 100
 *   extractTargetBrandSharePct("Sun Life: 60%, Other: 40%", "Manulife") → 0
 *   extractTargetBrandSharePct("Manulife: 100%", "") → 100 (fallback)
 *   extractTargetBrandSharePct("100%", "Manulife") → 100 (fallback)
 */
function extractTargetBrandSharePct(sovString: string, targetBrand: string): number | null {
  const normalizedTarget = targetBrand ? normalizeBrandKey(targetBrand) : '';
  let sawBrandLabeledSegment = false;

  if (normalizedTarget) {
    const lines = sovString.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

    for (const segment of lines) {
      const colonIdx = segment.indexOf(':');
      if (colonIdx !== -1) {
        sawBrandLabeledSegment = true;
        const leftPart = segment.slice(0, colonIdx).trim();
        const rightPart = segment.slice(colonIdx + 1).trim();
        const leftKey = normalizeBrandKey(leftPart);
        if (
          (leftKey.length > 0 && leftKey.includes(normalizedTarget)) ||
          (leftKey.length >= 4 && normalizedTarget.includes(leftKey))
        ) {
          const pct = parsePercentageValue(rightPart);
          if (pct !== null) {
            return pct;
          }
        }
        continue;
      }

      const percentMatch = segment.match(/(\d+(?:\.\d+)?)\s*%/);
      if (percentMatch) {
        const beforePct = segment.slice(0, segment.lastIndexOf(percentMatch[0]));
        const beforeKey = normalizeBrandKey(beforePct);
        if (beforeKey.length > 0) {
          sawBrandLabeledSegment = true;
          if (beforeKey.includes(normalizedTarget)) {
            return Number(percentMatch[1]);
          }
        }
      }
    }
  }

  // Brand-labeled SOV but target brand absent → target's share is 0%,
  // not the first competitor's share.
  if (normalizedTarget && sawBrandLabeledSegment) {
    return 0;
  }

  // Genuinely unlabeled SOV like "100%" — fall back to the first number.
  return parsePercentageValue(sovString);
}

function hasInsufficientFetchStatus(status?: string) {
  return status === 'fetch_failed' || status === 'insufficient_evidence';
}

export function deriveSentimentVerdict(input: {
  extractedSentiment: string;
  evaluationResult?: SentimentEvaluationResult;
  evaluationError?: string;
}): DerivedEvaluationVerdict {
  if (!input.evaluationResult && !input.evaluationError) {
    return 'Not evaluated';
  }

  if (input.evaluationError) {
    return 'Needs Review';
  }

  const result = input.evaluationResult;
  if (!result) {
    return 'Not evaluated';
  }

  const evaluatedValue = normalizeDerivedComparableValue(result.evaluatedSentiment);
  const extractedValue = normalizeDerivedComparableValue(input.extractedSentiment);

  if (evaluatedValue === 'needs review' || hasInsufficientFetchStatus(result.fetch.status)) {
    return 'Needs Review';
  }

  const evaluatedIsNoBrandMentions = evaluatedValue === 'no brand mentions';

  if (!extractedValue) {
    if (evaluatedIsNoBrandMentions) {
      return 'Correct';
    }
    if (evaluatedValue) {
      return 'Incorrect';
    }
    return 'Needs Review';
  }

  if (!evaluatedValue) {
    return 'Needs Review';
  }

  // Brand-owned source equivalence: a brand's own site / YouTube channel is
  // rarely overtly negative about its own brand, but it can legitimately read
  // as either "Favorable" (promotional / marketing) or "Neutral"
  // (informational / factual). The backend evaluator short-circuits these
  // sources to "Favorable", so a backend extraction of "Neutral" should NOT
  // be flagged Incorrect — both labels describe the same brand-owned content
  // accurately. This equivalence is one-way: "Unfavorable" or "No brand
  // mentions" on a brand-owned source remains a real disagreement.
  const isBrandOwned = result.fetch?.isBrandOwned === true;
  if (isBrandOwned) {
    const brandOwnedEquivalentLabels = new Set(['favorable', 'neutral']);
    if (
      brandOwnedEquivalentLabels.has(evaluatedValue) &&
      brandOwnedEquivalentLabels.has(extractedValue)
    ) {
      return 'Correct';
    }
  }

  return evaluatedValue === extractedValue ? 'Correct' : 'Incorrect';
}

export function deriveSovVerdict(input: {
  extractedSov: string;
  evaluationResult?: SentimentEvaluationResult;
  evaluationError?: string;
}): DerivedEvaluationVerdict {
  if (!input.evaluationResult && !input.evaluationError) {
    return 'Not evaluated';
  }

  if (input.evaluationError) {
    return 'Needs Review';
  }

  const result = input.evaluationResult;
  if (!result) {
    return 'Not evaluated';
  }

  if (
    normalizeDerivedComparableValue(result.evaluatedSov) === 'needs review' ||
    hasInsufficientFetchStatus(result.fetch.status)
  ) {
    return 'Needs Review';
  }

  const extractedPct = extractTargetBrandSharePct(input.extractedSov, result.targetBrand ?? '');
  const evaluatedPct =
    typeof result.evaluatedTargetBrandSharePct === 'number'
      ? result.evaluatedTargetBrandSharePct
      : parsePercentageValue(result.evaluatedSov);

  if (extractedPct === null) {
    if (evaluatedPct === null) {
      return 'Needs Review';
    }
    return evaluatedPct <= SENTIMENT_SOV_TOLERANCE_POINTS ? 'Correct' : 'Incorrect';
  }

  if (evaluatedPct === null) {
    return 'Needs Review';
  }

  return Math.abs(extractedPct - evaluatedPct) <= SENTIMENT_SOV_TOLERANCE_POINTS
    ? 'Correct'
    : 'Incorrect';
}

/**
 * Build a one-line note explaining the SOV margin calculation. Used by the UI
 * to surface "verdict was Correct because the gap fell inside the tolerance
 * window" in the Rationale / Evidence panel — so a reviewer who sees a Correct
 * verdict between mismatched percentages knows why it's still Correct.
 *
 * Returns null when there's nothing useful to surface (no evaluation yet,
 * unparseable percentages, or the values match exactly).
 */
export function describeSovToleranceMargin(input: {
  extractedSov: string;
  evaluationResult?: SentimentEvaluationResult;
}): string | null {
  const result = input.evaluationResult;
  if (!result) return null;
  if (hasInsufficientFetchStatus(result.fetch?.status)) return null;
  if (normalizeDerivedComparableValue(result.evaluatedSov) === 'needs review') return null;

  const extractedPct = extractTargetBrandSharePct(input.extractedSov, result.targetBrand ?? '');
  const evaluatedPct =
    typeof result.evaluatedTargetBrandSharePct === 'number'
      ? result.evaluatedTargetBrandSharePct
      : parsePercentageValue(result.evaluatedSov);

  if (extractedPct === null || evaluatedPct === null) return null;

  const delta = Math.abs(extractedPct - evaluatedPct);
  if (delta === 0) return null; // exact match — nothing to explain
  const within = delta <= SENTIMENT_SOV_TOLERANCE_POINTS;

  return (
    `SOV margin: backend ${extractedPct.toFixed(1)}% vs evaluator ${evaluatedPct.toFixed(1)}% ` +
    `(Δ ${delta.toFixed(1)}pt — ${within ? 'within' : 'outside'} ±${SENTIMENT_SOV_TOLERANCE_POINTS}pt tolerance).`
  );
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
    return 'High';
  }

  if (confidenceLevel === 'medium') {
    return 'Medium';
  }

  if (confidenceLevel === 'low') {
    return 'Low';
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
  competitors?: string[];
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
  const competitors =
    Array.isArray(input.competitors) && input.competitors.length > 0
      ? input.competitors.map((c) => c.trim()).filter(Boolean)
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
    ...(competitors ? { competitors } : {}),
  };
}
