import { Fragment, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  evaluateWikipediaUrl,
  fetchSiteDashboardData,
  SpacecatApiError,
} from './api';
import { TARGET_OPPORTUNITY_TYPES } from './constants';
import {
  deriveSentimentVerdict,
  deriveSovVerdict,
  getConfidenceBand,
  getConfidenceLabel,
} from './evaluation';
import { useOffSiteDashboard } from './useOffSiteDashboard';
import {
  formatTimestamp,
  getStatusTone,
  normalizeApiBaseUrl,
  normalizeSiteInput,
  normalizeSiteList,
  trimSuggestionText,
} from './utils';
import type {
  GroupedSuggestionItem,
  GroupedOpportunityRow,
  OpportunityPresenceState,
  SentimentItemRecord,
  SentimentEvaluationFetchMetadata,
  SiteDashboardResult,
  SiteOpportunityPresence,
  SuggestionEvaluationResult,
  WikipediaUrlEvaluationVerdict,
} from './types';

const SENTIMENT_OPPORTUNITY_TYPES = new Set<string>([
  'Reddit',
  'YouTube',
  'Cited URLs',
]);

function getAllowedEvaluationOpportunityTypes() {
  return SENTIMENT_OPPORTUNITY_TYPES;
}

function filterEvaluationOpportunityRows(rows: GroupedOpportunityRow[]) {
  const allowedTypes = getAllowedEvaluationOpportunityTypes();

  return rows.filter(
    (row) => row.opportunityType && allowedTypes.has(row.opportunityType),
  );
}

type EvaluationRowEntry = {
  id: string;
  site: string;
  siteId?: string;
  opportunityType: string;
  opportunityId: string;
  item: SentimentItemRecord;
};

type SuggestionEvaluationRowEntry = {
  id: string;
  site: string;
  siteId?: string;
  opportunityType: string;
  opportunityId: string;
  suggestion: GroupedSuggestionItem;
};

function StatsCard(props: { label: string; value: string; detail?: string }) {
  return (
    <article className="stats-card">
      <div className="stats-card-copy">
        <span className="stats-label">{props.label}</span>
        {props.detail ? <span className="stats-detail">{props.detail}</span> : null}
      </div>
      <strong className="stats-value">{props.value}</strong>
    </article>
  );
}

function HeroSignal(props: {
  label: string;
  value: string;
  tone?: 'accent' | 'warm' | 'neutral';
}) {
  return (
    <div className={`hero-signal hero-signal-${props.tone ?? 'neutral'}`}>
      <span className="hero-signal-label">{props.label}</span>
      <strong className="hero-signal-value">{props.value}</strong>
    </div>
  );
}

function PanelToggleButton(props: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="ghost-button panel-toggle-button"
      onClick={props.onClick}
      type="button"
      aria-expanded={props.expanded}
    >
      <span>{props.expanded ? 'Collapse' : 'Expand'}</span>
      <svg
        className={`panel-toggle-icon ${props.expanded ? '' : 'panel-toggle-icon-collapsed'}`}
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 12.5L10 7.5L15 12.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function SiteCard(props: {
  site: SiteDashboardResult;
  onRefresh: (site: string) => void;
}) {
  const statusTone = getStatusTone(props.site.status);
  const badgeLabel =
    props.site.status === 'loading'
      ? 'Loading'
      : props.site.status === 'success'
        ? 'Synced'
        : props.site.status === 'error'
          ? 'Needs attention'
          : 'Idle';

  return (
    <article className="site-card">
      <div className="site-card-header">
        <div>
          <h3 className="site-card-title">{props.site.requestSite}</h3>
          <p className="site-card-subtitle">
            Site ID: {props.site.siteId ?? 'Not resolved yet'}
          </p>
        </div>
        <button
          className="ghost-button"
          onClick={() => props.onRefresh(props.site.requestSite)}
          type="button"
        >
          Refresh
        </button>
      </div>

      <div className="site-card-meta">
        <span className={`status-pill status-pill-${statusTone}`}>{badgeLabel}</span>
        <span className="site-card-updated">
          Last updated: {formatTimestamp(props.site.lastUpdated)}
        </span>
      </div>

      <p className="site-card-message">{props.site.statusMessage}</p>

      {props.site.resolvedSiteUrl && (
        <p className="site-card-secondary">
          Lookup matched: <strong>{props.site.resolvedSiteUrl}</strong>
        </p>
      )}

      {props.site.error && <p className="site-card-error">{props.site.error}</p>}
    </article>
  );
}

function FilterChip(props: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`chip-button ${props.active ? 'chip-button-active' : ''}`}
      onClick={props.onClick}
      type="button"
      aria-pressed={props.active}
    >
      <span>{props.label}</span>
      {typeof props.count === 'number' && (
        <span className="chip-count">{props.count}</span>
      )}
    </button>
  );
}

function getSentimentTone(value?: string) {
  const normalizedValue = value?.trim().toLowerCase() ?? '';

  if (normalizedValue.includes('unfavorable')) {
    return 'error';
  }

  if (normalizedValue.includes('favorable')) {
    return 'success';
  }

  if (normalizedValue.includes('neutral')) {
    return 'warning';
  }

  return 'neutral';
}

function getSentimentLabel(value?: string) {
  return (value ?? '').replace(/^[\p{Emoji_Presentation}\p{So}\uFE0F\s]+/u, '').trim();
}

const MISSING_EXTRACTED_SENTIMENT_TOOLTIP =
  'Backend did not extract a sentiment for this source';

function getDisplayUrl(value: string) {
  return value.replace(/^https?:\/\//i, '');
}

/**
 * SpaceCat can inject generic placeholder tokens into the extracted SOV
 * (e.g. "ProductA 12.5%, CompetitorY 37.5%"). These are not real brands
 * and must be hidden from the display.
 */
const PLACEHOLDER_BRAND_RE = /^(product|competitor|brand)[a-z0-9]{0,3}$/i;
const IGNORABLE_BRAND_RE = /^(market|others?)\b/i;

function isDisplayableSovBrand(brand: string) {
  const t = brand.trim();
  return t.length > 0 && !PLACEHOLDER_BRAND_RE.test(t) && !IGNORABLE_BRAND_RE.test(t);
}

/**
 * Parse a raw SOV string into individual brand/percentage pairs.
 *
 * Handles three formats the backend can produce:
 *   "Land Rover USA: 100.0%"
 *   "Land Rover USA: 88.9% · Market: Jeep 11.1%"
 *   "· Market: Jeep 27.6%, Chevrolet Tahoe 17.2%, Honda CR-V 6.9%"
 */
function parseSovEntries(raw: string): Array<{ brand: string; pct: string }> {
  const results: Array<{ brand: string; pct: string }> = [];
  const segments = raw
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const colonIdx = segment.indexOf(':');
    if (colonIdx === -1) {
      // "Brand XX%" with no colon
      const m = segment.match(/^(.+?)\s+([\d]+(?:\.\d+)?%)/);
      if (m) results.push({ brand: m[1].trim(), pct: m[2] });
      else results.push({ brand: segment, pct: '' });
      continue;
    }

    const label = segment.slice(0, colonIdx).trim();
    const rest = segment.slice(colonIdx + 1).trim();

    if (rest.includes(',')) {
      // "Category: Brand1 XX%, Brand2 YY%, ..." — split on commas
      for (const item of rest.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = item.match(/^(.+?)\s+([\d]+(?:\.\d+)?%)/);
        if (m) results.push({ brand: m[1].trim(), pct: m[2] });
        else results.push({ brand: item, pct: '' });
      }
    } else if (/^[\d]+(?:\.\d+)?%/.test(rest)) {
      // "Brand: 100.0%" — label is the brand name
      results.push({ brand: label, pct: rest.match(/([\d]+(?:\.\d+)?%)/)![1] });
    } else {
      // "Category: BrandName XX%" — brand name is in the rest
      const m = rest.match(/^(.+?)\s+([\d]+(?:\.\d+)?%)/);
      if (m) results.push({ brand: m[1].trim(), pct: m[2] });
      else results.push({ brand: label, pct: rest });
    }
  }

  // Strip placeholder / ignorable tokens (Market, Others, ProductA, CompetitorY …)
  return results.filter((e) => isDisplayableSovBrand(e.brand));
}

function SovLabel({ value, targetBrand }: { value?: string; targetBrand?: string }) {
  const raw = trimSuggestionText(value ?? '');
  if (!raw) return <span className="sov-empty-dash">—</span>;

  const entries = parseSovEntries(raw);
  if (entries.length === 0) return <span className="sov-empty-dash">—</span>;

  const normTarget = targetBrand
    ? targetBrand.toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';

  return (
    <div className="sov-card">
      {entries.map((entry, i) => {
        const normBrand = entry.brand.toLowerCase().replace(/[^a-z0-9]/g, '');
        const isTarget =
          normTarget.length >= 3 &&
          (normBrand.includes(normTarget) || normTarget.includes(normBrand));
        return (
          <div key={i} className={`sov-row${isTarget ? ' sov-row-target' : ''}`}>
            <span className="sov-brand-name">{entry.brand}</span>
            {entry.pct && <span className="sov-pct">{entry.pct}</span>}
          </div>
        );
      })}
    </div>
  );
}

function normalizeSentimentValue(value?: string) {
  const normalizedValue = value?.trim().toLowerCase() ?? '';

  if (normalizedValue.includes('no brand')) {
    return 'no_brand_mentions';
  }

  if (normalizedValue.includes('unfavorable')) {
    return 'unfavorable';
  }

  if (normalizedValue.includes('favorable')) {
    return 'favorable';
  }

  if (normalizedValue.includes('neutral')) {
    return 'neutral';
  }

  if (normalizedValue.includes('review')) {
    return 'needs_review';
  }

  return 'unknown';
}

function isConfirmedSentimentEvaluation(input: {
  extractedSentiment: string;
  evaluatedSentiment: string;
  sentimentConfidence: number;
}) {
  const extractedSentiment = normalizeSentimentValue(input.extractedSentiment);
  const evaluatedSentiment = normalizeSentimentValue(input.evaluatedSentiment);

  return (
    evaluatedSentiment !== 'needs_review' &&
    extractedSentiment !== 'unknown' &&
    extractedSentiment === evaluatedSentiment &&
    getConfidenceLabel(input.sentimentConfidence) !== 'Low'
  );
}

function normalizeSovValue(value?: string) {
  const normalizedValue = value?.trim().toLowerCase() ?? '';

  if (normalizedValue.includes('review')) {
    return 'needs_review';
  }

  if (normalizedValue.includes('no brand')) {
    return 'no_brand_mentions';
  }

  if (normalizedValue.includes('%')) {
    return 'percentage';
  }

  return 'unknown';
}

function isConfirmedSovEvaluation(input: {
  evaluatedSov: string;
  sovConfidence: number;
}) {
  return (
    normalizeSovValue(input.evaluatedSov) !== 'needs_review' &&
    getConfidenceLabel(input.sovConfidence) !== 'Low'
  );
}

function normalizeSuggestionVerdict(value?: string) {
  const normalizedValue = value?.trim().toLowerCase() ?? '';

  if (normalizedValue.includes('incorrect')) {
    return 'incorrect';
  }

  if (normalizedValue.includes('correct')) {
    return 'correct';
  }

  if (normalizedValue.includes('review')) {
    return 'needs_review';
  }

  return 'unknown';
}

function getSuggestionVerdictTone(value?: string) {
  const normalizedValue = normalizeSuggestionVerdict(value);

  if (normalizedValue === 'correct') {
    return 'success';
  }

  if (normalizedValue === 'incorrect') {
    return 'error';
  }

  if (normalizedValue === 'needs_review') {
    return 'warning';
  }

  return 'neutral';
}

function isConfirmedSuggestionEvaluation(input: {
  verdict: string;
  confidence: number;
}) {
  return (
    normalizeSuggestionVerdict(input.verdict) === 'correct' &&
    getConfidenceLabel(input.confidence) !== 'Low'
  );
}

function getSuggestionEvaluationSourceUrls(
  evaluationResult?: SuggestionEvaluationResult,
) {
  if (!evaluationResult) {
    return [];
  }

  return Array.from(
    new Set(
      evaluationResult.evidenceSources
        .map((source) => source.sourceUrl.trim())
        .filter(Boolean),
    ),
  );
}

function getEvaluationEvidenceContextLines(
  fetch?: SentimentEvaluationFetchMetadata,
) {
  if (!fetch) {
    return [] as string[];
  }

  if (fetch.sourceType === 'youtube') {
    if (fetch.isBrandOwned) {
      const lines = ['Evidence source: brand channel'];
      if (fetch.usedComments) {
        lines.push('Viewer comments included for context.');
      }
      return lines;
    }

    if (fetch.usedTranscript) {
      return [fetch.usedComments ? 'Evidence source: transcript + comments' : 'Evidence source: transcript/captions'];
    }

    const lines = [fetch.usedComments ? 'Evidence source: metadata + comments' : 'Evidence source: metadata only'];

    if (
      fetch.transcriptStatus === 'available_but_not_used' ||
      fetch.transcriptStatus === 'not_available' ||
      fetch.transcriptStatus === 'unknown'
    ) {
      lines.push('No usable transcript/captions were available for this clip.');
    }

    return lines;
  }

  if (fetch.sourceType === 'reddit') {
    return [
      fetch.usedComments
        ? 'Evidence source: Reddit thread + comments'
        : 'Evidence source: Reddit thread',
    ];
  }

  if (fetch.isBrandOwned) {
    return ['Evidence source: brand site'];
  }

  return ['Evidence source: web page'];
}

function getEvaluatedAtSortValue(value?: string) {
  if (!value) {
    return null;
  }

  const parsedValue = Date.parse(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function compareEvaluationSortOrder(
  leftEvaluatedAt?: string,
  rightEvaluatedAt?: string,
) {
  const leftTimestamp = getEvaluatedAtSortValue(leftEvaluatedAt);
  const rightTimestamp = getEvaluatedAtSortValue(rightEvaluatedAt);

  if (leftTimestamp !== null && rightTimestamp !== null) {
    return rightTimestamp - leftTimestamp;
  }

  if (leftTimestamp !== null) {
    return -1;
  }

  if (rightTimestamp !== null) {
    return 1;
  }

  return 0;
}

type EvaluationSortColumn = 'confidence' | 'verdict';
type EvaluationSortState = {
  column: EvaluationSortColumn;
  direction: 'asc' | 'desc';
} | null;
type EvaluationVariant = 'sentiment' | 'sov';

function getEvaluationSortKeys(
  item: SentimentItemRecord,
  variant: EvaluationVariant,
) {
  const result = item.evaluationResult;
  if (variant === 'sov') {
    return {
      confidence:
        typeof result?.sovConfidence === 'number' ? result.sovConfidence : -1,
      verdictRank: getVerdictSortRank(
        deriveSovVerdict({
          extractedSov: item.sov,
          evaluationResult: result,
          evaluationError: item.evaluationError,
        }),
      ),
    };
  }
  return {
    confidence:
      typeof result?.sentimentConfidence === 'number'
        ? result.sentimentConfidence
        : -1,
    verdictRank: getVerdictSortRank(
      deriveSentimentVerdict({
        extractedSentiment: item.sentiment,
        evaluationResult: result,
        evaluationError: item.evaluationError,
      }),
    ),
  };
}

function buildEvaluationRows(
  rows: GroupedOpportunityRow[],
  sortState?: EvaluationSortState,
  variant: EvaluationVariant = 'sentiment',
): EvaluationRowEntry[] {
  return filterEvaluationOpportunityRows(rows)
    .flatMap((row) =>
      row.sentimentItems.map((item, index) => ({
        id: item.rowKey ?? `${row.id}-evaluation-${index}`,
        site: row.site,
        siteId: row.siteId,
        opportunityType: row.opportunityType ?? ' - ',
        opportunityId: row.opportunityId ?? ' - ',
        item,
      })),
    )
    .sort((leftRow, rightRow) => {
      if (sortState) {
        const direction = sortState.direction === 'desc' ? -1 : 1;
        const leftKeys = getEvaluationSortKeys(leftRow.item, variant);
        const rightKeys = getEvaluationSortKeys(rightRow.item, variant);
        let columnOrder = 0;

        if (sortState.column === 'confidence') {
          columnOrder = (leftKeys.confidence - rightKeys.confidence) * direction;
        } else if (sortState.column === 'verdict') {
          columnOrder = (leftKeys.verdictRank - rightKeys.verdictRank) * direction;
        }

        if (columnOrder !== 0) {
          return columnOrder;
        }
      }

      const evaluatedAtOrder = compareEvaluationSortOrder(
        leftRow.item.evaluationResult?.evaluatedAt,
        rightRow.item.evaluationResult?.evaluatedAt,
      );

      if (evaluatedAtOrder !== 0) {
        return evaluatedAtOrder;
      }

      return leftRow.id.localeCompare(rightRow.id);
    });
}

type SuggestionEvaluationSortColumn = EvaluationSortColumn;
type SuggestionEvaluationSortState = EvaluationSortState;

const VERDICT_SORT_RANK: Record<string, number> = {
  correct: 3,
  incorrect: 2,
  needs_review: 1,
  unknown: 0,
};

function getVerdictSortRank(verdict?: string) {
  return VERDICT_SORT_RANK[normalizeSuggestionVerdict(verdict)] ?? 0;
}

function buildSuggestionEvaluationRows(
  rows: GroupedOpportunityRow[],
  sortState?: SuggestionEvaluationSortState,
): SuggestionEvaluationRowEntry[] {
  return rows.flatMap((row) =>
    row.suggestions.map((suggestion, index) => ({
      id: suggestion.rowKey ?? `${row.id}-suggestion-evaluation-${index}`,
      site: row.site,
      siteId: row.siteId,
      opportunityType: row.opportunityType ?? ' - ',
      opportunityId: row.opportunityId ?? ' - ',
      suggestion,
    })),
  )
    .sort((leftRow, rightRow) => {
      if (sortState) {
        const direction = sortState.direction === 'desc' ? -1 : 1;
        let columnOrder = 0;

        if (sortState.column === 'confidence') {
          const leftScore = leftRow.suggestion.evaluationResult?.confidence ?? -1;
          const rightScore = rightRow.suggestion.evaluationResult?.confidence ?? -1;
          columnOrder = (leftScore - rightScore) * direction;
        } else if (sortState.column === 'verdict') {
          const leftRank = getVerdictSortRank(
            leftRow.suggestion.evaluationResult?.verdict,
          );
          const rightRank = getVerdictSortRank(
            rightRow.suggestion.evaluationResult?.verdict,
          );
          columnOrder = (leftRank - rightRank) * direction;
        }

        if (columnOrder !== 0) {
          return columnOrder;
        }
      }

      const evaluatedAtOrder = compareEvaluationSortOrder(
        leftRow.suggestion.evaluationResult?.evaluatedAt,
        rightRow.suggestion.evaluationResult?.evaluatedAt,
      );

      if (evaluatedAtOrder !== 0) {
        return evaluatedAtOrder;
      }

      return leftRow.id.localeCompare(rightRow.id);
    });
}

function getPresenceDetails(value: OpportunityPresenceState) {
  if (value === 'exists_new_ignored') {
    return {
      className: 'presence-pill-yes',
      label: 'Exists',
      detail: 'Active + Ignored',
      title:
        'Both new and ignored opportunities were found for this type. The current/new one is used by default.',
    };
  }

  if (value === 'exists_mixed') {
    return {
      className: 'presence-pill-yes',
      label: 'Exists',
      detail: 'Active + Ignored',
      title:
        'Both active and ignored opportunities were found for this type. The active one is used by default.',
    };
  }

  if (value === 'exists_ignored_only') {
    return {
      className: 'presence-pill-yes',
      label: 'Exists',
      detail: 'Ignored',
      title: 'Only ignored opportunities were found for this type.',
    };
  }

  if (value === 'exists') {
    return {
      className: 'presence-pill-yes',
      label: 'Exists',
      title: 'At least one opportunity was found for this type.',
    };
  }

  return {
    className: 'presence-pill-no',
    label: 'Missing',
    title: 'No opportunities were found for this type.',
  };
}

function CoverageTable(props: { rows: SiteOpportunityPresence[] }) {
  if (props.rows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No sites configured</h3>
        <p>Add one or more site URLs to see per-site opportunity coverage.</p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="dashboard-table coverage-table">
        <thead>
          <tr>
            <th>Site</th>
            {TARGET_OPPORTUNITY_TYPES.map((type) => (
              <th key={type}>{type}</th>
            ))}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.site}>
              <td>
                <div className="coverage-site-cell">
                  <span className="coverage-site-name">{row.site}</span>
                  <span className="coverage-site-id">
                    Site ID: {row.siteId ?? 'Not resolved yet'}
                  </span>
                </div>
              </td>
              {TARGET_OPPORTUNITY_TYPES.map((type) => {
                const presence = getPresenceDetails(row.presence[type]);

                return (
                  <td key={`${row.site}-${type}`}>
                    <div className="presence-cell">
                      <span
                        className={`presence-pill ${presence.className}`}
                        title={presence.title}
                      >
                        {presence.label}
                      </span>
                      {presence.detail ? (
                        <span className="presence-detail">{presence.detail}</span>
                      ) : null}
                    </div>
                  </td>
                );
              })}
              <td>{row.statusMessage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionsTable(props: { rows: GroupedOpportunityRow[] }) {
  const [expandedSuggestionKeys, setExpandedSuggestionKeys] = useState<string[]>([]);

  if (props.rows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No suggestion rows match the current filters</h3>
        <p>
          Keep all opportunity types selected or refresh the configured sites to
          load new suggestions.
        </p>
      </div>
    );
  }

  const toggleSuggestion = (suggestionKey: string) => {
    setExpandedSuggestionKeys((currentKeys) =>
      currentKeys.includes(suggestionKey)
        ? currentKeys.filter((currentKey) => currentKey !== suggestionKey)
        : [...currentKeys, suggestionKey],
    );
  };

  return (
    <div className="table-wrapper">
      <table className="dashboard-table suggestions-table">
        <colgroup>
          <col className="suggestions-col-site" />
          <col className="suggestions-col-type" />
          <col className="suggestions-col-opportunity-id" />
          <col className="suggestions-col-suggestions" />
        </colgroup>
        <thead>
          <tr>
            <th>Site</th>
            <th>Opportunity</th>
            <th>Opportunity ID</th>
            <th>Suggestions</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.id}>
              <td>
                <div className="sentiment-site-cell">
                  <span className="sentiment-site-name">{row.site}</span>
                  {row.siteId && (
                    <span className="sentiment-site-id">{row.siteId}</span>
                  )}
                </div>
              </td>
              <td>{row.opportunityType ?? ' - '}</td>
              <td>{row.opportunityId ?? ' - '}</td>
              <td>
                {row.suggestions.length === 0 ? (
                  'No suggestions returned'
                ) : (
                  <ul className="suggestion-list">
                    {row.suggestions.map((suggestion, index) => {
                      const suggestionText = trimSuggestionText(
                        suggestion.suggestionText,
                      );
                      const suggestionKey = `${row.id}-${suggestion.suggestionId ?? index}`;
                      const suggestionLines = suggestionText
                        ? suggestionText.split('\n')
                        : [];
                      const suggestionHeading =
                        suggestionLines.length > 1 ? suggestionLines[0] : '';
                      const suggestionBody =
                        suggestionLines.length > 1
                          ? suggestionLines.slice(1).join('\n')
                          : suggestionText;
                      const suggestionPreview = (
                        suggestionHeading || suggestionBody || ' - '
                      ).replace(/\s+/g, ' ').trim();
                      const normalizedHeading = suggestionHeading
                        .replace(/\s+/g, ' ')
                        .trim();
                      const normalizedBody = suggestionBody.replace(/\s+/g, ' ').trim();
                      const hasExpandableBody = Boolean(
                        normalizedHeading &&
                          normalizedBody &&
                          normalizedBody !== normalizedHeading,
                      );
                      const isExpanded = expandedSuggestionKeys.includes(suggestionKey);

                      return (
                        <li
                          className={`suggestion-list-item ${isExpanded ? 'suggestion-list-item-expanded' : ''}`}
                          key={suggestionKey}
                        >
                          <div className="suggestion-list-item-header">
                            <div className="suggestion-list-item-title-block">
                              {suggestion.suggestionId && (
                                <span className="suggestion-meta-id">
                                  {suggestion.suggestionId}
                                </span>
                              )}
                              <strong className="suggestion-heading">
                                {suggestionPreview}
                              </strong>
                            </div>
                            {hasExpandableBody ? (
                              <button
                                className="ghost-button suggestion-item-toggle"
                                onClick={() => toggleSuggestion(suggestionKey)}
                                type="button"
                                aria-expanded={isExpanded}
                              >
                                {isExpanded ? 'Hide' : 'Show'}
                              </button>
                            ) : null}
                          </div>
                          {hasExpandableBody && isExpanded && (
                            <div className="suggestion-list-item-body">
                              <span className="suggestion-copy">
                                {suggestionBody || ' - '}
                              </span>
                              {suggestion.suggestionUrl && (
                                <a
                                  className="suggestion-link"
                                  href={suggestion.suggestionUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open link
                                </a>
                              )}
                            </div>
                          )}
                          {!hasExpandableBody && suggestion.suggestionUrl && (
                            <a
                              className="suggestion-link"
                              href={suggestion.suggestionUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open link
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SentimentTable(props: { rows: GroupedOpportunityRow[] }) {
  const sentimentRows = props.rows.filter(
    (row) => row.opportunityType && SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType),
  );

  if (sentimentRows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No sentiment opportunities match the current filters</h3>
        <p>
          Refresh the filtered sites to load URL, share of voice, and sentiment
          coverage.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="dashboard-table sentiment-table">
        <colgroup>
          <col className="sentiment-col-site" />
          <col className="sentiment-col-type" />
          <col className="sentiment-col-opportunity-id" />
          <col className="sentiment-col-url" />
          <col className="sentiment-col-sov" />
          <col className="sentiment-col-sentiment" />
        </colgroup>
        <thead>
          <tr>
            <th>Site</th>
            <th>Opportunity</th>
            <th>Opportunity ID</th>
            <th>URL</th>
            <th>Share of Voice</th>
            <th>Sentiment</th>
          </tr>
        </thead>
        <tbody>
          {sentimentRows.flatMap((row) => {
            if (row.sentimentItems.length === 0) {
              return (
                <tr key={`${row.id}-sentiment-empty`}>
                  <td>
                    <div className="sentiment-site-cell">
                      <span className="sentiment-site-name">{row.site}</span>
                      {row.siteId && (
                        <span className="sentiment-site-id">{row.siteId}</span>
                      )}
                    </div>
                  </td>
                  <td>{row.opportunityType ?? ' - '}</td>
                  <td>{row.opportunityId ?? ' - '}</td>
                  <td>
                    <span className="metric-copy metric-card" title={row.status}>
                      No URL / Share of Voice / sentiment rows returned
                    </span>
                  </td>
                  <td>
                    <span className="metric-copy metric-card"> - </span>
                  </td>
                  <td>
                    <span className="metric-copy metric-card"> - </span>
                  </td>
                </tr>
              );
            }

            return row.sentimentItems.map((item, index) => {
              const itemValue = trimSuggestionText(item.item);
              const isUrl = /^https?:\/\//i.test(itemValue);
              const rowSpan = row.sentimentItems.length;

              return (
                <tr key={item.rowKey ?? `${row.id}-sentiment-${index}`}>
                  {index === 0 && (
                    <>
                      <td rowSpan={rowSpan}>
                        <div className="sentiment-site-cell">
                          <span className="sentiment-site-name">{row.site}</span>
                          {row.siteId && (
                            <span className="sentiment-site-id">{row.siteId}</span>
                          )}
                        </div>
                      </td>
                      <td rowSpan={rowSpan}>{row.opportunityType ?? ' - '}</td>
                      <td rowSpan={rowSpan}>{row.opportunityId ?? ' - '}</td>
                    </>
                  )}
                  <td>
                    {isUrl ? (
                      <a
                        className="metric-link metric-card"
                        href={itemValue}
                        target="_blank"
                        rel="noreferrer"
                        title={itemValue}
                      >
                        {getDisplayUrl(itemValue)}
                      </a>
                    ) : (
                      <span className="metric-copy metric-card" title={itemValue}>
                        {itemValue || ' - '}
                      </span>
                    )}
                  </td>
                  <td>
                    <SovLabel
                      value={item.sov}
                      targetBrand={item.evaluationResult?.targetBrand ?? undefined}
                    />
                  </td>
                  <td>
                    {(() => {
                      const sentimentLabel = getSentimentLabel(item.sentiment);
                      const displayLabel = trimSuggestionText(sentimentLabel);
                      const hasLabel = displayLabel.length > 0;
                      const capitalizedLabel = hasLabel
                        ? displayLabel.charAt(0).toUpperCase() + displayLabel.slice(1)
                        : '—';

                      return (
                        <span
                          className={`status-pill status-pill-${getSentimentTone(
                            item.sentiment,
                          )}`}
                          title={hasLabel ? sentimentLabel : MISSING_EXTRACTED_SENTIMENT_TOOLTIP}
                        >
                          {capitalizedLabel}
                        </span>
                      );
                    })()}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionEvaluationTable(props: {
  rows: GroupedOpportunityRow[];
  selectedRowKeys: string[];
  onToggleRowSelection: (rowKey: string) => void;
  onSelectRows: (rowKeys: string[], selected: boolean) => void;
  onEvaluateRow: (rowKey: string) => void;
  isEvaluating: boolean;
}) {
  const [sortState, setSortState] = useState<SuggestionEvaluationSortState>(null);
  const evaluationRows = buildSuggestionEvaluationRows(props.rows, sortState);
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
  const visibleEvaluableRowKeys = evaluationRows
    .filter((row) => row.suggestion.canEvaluate && row.suggestion.rowKey)
    .map((row) => row.suggestion.rowKey as string);
  const selectedVisibleRowCount = visibleEvaluableRowKeys.filter((rowKey) =>
    props.selectedRowKeys.includes(rowKey),
  ).length;
  const areAllVisibleRowsSelected =
    visibleEvaluableRowKeys.length > 0 &&
    selectedVisibleRowCount === visibleEvaluableRowKeys.length;
  const toggleSort = (column: SuggestionEvaluationSortColumn) => {
    setSortState((current) => {
      if (current?.column !== column) {
        return { column, direction: 'desc' };
      }

      if (current.direction === 'desc') {
        return { column, direction: 'asc' };
      }

      return null;
    });
  };
  const toggleExpandedRow = (rowKey: string) => {
    setExpandedRowKeys((currentRowKeys) =>
      currentRowKeys.includes(rowKey)
        ? currentRowKeys.filter((currentRowKey) => currentRowKey !== rowKey)
        : [...currentRowKeys, rowKey],
    );
  };

  if (evaluationRows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No suggestion rows match the current filters</h3>
        <p>Refresh the filtered sites to load suggestion rows that can be checked.</p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="dashboard-table evaluation-table suggestion-evaluation-table">
        <colgroup>
          <col className="evaluation-col-select" />
          <col className="suggestion-evaluation-col-site" />
          <col className="suggestion-evaluation-col-type" />
          <col className="suggestion-evaluation-col-suggestion" />
          <col className="suggestion-evaluation-col-confidence" />
          <col className="suggestion-evaluation-col-verdict" />
          <col className="suggestion-evaluation-col-details" />
          <col className="evaluation-col-action" />
          <col className="evaluation-col-evaluated-at" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <label className="table-checkbox" aria-label="Select all visible rows">
                <input
                  type="checkbox"
                  checked={areAllVisibleRowsSelected}
                  disabled={visibleEvaluableRowKeys.length === 0}
                  onChange={(event) =>
                    props.onSelectRows(visibleEvaluableRowKeys, event.target.checked)
                  }
                />
              </label>
            </th>
            <th>Site</th>
            <th>Opportunity</th>
            <th>Suggestion</th>
            <th
              className="sortable-column-header"
              onClick={() => toggleSort('confidence')}
              aria-sort={
                sortState?.column === 'confidence'
                  ? sortState.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              Confidence
              <span className="sort-arrow" aria-hidden="true">
                {sortState?.column === 'confidence'
                  ? sortState.direction === 'desc'
                    ? ' ▼'
                    : ' ▲'
                  : ' ⇅'}
              </span>
            </th>
            <th
              className="sortable-column-header"
              onClick={() => toggleSort('verdict')}
              aria-sort={
                sortState?.column === 'verdict'
                  ? sortState.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              Evaluator
              <span className="sort-arrow" aria-hidden="true">
                {sortState?.column === 'verdict'
                  ? sortState.direction === 'desc'
                    ? ' ▼'
                    : ' ▲'
                  : ' ⇅'}
              </span>
            </th>
            <th>Details</th>
            <th>Action</th>
            <th>Evaluated At</th>
          </tr>
        </thead>
        <tbody>
          {evaluationRows.map((row) => {
            const isSelected = row.suggestion.rowKey
              ? props.selectedRowKeys.includes(row.suggestion.rowKey)
              : false;
            const isRunning = row.suggestion.evaluationStatus === 'running';
            const isActionDisabled =
              !row.suggestion.canEvaluate ||
              !row.suggestion.rowKey ||
              props.isEvaluating ||
              isRunning;
            const evaluationResult = row.suggestion.evaluationResult;
            const suggestionText = trimSuggestionText(row.suggestion.suggestionText);
            const verdictOutput = evaluationResult ? evaluationResult.verdict : 'Not evaluated';
            const rationaleOutput = row.suggestion.evaluationError
              ? `Error: ${row.suggestion.evaluationError}`
              : evaluationResult
                ? [
                    evaluationResult.rationale,
                    evaluationResult.evidenceSnippet
                      ? `Evidence: ${evaluationResult.evidenceSnippet}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                : 'Run evaluation to check whether this suggestion is grounded in the evidence.';
            const sourceUrls = getSuggestionEvaluationSourceUrls(evaluationResult);
            const isExpanded = row.suggestion.rowKey
              ? expandedRowKeys.includes(row.suggestion.rowKey)
              : false;
            const rowClassName = [
              isExpanded ? 'suggestion-evaluation-row-expanded' : '',
              isRunning ? 'evaluation-row-running' : '',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <Fragment key={row.id}>
                <tr className={rowClassName || undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!row.suggestion.canEvaluate || isRunning}
                      onChange={() =>
                        row.suggestion.rowKey
                          ? props.onToggleRowSelection(row.suggestion.rowKey)
                          : undefined
                      }
                    />
                  </td>
                  <td>
                    <div className="evaluation-site-stack">
                      <span>{row.site}</span>
                      <span className="evaluation-site-meta">
                        {row.siteId ?? row.opportunityId}
                      </span>
                    </div>
                  </td>
                  <td>{row.opportunityType}</td>
                  <td>
                    <div className="metric-card">
                      {row.suggestion.suggestionId && (
                        <span className="suggestion-meta-id">
                          {row.suggestion.suggestionId}
                        </span>
                      )}
                      <span className="suggestion-copy">{suggestionText || ' - '}</span>
                      {row.suggestion.suggestionUrl && (
                        <a
                          className="suggestion-link"
                          href={row.suggestion.suggestionUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open link
                        </a>
                      )}
                    </div>
                  </td>
                  <td>
                    {evaluationResult ? (
                      <span
                        className={`confidence-pill confidence-pill-${getConfidenceBand(
                          evaluationResult.confidence,
                        )}`}
                      >
                        {getConfidenceLabel(evaluationResult.confidence) || ' - '}
                      </span>
                    ) : (
                      <span className="status-pill status-pill-neutral">
                        {isRunning ? 'Evaluating...' : 'Not evaluated'}
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`status-pill status-pill-${getSuggestionVerdictTone(
                        verdictOutput,
                      )}`}
                    >
                      {verdictOutput}
                    </span>
                  </td>
                  <td>
                    {row.suggestion.rowKey ? (
                      <button
                        className="ghost-button suggestion-detail-toggle"
                        onClick={() => toggleExpandedRow(row.suggestion.rowKey as string)}
                        type="button"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? 'Hide' : 'Show'}
                      </button>
                    ) : (
                      <span className="metric-copy"> - </span>
                    )}
                  </td>
                  <td>
                    <button
                      className="ghost-button"
                      disabled={isActionDisabled}
                      onClick={() =>
                        row.suggestion.rowKey
                          ? props.onEvaluateRow(row.suggestion.rowKey)
                          : undefined
                      }
                      type="button"
                    >
                      {isRunning ? 'Evaluating...' : 'Evaluate'}
                    </button>
                  </td>
                  <td>
                    <span className="status-pill status-pill-neutral evaluated-at-pill">
                      {formatTimestamp(evaluationResult?.evaluatedAt)}
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="suggestion-evaluation-detail-row">
                    <td colSpan={9}>
                      <div className="suggestion-evaluation-detail-grid">
                        <div className="suggestion-evaluation-detail-card">
                          <h4>Rationale / Evidence</h4>
                          <p className="metric-copy">{rationaleOutput}</p>
                        </div>
                        <div className="suggestion-evaluation-detail-card">
                          <h4>Source Used</h4>
                          {sourceUrls.length > 0 ? (
                            <div className="suggestion-evaluation-source-list">
                              {sourceUrls.map((sourceUrl) => (
                                <a
                                  key={sourceUrl}
                                  className="metric-link"
                                  href={sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={sourceUrl}
                                >
                                  {sourceUrl}
                                </a>
                              ))}
                            </div>
                          ) : (
                            <p className="metric-copy">
                              {evaluationResult
                                ? 'No source URL was captured for this evaluation.'
                                : 'Run evaluation to see the source used.'}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EvaluationTable(props: {
  rows: GroupedOpportunityRow[];
  selectedRowKeys: string[];
  onToggleRowSelection: (rowKey: string) => void;
  onSelectRows: (rowKeys: string[], selected: boolean) => void;
  onEvaluateRow: (rowKey: string) => void;
  isEvaluating: boolean;
}) {
  const [sortState, setSortState] = useState<EvaluationSortState>(null);
  const evaluationRows = buildEvaluationRows(props.rows, sortState, 'sentiment');
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
  const toggleExpandedRow = (rowKey: string) => {
    setExpandedRowKeys((currentRowKeys) =>
      currentRowKeys.includes(rowKey)
        ? currentRowKeys.filter((currentRowKey) => currentRowKey !== rowKey)
        : [...currentRowKeys, rowKey],
    );
  };
  const toggleSort = (column: EvaluationSortColumn) => {
    setSortState((current) => {
      if (current?.column !== column) {
        return { column, direction: 'desc' };
      }
      if (current.direction === 'desc') {
        return { column, direction: 'asc' };
      }
      return null;
    });
  };
  const visibleEvaluableRowKeys = evaluationRows
    .filter((row) => row.item.canEvaluate && row.item.rowKey)
    .map((row) => row.item.rowKey as string);
  const selectedVisibleRowCount = visibleEvaluableRowKeys.filter((rowKey) =>
    props.selectedRowKeys.includes(rowKey),
  ).length;
  const areAllVisibleRowsSelected =
    visibleEvaluableRowKeys.length > 0 &&
    selectedVisibleRowCount === visibleEvaluableRowKeys.length;

  if (evaluationRows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No evaluable sentiment rows match the current filters</h3>
        <p>Refresh the filtered sites to load rows that can be independently checked.</p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="dashboard-table evaluation-table">
        <colgroup>
          <col className="evaluation-col-select" />
          <col className="evaluation-col-site" />
          <col className="evaluation-col-type" />
          <col className="evaluation-col-url" />
          <col className="evaluation-col-sentiment" />
          <col className="evaluation-col-confidence" />
          <col className="evaluation-col-evaluated" />
          <col className="suggestion-evaluation-col-details" />
          <col className="evaluation-col-action" />
          <col className="evaluation-col-evaluated-at" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <label className="table-checkbox" aria-label="Select all visible rows">
                <input
                  type="checkbox"
                  checked={areAllVisibleRowsSelected}
                  disabled={visibleEvaluableRowKeys.length === 0}
                  onChange={(event) =>
                    props.onSelectRows(visibleEvaluableRowKeys, event.target.checked)
                  }
                />
              </label>
            </th>
            <th>Site</th>
            <th>Opportunity</th>
            <th>URL</th>
            <th>Extracted Sentiment</th>
            <th
              className="sortable-column-header"
              onClick={() => toggleSort('confidence')}
              aria-sort={
                sortState?.column === 'confidence'
                  ? sortState.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              Confidence
              <span className="sort-arrow" aria-hidden="true">
                {sortState?.column === 'confidence'
                  ? sortState.direction === 'desc'
                    ? ' ▼'
                    : ' ▲'
                  : ' ⇅'}
              </span>
            </th>
            <th
              className="sortable-column-header"
              onClick={() => toggleSort('verdict')}
              aria-sort={
                sortState?.column === 'verdict'
                  ? sortState.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              Evaluator
              <span className="sort-arrow" aria-hidden="true">
                {sortState?.column === 'verdict'
                  ? sortState.direction === 'desc'
                    ? ' ▼'
                    : ' ▲'
                  : ' ⇅'}
              </span>
            </th>
            <th>Details</th>
            <th>Action</th>
            <th>Evaluated At</th>
          </tr>
        </thead>
        <tbody>
          {evaluationRows.map((row) => {
            const itemValue = trimSuggestionText(row.item.item);
            const isUrl = /^https?:\/\//i.test(itemValue);
            const isSelected = row.item.rowKey
              ? props.selectedRowKeys.includes(row.item.rowKey)
              : false;
            const isRunning = row.item.evaluationStatus === 'running';
            const isActionDisabled =
              !row.item.canEvaluate || !row.item.rowKey || props.isEvaluating || isRunning;
            const evaluationResult = row.item.evaluationResult;
            const evaluationOutput = evaluationResult
              ? evaluationResult.evaluatedSentiment
              : 'Not evaluated';
            const rationaleOutput = row.item.evaluationError
              ? `Error: ${row.item.evaluationError}`
              : evaluationResult
                ? [
                    ...getEvaluationEvidenceContextLines(evaluationResult.fetch),
                    // Use sentiment-only rationale when available (newer evaluations);
                    // fall back to the combined rationale for older cached results.
                    evaluationResult.sentimentRationale || evaluationResult.rationale,
                    evaluationResult.evidenceSnippet
                      ? `Evidence: ${evaluationResult.evidenceSnippet}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                : 'Run evaluation to score sentiment.';

            const sentimentVerdict = deriveSentimentVerdict({
              extractedSentiment: row.item.sentiment,
              evaluationResult,
              evaluationError: row.item.evaluationError,
            });
            const evaluatorSentimentLabel = evaluationResult
              ? evaluationResult.evaluatedSentiment || 'Needs Review'
              : 'Not evaluated';
            const extractedSentimentLabel =
              trimSuggestionText(getSentimentLabel(row.item.sentiment)) || '—';

            const isExpanded = row.item.rowKey
              ? expandedRowKeys.includes(row.item.rowKey)
              : false;
            const rowClassName = [
              isExpanded ? 'suggestion-evaluation-row-expanded' : '',
              isRunning ? 'evaluation-row-running' : '',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <Fragment key={row.id}>
                <tr className={rowClassName || undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!row.item.canEvaluate || isRunning}
                      onChange={() =>
                        row.item.rowKey
                          ? props.onToggleRowSelection(row.item.rowKey)
                          : undefined
                      }
                    />
                  </td>
                  <td>
                    <div className="evaluation-site-stack">
                      <span>{row.site}</span>
                      <span className="evaluation-site-meta">
                        {row.siteId ?? row.opportunityId}
                      </span>
                    </div>
                  </td>
                  <td>{row.opportunityType}</td>
                  <td>
                    {isUrl ? (
                      <a
                        className="metric-link metric-card"
                        href={itemValue}
                        target="_blank"
                        rel="noreferrer"
                        title={itemValue}
                      >
                        {getDisplayUrl(itemValue)}
                      </a>
                    ) : (
                      <span className="metric-copy metric-card" title={itemValue}>
                        {itemValue || ' - '}
                      </span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const sentimentLabel = getSentimentLabel(row.item.sentiment);
                      const displayLabel = trimSuggestionText(sentimentLabel);
                      const hasLabel = displayLabel.length > 0;
                      const capitalizedLabel = hasLabel
                        ? displayLabel.charAt(0).toUpperCase() + displayLabel.slice(1)
                        : '—';

                      return (
                        <span
                          className={`status-pill status-pill-${getSentimentTone(
                            row.item.sentiment,
                          )}`}
                          title={hasLabel ? sentimentLabel : MISSING_EXTRACTED_SENTIMENT_TOOLTIP}
                        >
                          {capitalizedLabel}
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    {evaluationResult ? (
                      <div className="confidence-stack">
                        <span
                          className={`confidence-pill confidence-pill-${getConfidenceBand(
                            evaluationResult.sentimentConfidence,
                          )}`}
                        >
                          {getConfidenceLabel(evaluationResult.sentimentConfidence) || ' - '}
                        </span>
                      </div>
                    ) : (
                      <span className="status-pill status-pill-neutral">
                        {isRunning ? 'Evaluating...' : 'Not evaluated'}
                      </span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const tooltip =
                        sentimentVerdict === 'Correct'
                          ? `Evaluator said ${evaluatorSentimentLabel}; matches extracted ${extractedSentimentLabel}.`
                          : sentimentVerdict === 'Incorrect'
                            ? `Evaluator said ${evaluatorSentimentLabel}; disagrees with extracted ${extractedSentimentLabel}.`
                            : sentimentVerdict === 'Needs Review'
                              ? 'Evaluator could not judge. Open Details for rationale.'
                              : 'This row has not been evaluated yet.';
                      return (
                        <div className="evaluator-verdict-stack">
                          <span
                            className={`status-pill status-pill-${getSuggestionVerdictTone(
                              sentimentVerdict,
                            )}`}
                            title={tooltip}
                          >
                            {sentimentVerdict}
                          </span>
                          {evaluationResult?.fetch?.isBrandOwned && (
                            <span
                              className="status-pill status-pill-success evaluator-brand-badge"
                              title={
                                evaluationResult.fetch.sourceType === 'youtube'
                                  ? "This video is published on the brand's own YouTube channel"
                                  : "This URL is on the brand's own website"
                              }
                            >
                              {evaluationResult.fetch.sourceType === 'youtube'
                                ? 'Brand channel'
                                : 'Brand site'}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    {row.item.rowKey ? (
                      <button
                        className="ghost-button suggestion-detail-toggle"
                        onClick={() => toggleExpandedRow(row.item.rowKey as string)}
                        type="button"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? 'Hide' : 'Show'}
                      </button>
                    ) : (
                      <span className="metric-copy"> - </span>
                    )}
                  </td>
                  <td>
                    <button
                      className="ghost-button"
                      disabled={isActionDisabled}
                      onClick={() =>
                        row.item.rowKey ? props.onEvaluateRow(row.item.rowKey) : undefined
                      }
                      type="button"
                    >
                      {isRunning ? 'Evaluating...' : 'Evaluate'}
                    </button>
                  </td>
                  <td>
                    <span className="status-pill status-pill-neutral evaluated-at-pill">
                      {formatTimestamp(evaluationResult?.evaluatedAt)}
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="suggestion-evaluation-detail-row">
                    <td colSpan={10}>
                      <div className="suggestion-evaluation-detail-grid">
                        <div className="suggestion-evaluation-detail-card">
                          <h4>Evaluator&apos;s call</h4>
                          {evaluationResult?.fetch?.isBrandOwned && (
                            <span
                              className="status-pill status-pill-success"
                              title={
                                evaluationResult.fetch.sourceType === 'youtube'
                                  ? "This video is published on the brand's own YouTube channel"
                                  : "This URL is on the brand's own website"
                              }
                              style={{ display: 'inline-block', marginBottom: '0.5rem' }}
                            >
                              {evaluationResult.fetch.sourceType === 'youtube'
                                ? 'Brand channel'
                                : 'Brand site'}
                            </span>
                          )}
                          <p className="metric-copy">
                            Evaluator sentiment:{' '}
                            <strong>{evaluatorSentimentLabel}</strong>
                          </p>
                          <p className="metric-copy">
                            Extracted sentiment:{' '}
                            <strong>{extractedSentimentLabel}</strong>
                          </p>
                          <p className="metric-copy">
                            Verdict: <strong>{sentimentVerdict}</strong>
                          </p>
                        </div>
                        <div className="suggestion-evaluation-detail-card">
                          <h4>Rationale / Evidence</h4>
                          <p className="metric-copy">{rationaleOutput}</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SovEvaluationTable(props: {
  rows: GroupedOpportunityRow[];
  selectedRowKeys: string[];
  onToggleRowSelection: (rowKey: string) => void;
  onSelectRows: (rowKeys: string[], selected: boolean) => void;
  onEvaluateRow: (rowKey: string) => void;
  isEvaluating: boolean;
}) {
  const [sortState, setSortState] = useState<EvaluationSortState>(null);
  const evaluationRows = buildEvaluationRows(props.rows, sortState, 'sov');
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
  const toggleExpandedRow = (rowKey: string) => {
    setExpandedRowKeys((currentRowKeys) =>
      currentRowKeys.includes(rowKey)
        ? currentRowKeys.filter((currentRowKey) => currentRowKey !== rowKey)
        : [...currentRowKeys, rowKey],
    );
  };
  const toggleSort = (column: EvaluationSortColumn) => {
    setSortState((current) => {
      if (current?.column !== column) {
        return { column, direction: 'desc' };
      }
      if (current.direction === 'desc') {
        return { column, direction: 'asc' };
      }
      return null;
    });
  };
  const visibleEvaluableRowKeys = evaluationRows
    .filter((row) => row.item.canEvaluate && row.item.rowKey)
    .map((row) => row.item.rowKey as string);
  const selectedVisibleRowCount = visibleEvaluableRowKeys.filter((rowKey) =>
    props.selectedRowKeys.includes(rowKey),
  ).length;
  const areAllVisibleRowsSelected =
    visibleEvaluableRowKeys.length > 0 &&
    selectedVisibleRowCount === visibleEvaluableRowKeys.length;

  if (evaluationRows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No evaluable Share of Voice rows match the current filters</h3>
        <p>Run sentiment evaluation above to calculate share-of-voice confidence.</p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="dashboard-table evaluation-table">
        <colgroup>
          <col className="evaluation-col-select" />
          <col className="evaluation-col-site" />
          <col className="evaluation-col-type" />
          <col className="evaluation-col-url" />
          <col className="evaluation-col-sentiment" />
          <col className="evaluation-col-confidence" />
          <col className="evaluation-col-evaluated" />
          <col className="suggestion-evaluation-col-details" />
          <col className="evaluation-col-action" />
          <col className="evaluation-col-evaluated-at" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <label className="table-checkbox" aria-label="Select all visible rows">
                <input
                  type="checkbox"
                  checked={areAllVisibleRowsSelected}
                  disabled={visibleEvaluableRowKeys.length === 0}
                  onChange={(event) =>
                    props.onSelectRows(visibleEvaluableRowKeys, event.target.checked)
                  }
                />
              </label>
            </th>
            <th>Site</th>
            <th>Opportunity</th>
            <th>URL</th>
            <th>Extracted SOV</th>
            <th
              className="sortable-column-header"
              onClick={() => toggleSort('confidence')}
              aria-sort={
                sortState?.column === 'confidence'
                  ? sortState.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              Confidence
              <span className="sort-arrow" aria-hidden="true">
                {sortState?.column === 'confidence'
                  ? sortState.direction === 'desc'
                    ? ' ▼'
                    : ' ▲'
                  : ' ⇅'}
              </span>
            </th>
            <th
              className="sortable-column-header"
              onClick={() => toggleSort('verdict')}
              aria-sort={
                sortState?.column === 'verdict'
                  ? sortState.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              Evaluator
              <span className="sort-arrow" aria-hidden="true">
                {sortState?.column === 'verdict'
                  ? sortState.direction === 'desc'
                    ? ' ▼'
                    : ' ▲'
                  : ' ⇅'}
              </span>
            </th>
            <th>Details</th>
            <th>Action</th>
            <th>Evaluated At</th>
          </tr>
        </thead>
        <tbody>
          {evaluationRows.map((row) => {
            const itemValue = trimSuggestionText(row.item.item);
            const isUrl = /^https?:\/\//i.test(itemValue);
            const isSelected = row.item.rowKey
              ? props.selectedRowKeys.includes(row.item.rowKey)
              : false;
            const isRunning = row.item.evaluationStatus === 'running';
            const isActionDisabled =
              !row.item.canEvaluate || !row.item.rowKey || props.isEvaluating || isRunning;
            const evaluationResult = row.item.evaluationResult;
            const evaluationOutput = evaluationResult
              ? evaluationResult.evaluatedSov
              : 'Not evaluated';
            const rationaleOutput = row.item.evaluationError
              ? `Error: ${row.item.evaluationError}`
              : evaluationResult
                ? [
                    ...getEvaluationEvidenceContextLines(evaluationResult.fetch),
                    evaluationResult.rationale,
                    evaluationResult.evidenceSnippet
                      ? `Evidence: ${evaluationResult.evidenceSnippet}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                : 'Run sentiment evaluation above to score share of voice.';

            const sovVerdict = deriveSovVerdict({
              extractedSov: row.item.sov,
              evaluationResult,
              evaluationError: row.item.evaluationError,
            });
            const evaluatorSovLabel = evaluationResult
              ? evaluationResult.evaluatedSov || 'Needs Review'
              : 'Not evaluated';
            const extractedSovLabel = trimSuggestionText(row.item.sov) || '—';

            const isExpanded = row.item.rowKey
              ? expandedRowKeys.includes(row.item.rowKey)
              : false;
            const rowClassName = [
              isExpanded ? 'suggestion-evaluation-row-expanded' : '',
              isRunning ? 'evaluation-row-running' : '',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <Fragment key={`${row.id}-sov`}>
                <tr className={rowClassName || undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!row.item.canEvaluate || isRunning}
                      onChange={() =>
                        row.item.rowKey
                          ? props.onToggleRowSelection(row.item.rowKey)
                          : undefined
                      }
                    />
                  </td>
                  <td>
                    <div className="evaluation-site-stack">
                      <span>{row.site}</span>
                      <span className="evaluation-site-meta">
                        {row.siteId ?? row.opportunityId}
                      </span>
                    </div>
                  </td>
                  <td>{row.opportunityType}</td>
                  <td>
                    {isUrl ? (
                      <a
                        className="metric-link metric-card"
                        href={itemValue}
                        target="_blank"
                        rel="noreferrer"
                        title={itemValue}
                      >
                        {getDisplayUrl(itemValue)}
                      </a>
                    ) : (
                      <span className="metric-copy metric-card" title={itemValue}>
                        {itemValue || ' - '}
                      </span>
                    )}
                  </td>
                  <td>
                    <SovLabel
                      value={row.item.sov}
                      targetBrand={evaluationResult?.targetBrand ?? undefined}
                    />
                  </td>
                  <td>
                    {evaluationResult ? (
                      <div className="confidence-stack">
                        <span
                          className={`confidence-pill confidence-pill-${getConfidenceBand(
                            evaluationResult.sovConfidence,
                          )}`}
                        >
                          {getConfidenceLabel(evaluationResult.sovConfidence) || ' - '}
                        </span>
                      </div>
                    ) : (
                      <span className="status-pill status-pill-neutral">
                        {isRunning ? 'Evaluating...' : 'Not evaluated'}
                      </span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const tooltip =
                        sovVerdict === 'Correct'
                          ? `Evaluator said ${evaluatorSovLabel}; matches extracted ${extractedSovLabel}.`
                          : sovVerdict === 'Incorrect'
                            ? `Evaluator said ${evaluatorSovLabel}; disagrees with extracted ${extractedSovLabel}.`
                            : sovVerdict === 'Needs Review'
                              ? 'Evaluator could not judge. Open Details for rationale.'
                              : 'This row has not been evaluated yet.';
                      return (
                        <span
                          className={`status-pill status-pill-${getSuggestionVerdictTone(
                            sovVerdict,
                          )}`}
                          title={tooltip}
                        >
                          {sovVerdict}
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    {row.item.rowKey ? (
                      <button
                        className="ghost-button suggestion-detail-toggle"
                        onClick={() => toggleExpandedRow(row.item.rowKey as string)}
                        type="button"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? 'Hide' : 'Show'}
                      </button>
                    ) : (
                      <span className="metric-copy"> - </span>
                    )}
                  </td>
                  <td>
                    <button
                      className="ghost-button"
                      disabled={isActionDisabled}
                      onClick={() =>
                        row.item.rowKey ? props.onEvaluateRow(row.item.rowKey) : undefined
                      }
                      type="button"
                    >
                      {isRunning ? 'Evaluating...' : 'Evaluate'}
                    </button>
                  </td>
                  <td>
                    <span className="status-pill status-pill-neutral evaluated-at-pill">
                      {formatTimestamp(evaluationResult?.evaluatedAt)}
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="suggestion-evaluation-detail-row">
                    <td colSpan={10}>
                      <div className="suggestion-evaluation-detail-grid">
                        <div className="suggestion-evaluation-detail-card">
                          <h4>Evaluator&apos;s call</h4>
                          <p className="metric-copy">
                            Evaluator Share of Voice:{' '}
                            <strong>{evaluatorSovLabel}</strong>
                          </p>
                          <p className="metric-copy">
                            Extracted Share of Voice:{' '}
                            <strong>{extractedSovLabel}</strong>
                          </p>
                          <p className="metric-copy">
                            Verdict: <strong>{sovVerdict}</strong>
                          </p>
                        </div>
                        <div className="suggestion-evaluation-detail-card">
                          <h4>Rationale / Evidence</h4>
                          <p className="metric-copy">{rationaleOutput}</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type WorkspaceMode = 'opportunities' | 'evaluation' | 'wikipedia-check';

type WikipediaCheckVerdict =
  | 'likely-correct'
  | 'needs-review'
  | 'likely-incorrect'
  | 'missing';

type WikipediaUrlCheckResult = {
  requestedSite: string;
  resolvedSiteUrl?: string;
  siteId?: string;
  opportunityId?: string;
  verdict: WikipediaUrlEvaluationVerdict | WikipediaCheckVerdict;
  verdictLabel: string;
  summary: string;
  backendWikipediaUrl?: string;
  extractedTitle?: string;
  wikipediaOpportunityCount: number;
  wikipediaSuggestionCount: number;
  rationale: string;
  evidenceSnippet?: string;
  confidence?: 'high' | 'medium' | 'low';
  evaluatorProvider?: string;
  evaluatorModel?: string;
};

type WikipediaBatchProgress = {
  completed: number;
  total: number;
};

function WorkspaceNavButton(props: {
  active: boolean;
  count: string;
  description: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`workspace-nav-button ${props.active ? 'workspace-nav-button-active' : ''}`}
      onClick={props.onClick}
      type="button"
      aria-pressed={props.active}
    >
      <span className="workspace-nav-label-row">
        <span className="workspace-nav-label">{props.label}</span>
        <span className="workspace-nav-count">{props.count}</span>
      </span>
      <span className="workspace-nav-description">{props.description}</span>
    </button>
  );
}

function getWikipediaStatusTone(
  verdict: WikipediaUrlEvaluationVerdict | WikipediaCheckVerdict,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (verdict === 'Correct' || verdict === 'likely-correct') {
    return 'success';
  }

  if (verdict === 'Needs Review' || verdict === 'needs-review') {
    return 'warning';
  }

  if (verdict === 'Incorrect' || verdict === 'likely-incorrect') {
    return 'error';
  }

  return 'neutral';
}

function isClaudeWikipediaVerdict(
  verdict: WikipediaUrlEvaluationVerdict | WikipediaCheckVerdict,
): verdict is WikipediaUrlEvaluationVerdict {
  return verdict === 'Correct' || verdict === 'Needs Review' || verdict === 'Incorrect';
}

function isWikipediaUrl(value?: string) {
  if (!value?.trim()) {
    return false;
  }

  try {
    const parsedUrl = new URL(value.trim());
    return /(^|\.)wikipedia\.org$/i.test(parsedUrl.hostname);
  } catch {
    return false;
  }
}

function extractWikipediaTitleFromUrl(value?: string) {
  if (!value?.trim() || !isWikipediaUrl(value)) {
    return '';
  }

  try {
    const parsedUrl = new URL(value.trim());

    return decodeURIComponent(parsedUrl.pathname.replace(/^\/wiki\//i, ''))
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function buildMissingWikipediaUrlCheckResult(
  site: SiteDashboardResult,
  options: {
    opportunityId?: string;
    summary: string;
    rationale: string;
    verdictLabel: string;
  },
): WikipediaUrlCheckResult {
  const wikipediaOpportunities = site.opportunities.filter(
    (opportunity) => opportunity.opportunityType === 'Wikipedia',
  );

  return {
    requestedSite: site.requestSite,
    resolvedSiteUrl: site.resolvedSiteUrl,
    siteId: site.siteId,
    opportunityId: options.opportunityId,
    verdict: 'missing',
    verdictLabel: options.verdictLabel,
    summary: options.summary,
    wikipediaOpportunityCount: wikipediaOpportunities.length,
    wikipediaSuggestionCount: wikipediaOpportunities.reduce(
      (count, opportunity) => count + opportunity.suggestions.length,
      0,
    ),
    rationale: options.rationale,
  };
}

function buildWikipediaUrlCheckResult(
  site: SiteDashboardResult,
  backendWikipediaUrl: string,
  evaluation: {
    confidence: 'high' | 'medium' | 'low';
    evidenceSnippet: string;
    evaluatorModel: string;
    evaluatorProvider: string;
    rationale: string;
    verdict: WikipediaUrlEvaluationVerdict;
    wikipediaTitle: string;
  },
): WikipediaUrlCheckResult {
  const wikipediaOpportunities = site.opportunities.filter(
    (opportunity) => opportunity.opportunityType === 'Wikipedia',
  );

  return {
    requestedSite: site.requestSite,
    resolvedSiteUrl: site.resolvedSiteUrl,
    siteId: site.siteId,
    opportunityId: wikipediaOpportunities[0]?.opportunityId,
    verdict: evaluation.verdict,
    verdictLabel: evaluation.verdict,
    summary:
      evaluation.verdict === 'Correct'
        ? 'The backend wikipediaUrl appears correct for this site.'
        : evaluation.verdict === 'Incorrect'
          ? 'The backend wikipediaUrl appears incorrect for this site.'
          : 'The backend wikipediaUrl needs review for this site.',
    backendWikipediaUrl,
    extractedTitle: evaluation.wikipediaTitle || extractWikipediaTitleFromUrl(backendWikipediaUrl),
    wikipediaOpportunityCount: wikipediaOpportunities.length,
    wikipediaSuggestionCount: wikipediaOpportunities.reduce(
      (count, opportunity) => count + opportunity.suggestions.length,
      0,
    ),
    rationale: evaluation.rationale,
    evidenceSnippet: evaluation.evidenceSnippet,
    confidence: evaluation.confidence,
    evaluatorProvider: evaluation.evaluatorProvider,
    evaluatorModel: evaluation.evaluatorModel,
  };
}

function buildWikipediaCheckFailureResult(
  site: string,
  message: string,
): WikipediaUrlCheckResult {
  return {
    requestedSite: site,
    verdict: 'missing',
    verdictLabel: 'Check failed',
    summary: 'The Wikipedia URL check could not be completed for this site.',
    wikipediaOpportunityCount: 0,
    wikipediaSuggestionCount: 0,
    rationale: message,
  };
}

function capitalizeFirst(s?: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getWikiHallucinationRate(
  verdict: WikipediaUrlEvaluationVerdict | WikipediaCheckVerdict,
): string {
  if (verdict === 'Correct') return '0%';
  if (verdict === 'Incorrect') return '100%';
  return '';
}

function downloadWikipediaBatchResultsExcel(results: WikipediaUrlCheckResult[]) {
  if (results.length === 0) {
    return;
  }

  const rows = results.map((result) => {
    const wikiOpportunity = result.wikipediaOpportunityCount > 0 ? 'Exists' : 'Missing';
    const wikiPage = isClaudeWikipediaVerdict(result.verdict) ? result.verdict : 'N/A';
    const hallucinationRate = getWikiHallucinationRate(result.verdict);

    return {
      'Site URL': result.requestedSite,
      'Wiki Opportunity': wikiOpportunity,
      'Wiki Page': wikiPage,
      'Hallucination Rate Wiki Page': hallucinationRate,
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);

  // Auto-size columns
  const colWidths = [
    { wch: 40 }, // Site URL
    { wch: 18 }, // Wiki Opportunity
    { wch: 16 }, // Wiki Page
    { wch: 28 }, // Hallucination Rate Wiki Page
  ];
  worksheet['!cols'] = colWidths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Wikipedia Check');
  XLSX.writeFile(workbook, 'wikipedia-check-results.xlsx');
}

export function OffSiteDashboard() {
  const [activeWorkspace, setActiveWorkspace] =
    useState<WorkspaceMode>('opportunities');
  const [isCoverageExpanded, setIsCoverageExpanded] = useState(true);
  const dashboard = useOffSiteDashboard();
  const [isSitesExpanded, setIsSitesExpanded] = useState(true);
  const [isSentimentExpanded, setIsSentimentExpanded] = useState(true);
  const [isSuggestionEvaluationExpanded, setIsSuggestionEvaluationExpanded] =
    useState(false);
  const [isEvaluationExpanded, setIsEvaluationExpanded] = useState(false);
  const [isSovEvaluationExpanded, setIsSovEvaluationExpanded] = useState(false);
  const [isSuggestionsExpanded, setIsSuggestionsExpanded] = useState(true);
  const [wikipediaCheckSiteInput, setWikipediaCheckSiteInput] = useState('');
  const [wikipediaBatchInputText, setWikipediaBatchInputText] = useState('');
  const [wikipediaCheckStatus, setWikipediaCheckStatus] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle');
  const [wikipediaCheckResult, setWikipediaCheckResult] =
    useState<WikipediaUrlCheckResult | null>(null);
  const [wikipediaCheckError, setWikipediaCheckError] = useState('');
  const [wikipediaBatchStatus, setWikipediaBatchStatus] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle');
  const [wikipediaBatchError, setWikipediaBatchError] = useState('');
  const [wikipediaBatchResults, setWikipediaBatchResults] = useState<
    WikipediaUrlCheckResult[]
  >([]);
  const [wikipediaBatchProgress, setWikipediaBatchProgress] =
    useState<WikipediaBatchProgress>({
      completed: 0,
      total: 0,
    });
  const visibleOpportunityCount = dashboard.filteredOpportunityRows.length;
  const visibleSuggestionOpportunityCount = dashboard.filteredOpportunityRows.filter(
    (row) => row.suggestions.length > 0,
  ).length;
  const visibleSuggestionCount = dashboard.filteredOpportunityRows.reduce(
    (count, row) => count + row.suggestions.length,
    0,
  );
  const syncedSiteCount = dashboard.siteCards.filter(
    (site) => site.status === 'success',
  ).length;
  const visibleSuggestionEvaluationRows = buildSuggestionEvaluationRows(
    dashboard.pagedOpportunityRows,
  );
  const visibleSuggestionEvaluationCount = visibleSuggestionEvaluationRows.length;
  const visibleSentimentOpportunityCount = dashboard.filteredOpportunityRows.filter(
    (row) => row.opportunityType && SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType),
  ).length;
  const visibleSentimentCount = dashboard.filteredOpportunityRows.reduce(
    (count, row) => count + row.sentimentItems.length,
    0,
  );
  const visibleSentimentSiteCount = new Set(
    dashboard.filteredOpportunityRows
      .filter(
        (row) => row.opportunityType && SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType),
      )
      .map((row) => row.site),
  ).size;
  const evaluationOpportunityRows = filterEvaluationOpportunityRows(
    dashboard.pagedOpportunityRows,
  );
  const visibleSelectedEvaluationRowKeys = evaluationOpportunityRows.flatMap((row) =>
    row.sentimentItems
      .filter(
        (item) =>
          item.canEvaluate &&
          item.rowKey &&
          dashboard.selectedSentimentRowKeys.includes(item.rowKey),
      )
      .map((item) => item.rowKey as string),
  );
  const visibleSelectedEvaluationRowsCount = visibleSelectedEvaluationRowKeys.length;
  const visibleEvaluationCount = evaluationOpportunityRows
    .reduce((count, row) => count + row.sentimentItems.length, 0);
  const visibleEvaluationItems = buildEvaluationRows(dashboard.pagedOpportunityRows).map(
    (row) => row.item,
  );
  const visibleSelectedSovEvaluationRowKeys = buildEvaluationRows(
    dashboard.pagedOpportunityRows,
  )
    .filter(
      (row) =>
        row.item.canEvaluate &&
        row.item.rowKey &&
        dashboard.selectedSentimentRowKeys.includes(row.item.rowKey),
    )
    .map((row) => row.item.rowKey as string);
  const visibleSelectedSovEvaluationRowsCount =
    visibleSelectedSovEvaluationRowKeys.length;
  const evaluationSummary = evaluationOpportunityRows
    .flatMap((row) => row.sentimentItems)
    .reduce(
      (summary, item) => {
        if (item.evaluationResult) {
          summary.evaluated += 1;
          const verdict = deriveSentimentVerdict({
            extractedSentiment: item.sentiment,
            evaluationResult: item.evaluationResult,
            evaluationError: item.evaluationError,
          });
          if (verdict === 'Correct') summary.confirmed += 1;
          else if (verdict === 'Incorrect') summary.incorrect += 1;
          else summary.review += 1;
          return summary;
        }
        if (item.evaluationError) {
          summary.evaluated += 1;
          summary.review += 1;
          return summary;
        }
        summary.notEvaluated += 1;
        return summary;
      },
      { evaluated: 0, confirmed: 0, incorrect: 0, review: 0, notEvaluated: 0 },
    );
  const sovEvaluationSummary = visibleEvaluationItems.reduce(
    (summary, item) => {
      if (item.evaluationResult) {
        summary.evaluated += 1;
        const verdict = deriveSovVerdict({
          extractedSov: item.sov,
          evaluationResult: item.evaluationResult,
          evaluationError: item.evaluationError,
        });
        if (verdict === 'Correct') summary.confirmed += 1;
        else if (verdict === 'Incorrect') summary.incorrect += 1;
        else summary.review += 1;
        return summary;
      }
      if (item.evaluationError) {
        summary.evaluated += 1;
        summary.review += 1;
        return summary;
      }
      summary.notEvaluated += 1;
      return summary;
    },
    { evaluated: 0, confirmed: 0, incorrect: 0, review: 0, notEvaluated: 0 },
  );
  const suggestionEvaluationSummary = visibleSuggestionEvaluationRows.reduce(
    (summary, row) => {
      const suggestion = row.suggestion;
      if (suggestion.evaluationResult) {
        summary.evaluated += 1;
        if (
          isConfirmedSuggestionEvaluation({
            verdict: suggestion.evaluationResult.verdict,
            confidence: suggestion.evaluationResult.confidence,
          })
        ) {
          summary.confirmed += 1;
        } else if (
          normalizeSuggestionVerdict(suggestion.evaluationResult.verdict) === 'incorrect'
        ) {
          summary.incorrect += 1;
        } else {
          summary.review += 1;
        }
        return summary;
      }
      if (suggestion.evaluationError) {
        summary.evaluated += 1;
        summary.review += 1;
        return summary;
      }
      summary.notEvaluated += 1;
      return summary;
    },
    { evaluated: 0, confirmed: 0, incorrect: 0, review: 0, notEvaluated: 0 },
  );

  /**
   * Hallucination rate = incorrect / (correct + incorrect) × 100.
   * "Needs Review" rows are excluded (neither penalised nor credited).
   * Returns null when no rows with a definitive verdict exist yet.
   */
  function hallucinationRate(confirmed: number, incorrect: number): number | null {
    const total = confirmed + incorrect;
    return total > 0 ? Math.round((incorrect / total) * 100) : null;
  }
  const sentimentHallucinationRate = hallucinationRate(
    evaluationSummary.confirmed,
    evaluationSummary.incorrect,
  );
  const sovHallucinationRate = hallucinationRate(
    sovEvaluationSummary.confirmed,
    sovEvaluationSummary.incorrect,
  );
  const suggestionHallucinationRate = hallucinationRate(
    suggestionEvaluationSummary.confirmed,
    suggestionEvaluationSummary.incorrect,
  );
  const pendingReviewCount =
    suggestionEvaluationSummary.review +
    suggestionEvaluationSummary.incorrect +
    evaluationSummary.review +
    sovEvaluationSummary.review;
  const isManagedConnection = dashboard.spacecatProxyConfig.configured;
  const effectiveApiBaseUrl = normalizeApiBaseUrl(
    isManagedConnection
      ? dashboard.spacecatProxyConfig.apiBaseUrl
      : dashboard.config.apiBaseUrl,
  );
  const canRunWikipediaCheck =
    Boolean(effectiveApiBaseUrl.trim()) &&
    (isManagedConnection || Boolean(dashboard.config.apiKey.trim()));
  const currentModeLabel = dashboard.spacecatProxyConfig.configured
    ? 'Managed relay'
    : 'Manual connection';
  const activeFilterLabel = `${dashboard.selectedTypes.length} oppty selected · ${dashboard.selectedSites.length} site${dashboard.selectedSites.length === 1 ? '' : 's'}`;
  const activeWorkspaceLabel =
    activeWorkspace === 'opportunities'
      ? 'Opportunities'
      : activeWorkspace === 'evaluation'
        ? 'Evaluation'
        : 'Wikipedia Check';
  const wikipediaBatchSites = normalizeSiteList(wikipediaBatchInputText);
  const workspaceActionButtons = (className: string) => (
    <div className={className}>
      <button
        className="primary-button"
        disabled={!dashboard.canRefresh}
        onClick={() => void dashboard.refreshAll()}
        type="button"
      >
        {dashboard.isRefreshing ? 'Refreshing...' : 'Refresh all sites'}
      </button>
      <button
        className="ghost-button"
        disabled={!dashboard.hasExportRows}
        onClick={dashboard.exportExcel}
        type="button"
      >
        Export Excel
      </button>
      <button
        className="ghost-button"
        disabled={!dashboard.hasExportRows}
        onClick={dashboard.exportRows}
        type="button"
      >
        Export CSV
      </button>
      <button className="ghost-button" onClick={dashboard.clearResults} type="button">
        Clear results
      </button>
    </div>
  );
  const getWikipediaCheckResultForSite = async (normalizedSite: string) => {
    const siteResult = await fetchSiteDashboardData({
      apiBaseUrl: effectiveApiBaseUrl,
      apiKey: dashboard.config.apiKey,
      proxyConfig: dashboard.spacecatProxyConfig,
      siteInput: normalizedSite,
    });
    const wikipediaOpportunities = siteResult.opportunities.filter(
      (opportunity) => opportunity.opportunityType === 'Wikipedia',
    );

    if (wikipediaOpportunities.length === 0) {
      return buildMissingWikipediaUrlCheckResult(siteResult, {
        verdictLabel: 'No Wikipedia opportunity',
        summary: 'The backend did not return a Wikipedia opportunity for this site.',
        rationale:
          'There is no Wikipedia opportunity in the backend response, so the AI evaluator could not assess a backend wikipediaUrl.',
      });
    }

    const wikipediaOpportunityWithUrl = wikipediaOpportunities.find(
      (opportunity) => opportunity.wikipediaUrl,
    );

    if (!wikipediaOpportunityWithUrl?.wikipediaUrl) {
      return buildMissingWikipediaUrlCheckResult(siteResult, {
        opportunityId: wikipediaOpportunities[0]?.opportunityId,
        verdictLabel: 'No backend Wikipedia URL',
        summary: 'A Wikipedia opportunity exists, but the backend did not return a wikipediaUrl.',
        rationale:
          'The check only evaluates the backend wikipediaUrl field. That field is missing in this response.',
      });
    }

    const evaluation = await evaluateWikipediaUrl({
      site: normalizedSite,
      resolvedSiteUrl: siteResult.resolvedSiteUrl,
      siteId: siteResult.siteId,
      opportunityId: wikipediaOpportunityWithUrl.opportunityId,
      wikipediaUrl: wikipediaOpportunityWithUrl.wikipediaUrl,
    });

    return buildWikipediaUrlCheckResult(
      siteResult,
      wikipediaOpportunityWithUrl.wikipediaUrl,
      evaluation,
    );
  };
  const runWikipediaCheck = async () => {
    const normalizedSite = normalizeSiteInput(wikipediaCheckSiteInput);

    if (!normalizedSite) {
      setWikipediaCheckStatus('error');
      setWikipediaCheckError('Enter a valid site URL or domain to run the check.');
      setWikipediaCheckResult(null);
      return;
    }

    if (!canRunWikipediaCheck) {
      setWikipediaCheckStatus('error');
      setWikipediaCheckError(
        'Configure the backend connection first so the checker can fetch live opportunity data.',
      );
      setWikipediaCheckResult(null);
      return;
    }

    setWikipediaCheckStatus('loading');
    setWikipediaCheckError('');

    try {
      const result = await getWikipediaCheckResultForSite(normalizedSite);

      setWikipediaCheckResult(result);
      setWikipediaCheckStatus('success');
    } catch (error) {
      const message =
        error instanceof SpacecatApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Wikipedia URL check failed.';

      setWikipediaCheckStatus('error');
      setWikipediaCheckError(message);
      setWikipediaCheckResult(null);
    }
  };
  const runWikipediaBatchCheck = async () => {
    if (wikipediaBatchSites.length === 0) {
      setWikipediaBatchStatus('error');
      setWikipediaBatchError('Add one or more site URLs or domains to run the batch check.');
      setWikipediaBatchResults([]);
      return;
    }

    if (!canRunWikipediaCheck) {
      setWikipediaBatchStatus('error');
      setWikipediaBatchError(
        'Configure the backend connection first so the checker can fetch live opportunity data.',
      );
      setWikipediaBatchResults([]);
      return;
    }

    setWikipediaBatchStatus('loading');
    setWikipediaBatchError('');
    setWikipediaBatchResults([]);
    setWikipediaBatchProgress({
      completed: 0,
      total: wikipediaBatchSites.length,
    });

    const nextResults: WikipediaUrlCheckResult[] = [];

    for (const site of wikipediaBatchSites) {
      try {
        const result = await getWikipediaCheckResultForSite(site);
        nextResults.push(result);
      } catch (error) {
        const message =
          error instanceof SpacecatApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Wikipedia URL check failed.';

        nextResults.push(buildWikipediaCheckFailureResult(site, message));
      }

      setWikipediaBatchResults([...nextResults]);
      setWikipediaBatchProgress({
        completed: nextResults.length,
        total: wikipediaBatchSites.length,
      });
    }

    setWikipediaCheckResult(nextResults[0] ?? null);
    setWikipediaBatchStatus('success');
  };

  return (
    <div className="dashboard-shell">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>Off-Site Opportunity Monitor</h1>
          <p>
            Resolve site IDs, pull fresh off-site opportunity rows, and verify
            suggestions, sentiment, and share of voice in one review workspace.
          </p>
          <div className="hero-signal-row">
            <HeroSignal
              label="Mode"
              value={currentModeLabel}
              tone={dashboard.spacecatProxyConfig.configured ? 'accent' : 'warm'}
            />
            <HeroSignal
              label="Visible scope"
              value={`${visibleOpportunityCount} opportunities`}
            />
            <HeroSignal
              label="Needs review"
              value={`${pendingReviewCount} rows`}
              tone={pendingReviewCount > 0 ? 'warm' : 'accent'}
            />
          </div>
          {!isManagedConnection ? workspaceActionButtons('hero-actions') : null}
        </div>
        <aside className="hero-command">
          <div className="hero-command-copy">
            <span className="hero-command-label">Current workspace</span>
            <p>Review the configured site set and current off-site selection.</p>
          </div>
          <div className="hero-stats">
            <StatsCard
              label="Configured sites"
              value={String(dashboard.configuredSites.length)}
              detail={
                dashboard.configuredSites.length === 0
                  ? 'Waiting for inputs'
                  : `${syncedSiteCount} synced`
              }
            />
            <StatsCard
              label="Matching opportunities"
              value={String(dashboard.summary.opportunityCount)}
              detail={`${visibleOpportunityCount} in view`}
            />
            <StatsCard
              label="Suggestions"
              value={String(dashboard.summary.suggestionCount)}
              detail={`${visibleSuggestionCount} on this page`}
            />
          </div>
          <div className="hero-command-notes">
            <div className="hero-note">
              <span className="hero-note-label">Filters</span>
              <strong>{activeFilterLabel}</strong>
            </div>
            <div className="hero-note">
              <span className="hero-note-label">Active lane</span>
              <strong>{activeWorkspaceLabel}</strong>
            </div>
          </div>
        </aside>
      </header>

      <main className="dashboard-layout">
        <section className="workspace-shell">
          <aside className="panel panel-tone-neutral workspace-sidebar">
            <div className="workspace-sidebar-copy">
              <span className="hero-command-label">Sidebar</span>
              <h2>Review lanes</h2>
              <p>
                Separate the raw backend opportunity feed, evaluation workflows, and
                one-off Wikipedia URL validation.
              </p>
            </div>

            <div className="workspace-nav">
              <WorkspaceNavButton
                active={activeWorkspace === 'opportunities'}
                count={`${visibleOpportunityCount}`}
                description="Backend opportunities, coverage, site state, sentiment rows, and extracted suggestions."
                label="Opportunities"
                onClick={() => setActiveWorkspace('opportunities')}
              />
              <WorkspaceNavButton
                active={activeWorkspace === 'evaluation'}
                count={`${pendingReviewCount}`}
                description="Sentiment, Share of Voice, and Suggestion evaluation tables with selection and export actions."
                label="Evaluation"
                onClick={() => setActiveWorkspace('evaluation')}
              />
              <WorkspaceNavButton
                active={activeWorkspace === 'wikipedia-check'}
                count={wikipediaCheckResult ? wikipediaCheckResult.verdictLabel : ''}
                description="Enter a domain and check whether the backend’s Wikipedia page looks aligned with it."
                label="Wikipedia Check"
                onClick={() => setActiveWorkspace('wikipedia-check')}
              />
            </div>

            <div className="workspace-sidebar-metrics">
              <div className="workspace-sidebar-metric">
                <span>Visible opportunities</span>
                <strong>{visibleOpportunityCount}</strong>
              </div>
              <div className="workspace-sidebar-metric">
                <span>Suggestions in view</span>
                <strong>{visibleSuggestionCount}</strong>
              </div>
              <div className="workspace-sidebar-metric">
                <span>Pending review</span>
                <strong>{pendingReviewCount}</strong>
              </div>
            </div>
          </aside>

          <div className="workspace-content">
            {activeWorkspace === 'opportunities' && (
              <div className="workspace-mode-stack">
                <section className="dashboard-overview-grid">
                  <section className="panel panel-settings panel-settings-compact panel-tone-warm">
                    <div className="panel-header">
                      <div>
                        <h2>Workspace Setup</h2>
                        <p>
                          Define the site set for this workspace. Connection details
                          stay out of the operating surface when the server handles them
                          for you.
                        </p>
                      </div>
                    </div>

                    {isManagedConnection ? (
                      <div className="managed-connection-note">
                        <span className="managed-connection-pill">
                          Managed connection active
                        </span>
                        <p>
                          Authentication and endpoint routing are handled server-side
                          for this deployment.
                        </p>
                      </div>
                    ) : null}

                    <div
                      className={`settings-grid ${
                        isManagedConnection ? 'settings-grid-managed' : ''
                      }`}
                    >
                      {!isManagedConnection ? (
                        <>
                          <label className="field">
                            <span>Endpoint</span>
                            <input
                              className="text-input"
                              type="text"
                              value={dashboard.config.apiBaseUrl}
                              onChange={(event) =>
                                dashboard.setApiBaseUrl(event.target.value)
                              }
                              placeholder="https://api.example.com/v1"
                            />
                            <small className="field-note">
                              Requests use this endpoint for site lookup and
                              opportunity data.
                            </small>
                          </label>

                          <label className="field">
                            <span>Access token</span>
                            <input
                              className="text-input"
                              type="password"
                              value={dashboard.config.apiKey}
                              onChange={(event) => dashboard.setApiKey(event.target.value)}
                              placeholder="Paste your access token"
                            />
                            <small className="field-note">
                              Token entry is manual and is not persisted in
                              localStorage.
                            </small>
                          </label>
                        </>
                      ) : null}

                      <label className="field field-site-urls">
                        <span>Site URLs</span>
                        <textarea
                          className="textarea-input textarea-input-compact"
                          value={dashboard.config.siteInputText}
                          onChange={(event) =>
                            dashboard.setSiteInputText(event.target.value)
                          }
                          placeholder={
                            'https://example.com\nhttps://www.example.org/products/widget'
                          }
                          rows={6}
                        />
                        <small className="field-note">
                          One URL per line. Full URLs are reduced into lookup
                          candidates automatically.
                        </small>
                      </label>
                    </div>
                    {isManagedConnection
                      ? workspaceActionButtons('button-row settings-actions')
                      : null}
                  </section>

                  <section className="panel panel-filters panel-tone-cool">
                    <div className="panel-header">
                      <div>
                        <h2>View Filters</h2>
                        <p>Select an off-site opportunity to review.</p>
                      </div>
                      <button
                        className="ghost-button"
                        onClick={dashboard.resetFilters}
                        type="button"
                      >
                        Reset filters
                      </button>
                    </div>

                    <div className="filter-group">
                      <span className="filter-label">Opportunity types</span>
                      <div className="chip-row">
                        {TARGET_OPPORTUNITY_TYPES.map((type) => (
                          <FilterChip
                            key={type}
                            active={dashboard.selectedTypes.includes(type)}
                            label={type}
                            count={dashboard.summary.typeCounts[type]}
                            onClick={() => dashboard.toggleType(type)}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="filter-group">
                      <span className="filter-label">Sites</span>
                      <div className="chip-row">
                        {dashboard.configuredSites.map((site) => (
                          <FilterChip
                            key={site}
                            active={dashboard.selectedSites.includes(site)}
                            label={site}
                            onClick={() => dashboard.toggleSite(site)}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="filter-group">
                      <span className="filter-label">Opportunity Type Order</span>
                      <div className="chip-row">
                        <FilterChip
                          active={dashboard.typeSortOrder === 'default'}
                          label="Default"
                          onClick={() => dashboard.setTypeSortOrder('default')}
                        />
                        <FilterChip
                          active={dashboard.typeSortOrder === 'asc'}
                          label="A-Z"
                          onClick={() => dashboard.setTypeSortOrder('asc')}
                        />
                        <FilterChip
                          active={dashboard.typeSortOrder === 'desc'}
                          label="Z-A"
                          onClick={() => dashboard.setTypeSortOrder('desc')}
                        />
                      </div>
                    </div>
                  </section>
                </section>

                <section className="dashboard-secondary-grid">
                  <section className="panel panel-table panel-coverage panel-tone-neutral">
                    <div className="panel-header">
                      <div>
                        <h2>Opportunity coverage</h2>
                        <p>
                          Per-site existence check for Reddit, YouTube, Cited URLs,
                          and Wikipedia opportunities.
                        </p>
                      </div>

                      <div className="panel-header-actions">
                        <PanelToggleButton
                          expanded={isCoverageExpanded}
                          onClick={() => setIsCoverageExpanded((value) => !value)}
                        />
                      </div>
                    </div>

                    {isCoverageExpanded && <CoverageTable rows={dashboard.sitePresenceRows} />}
                  </section>

                  <section className="panel panel-sites panel-sites-inline panel-tone-neutral">
                    <div className="panel-header">
                      <div>
                        <h2>Sites</h2>
                        <p>Per-site sync state, lookup result, and inline API errors.</p>
                      </div>

                      <div className="panel-header-actions">
                        <PanelToggleButton
                          expanded={isSitesExpanded}
                          onClick={() => setIsSitesExpanded((value) => !value)}
                        />
                      </div>
                    </div>

                    {isSitesExpanded && (
                      <div className="site-grid">
                        {dashboard.siteCards.length === 0 ? (
                          <div className="empty-panel">
                            <h3>Add at least one site URL</h3>
                            <p>The dashboard will create a card for each configured site.</p>
                          </div>
                        ) : (
                          dashboard.siteCards.map((site) => (
                            <SiteCard
                              key={site.requestSite}
                              site={site}
                              onRefresh={(requestSite) =>
                                void dashboard.refreshSite(requestSite)
                              }
                            />
                          ))
                        )}
                      </div>
                    )}
                  </section>
                </section>

                <div className="dashboard-data-stack">
                  <section className="panel panel-table panel-table-wide panel-tone-data">
                    <div className="panel-header">
                      <div>
                        <h2>Sentiment &amp; Share of Voice</h2>
                        <p>
                          {visibleSentimentCount} URL entr
                          {visibleSentimentCount === 1 ? 'y' : 'ies'} from{' '}
                          {visibleSentimentOpportunityCount} opportunit
                          {visibleSentimentOpportunityCount === 1 ? 'y' : 'ies'} across{' '}
                          {visibleSentimentSiteCount} site
                          {visibleSentimentSiteCount === 1 ? '' : 's'}.
                        </p>
                      </div>

                      <div className="panel-header-actions">
                        {isSentimentExpanded && dashboard.totalPages > 1 && (
                          <div className="table-controls">
                            <label className="inline-field">
                              <span>Rows per page</span>
                              <select
                                className="select-input"
                                value={dashboard.pageSize}
                                onChange={(event) =>
                                  dashboard.setPageSize(
                                    Number.parseInt(event.target.value, 10),
                                  )
                                }
                              >
                                {[25, 50, 100].map((size) => (
                                  <option key={size} value={size}>
                                    {size}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="pagination-controls">
                              <button
                                className="ghost-button"
                                disabled={dashboard.page <= 1}
                                onClick={() => dashboard.setPage(dashboard.page - 1)}
                                type="button"
                              >
                                Previous
                              </button>
                              <span className="page-indicator">
                                Page {dashboard.page} / {dashboard.totalPages}
                              </span>
                              <button
                                className="ghost-button"
                                disabled={dashboard.page >= dashboard.totalPages}
                                onClick={() => dashboard.setPage(dashboard.page + 1)}
                                type="button"
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        )}
                        <PanelToggleButton
                          expanded={isSentimentExpanded}
                          onClick={() => setIsSentimentExpanded((value) => !value)}
                        />
                      </div>
                    </div>

                    {isSentimentExpanded && (
                      <SentimentTable rows={dashboard.pagedOpportunityRows} />
                    )}
                  </section>

                  <section className="panel panel-table panel-table-wide panel-tone-data">
                    <div className="panel-header">
                      <div>
                        <h2>Suggestions</h2>
                        <p>
                          {visibleSuggestionCount} suggestion
                          {visibleSuggestionCount === 1 ? '' : 's'} across{' '}
                          {visibleSuggestionOpportunityCount} opportunit
                          {visibleSuggestionOpportunityCount === 1 ? 'y' : 'ies'} in the
                          current filtered view.
                        </p>
                      </div>

                      <div className="panel-header-actions">
                        <PanelToggleButton
                          expanded={isSuggestionsExpanded}
                          onClick={() => setIsSuggestionsExpanded((value) => !value)}
                        />
                      </div>
                    </div>

                    {isSuggestionsExpanded && (
                      <SuggestionsTable rows={dashboard.pagedOpportunityRows} />
                    )}
                  </section>
                </div>
              </div>
            )}

            {activeWorkspace === 'evaluation' && (
              <div className="workspace-mode-stack">
                <section className="panel panel-tone-evaluate panel-mode-intro">
                  <div className="panel-header">
                    <div>
                      <h2>Evaluation Workspace</h2>
                      <p>
                        Run suggestion, sentiment, and share-of-voice checks without
                        mixing them into the raw opportunity feed.
                      </p>
                    </div>
                  </div>

                  <div className="workspace-summary-grid">
                    <StatsCard
                      label="Sentiment evals"
                      value={String(evaluationSummary.evaluated)}
                      detail={
                        sentimentHallucinationRate !== null
                          ? `${sentimentHallucinationRate}% hallucination rate`
                          : `${evaluationSummary.review} require review`
                      }
                    />
                    <StatsCard
                      label="Share of Voice evals"
                      value={String(sovEvaluationSummary.evaluated)}
                      detail={
                        sovHallucinationRate !== null
                          ? `${sovHallucinationRate}% hallucination rate`
                          : `${sovEvaluationSummary.review} require review`
                      }
                    />
                    <StatsCard
                      label="Suggestion evals"
                      value={String(suggestionEvaluationSummary.evaluated)}
                      detail={
                        suggestionHallucinationRate !== null
                          ? `${suggestionHallucinationRate}% hallucination rate`
                          : `${suggestionEvaluationSummary.review + suggestionEvaluationSummary.incorrect} require review`
                      }
                    />
                  </div>
                </section>

                <div className="dashboard-data-stack">
                  <section className="panel panel-table panel-table-wide panel-tone-evaluate">
                    <div className="panel-header">
                      <div>
                        <h2>Sentiment</h2>
                        <p>
                          Independently re-check extracted sentiment for{' '}
                          {visibleEvaluationCount} URL entr
                          {visibleEvaluationCount === 1 ? 'y' : 'ies'} on the current
                          page.
                        </p>
                        <p className="panel-summary">
                          {evaluationSummary.evaluated === 0
                            ? 'No evaluation results yet on this page.'
                            : <>
                                {`Correct: ${evaluationSummary.confirmed} · Incorrect: ${evaluationSummary.incorrect} · Needs review: ${evaluationSummary.review} · Not evaluated: ${evaluationSummary.notEvaluated}`}
                                {sentimentHallucinationRate !== null && (
                                  <span className="hallucination-rate-pill">
                                    {sentimentHallucinationRate}% hallucination rate
                                  </span>
                                )}
                              </>
                          }
                        </p>
                      </div>

                      <div className="panel-header-actions">
                        {isEvaluationExpanded && (
                          <div className="table-controls">
                            <button
                              className="primary-button"
                              disabled={
                                visibleSelectedEvaluationRowsCount === 0 ||
                                dashboard.isEvaluatingSentiment
                              }
                              onClick={() =>
                                void dashboard.evaluateSentimentRows(
                                  visibleSelectedEvaluationRowKeys,
                                )
                              }
                              type="button"
                            >
                              {dashboard.isEvaluatingSentiment
                                ? 'Evaluating...'
                                : `Evaluate Selected Rows (${visibleSelectedEvaluationRowsCount})`}
                            </button>
                            <button
                              className="primary-button"
                              disabled={!dashboard.hasExportRows}
                              onClick={dashboard.exportSentimentEvaluation}
                              type="button"
                            >
                              Export Sentiment
                            </button>
                          </div>
                        )}
                        <PanelToggleButton
                          expanded={isEvaluationExpanded}
                          onClick={() => setIsEvaluationExpanded((value) => !value)}
                        />
                      </div>
                    </div>

                    {isEvaluationExpanded && (
                      <EvaluationTable
                        rows={evaluationOpportunityRows}
                        selectedRowKeys={dashboard.selectedSentimentRowKeys}
                        onToggleRowSelection={dashboard.toggleSentimentRowSelection}
                        onSelectRows={dashboard.setSentimentRowSelections}
                        onEvaluateRow={(rowKey) =>
                          void dashboard.evaluateSentimentRows([rowKey])
                        }
                        isEvaluating={dashboard.isEvaluatingSentiment}
                      />
                    )}
                  </section>

                  <section className="panel panel-table panel-table-wide panel-tone-evaluate">
                    <div className="panel-header">
                      <div>
                        <h2>Share of Voice</h2>
                        <p>
                          Re-check extracted share of voice for {visibleEvaluationCount}{' '}
                          URL entr
                          {visibleEvaluationCount === 1 ? 'y' : 'ies'} on the current
                          page.
                        </p>
                        <p className="panel-summary">
                          {sovEvaluationSummary.evaluated === 0
                            ? 'No Share of Voice evaluation results yet on this page. Use the sentiment evaluation above to run checks.'
                            : <>
                                {`Correct: ${sovEvaluationSummary.confirmed} · Incorrect: ${sovEvaluationSummary.incorrect} · Needs review: ${sovEvaluationSummary.review} · Not evaluated: ${sovEvaluationSummary.notEvaluated}`}
                                {sovHallucinationRate !== null && (
                                  <span className="hallucination-rate-pill">
                                    {sovHallucinationRate}% hallucination rate
                                  </span>
                                )}
                              </>
                          }
                        </p>
                      </div>

                      <div className="panel-header-actions">
                        {isSovEvaluationExpanded && (
                          <div className="table-controls">
                            <button
                              className="primary-button"
                              disabled={
                                visibleSelectedSovEvaluationRowsCount === 0 ||
                                dashboard.isEvaluatingSentiment
                              }
                              onClick={() =>
                                void dashboard.evaluateSentimentRows(
                                  visibleSelectedSovEvaluationRowKeys,
                                )
                              }
                              type="button"
                            >
                              {dashboard.isEvaluatingSentiment
                                ? 'Evaluating...'
                                : `Evaluate Selected Rows (${visibleSelectedSovEvaluationRowsCount})`}
                            </button>
                            <button
                              className="primary-button"
                              disabled={!dashboard.hasExportRows}
                              onClick={dashboard.exportSovEvaluation}
                              type="button"
                            >
                              Export SOV
                            </button>
                          </div>
                        )}
                        <PanelToggleButton
                          expanded={isSovEvaluationExpanded}
                          onClick={() => setIsSovEvaluationExpanded((value) => !value)}
                        />
                      </div>
                    </div>

                    {isSovEvaluationExpanded && (
                      <SovEvaluationTable
                        rows={dashboard.pagedOpportunityRows}
                        selectedRowKeys={dashboard.selectedSentimentRowKeys}
                        onToggleRowSelection={dashboard.toggleSentimentRowSelection}
                        onSelectRows={dashboard.setSentimentRowSelections}
                        onEvaluateRow={(rowKey) =>
                          void dashboard.evaluateSentimentRows([rowKey])
                        }
                        isEvaluating={dashboard.isEvaluatingSentiment}
                      />
                    )}
                  </section>

                  <section className="panel panel-table panel-table-wide panel-tone-evaluate">
                    <div className="panel-header">
                      <div>
                        <h2>Suggestions</h2>
                        <p>
                          Validate {visibleSuggestionEvaluationCount} suggestion
                          {visibleSuggestionEvaluationCount === 1 ? '' : 's'} on the
                          current page against off-site evidence.
                        </p>
                        <p className="panel-summary">
                          {suggestionEvaluationSummary.evaluated === 0
                            ? 'No suggestion evaluation results yet on this page.'
                            : <>
                                {`Correct: ${suggestionEvaluationSummary.confirmed} · Incorrect: ${suggestionEvaluationSummary.incorrect} · Needs review: ${suggestionEvaluationSummary.review} · Not evaluated: ${suggestionEvaluationSummary.notEvaluated}`}
                                {suggestionHallucinationRate !== null && (
                                  <span className="hallucination-rate-pill">
                                    {suggestionHallucinationRate}% hallucination rate
                                  </span>
                                )}
                              </>
                          }
                        </p>
                      </div>

                      <div className="panel-header-actions">
                        {isSuggestionEvaluationExpanded && (
                          <div className="table-controls">
                            <button
                              className="primary-button"
                              disabled={
                                dashboard.selectedVisibleSuggestionRowsCount === 0 ||
                                dashboard.isEvaluatingSuggestions
                              }
                              onClick={() =>
                                void dashboard.evaluateSuggestionRows(
                                  dashboard.selectedVisibleSuggestionRowKeys,
                                )
                              }
                              type="button"
                            >
                              {dashboard.isEvaluatingSuggestions
                                ? 'Evaluating...'
                                : `Evaluate Selected Rows (${dashboard.selectedVisibleSuggestionRowsCount})`}
                            </button>
                            <button
                              className="primary-button"
                              disabled={!dashboard.hasExportRows}
                              onClick={dashboard.exportSuggestionEvaluation}
                              type="button"
                            >
                              Export Suggestions
                            </button>
                          </div>
                        )}
                        <PanelToggleButton
                          expanded={isSuggestionEvaluationExpanded}
                          onClick={() =>
                            setIsSuggestionEvaluationExpanded((value) => !value)
                          }
                        />
                      </div>
                    </div>

                    {isSuggestionEvaluationExpanded && (
                      <SuggestionEvaluationTable
                        rows={dashboard.pagedOpportunityRows}
                        selectedRowKeys={dashboard.selectedSuggestionRowKeys}
                        onToggleRowSelection={dashboard.toggleSuggestionRowSelection}
                        onSelectRows={dashboard.setSuggestionRowSelections}
                        onEvaluateRow={(rowKey) =>
                          void dashboard.evaluateSuggestionRows([rowKey])
                        }
                        isEvaluating={dashboard.isEvaluatingSuggestions}
                      />
                    )}
                  </section>
                </div>
              </div>
            )}

            {activeWorkspace === 'wikipedia-check' && (
              <div className="workspace-mode-stack">
                <section className="panel panel-tone-warm panel-mode-intro">
                  <div className="panel-header">
                    <div>
                      <h2>Wikipedia Check</h2>
                      <p>
                        Enter a domain to fetch its live backend opportunity payload and
                        send the backend `wikipediaUrl` to an AI evaluator to judge
                        whether it matches the site.
                      </p>
                    </div>
                  </div>
                </section>

                <div className="wikipedia-check-layout">
                  <section className="panel panel-tone-neutral">
                    <div className="panel-header">
                      <div>
                        <h2>Check Input</h2>
                        <p>
                          This check compares the backend Wikipedia title against the
                          site domain. It does not validate article quality or content.
                        </p>
                      </div>
                    </div>

                    <form
                      className="wikipedia-check-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runWikipediaCheck();
                      }}
                    >
                      <label className="field">
                        <span>Site URL or domain</span>
                        <input
                          className="text-input"
                          type="text"
                          value={wikipediaCheckSiteInput}
                          onChange={(event) =>
                            setWikipediaCheckSiteInput(event.target.value)
                          }
                          placeholder="https://www.landrover.com or landrover.com"
                        />
                        <small className="field-note">
                          The checker resolves the site through the same backend used by
                          the dashboard, then evaluates only the returned
                          `wikipediaUrl` field with the AI evaluator.
                        </small>
                      </label>

                      <div className="button-row">
                        <button
                          className="primary-button"
                          disabled={
                            wikipediaCheckStatus === 'loading' ||
                            !normalizeSiteInput(wikipediaCheckSiteInput) ||
                            !canRunWikipediaCheck
                          }
                          type="submit"
                        >
                          {wikipediaCheckStatus === 'loading'
                            ? 'Checking...'
                            : 'Check Wikipedia URL'}
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => {
                            setWikipediaCheckSiteInput('');
                            setWikipediaCheckStatus('idle');
                            setWikipediaCheckError('');
                            setWikipediaCheckResult(null);
                          }}
                          type="button"
                        >
                          Clear
                        </button>
                      </div>
                    </form>

                    <form
                      className="wikipedia-check-form wikipedia-batch-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runWikipediaBatchCheck();
                      }}
                    >
                      <div className="callout callout-tip">
                        <strong>💡 Use bare domains, not full URLs</strong>
                        <p>
                          Enter <code>pwc.com</code> rather than <code>https://www.pwc.com/</code>.
                          The backend stores <code>www</code> and non-<code>www</code> as
                          separate site records — the non-<code>www</code> form is more
                          likely to carry Wikipedia data.
                        </p>
                      </div>

                      <label className="field">
                        <span>Batch site URLs or domains</span>
                        <textarea
                          className="textarea-input textarea-input-compact wikipedia-batch-input"
                          value={wikipediaBatchInputText}
                          onChange={(event) =>
                            setWikipediaBatchInputText(event.target.value)
                          }
                          placeholder={
                            'landroverusa.com\njaguarusa.com\nvolvocars.com'
                          }
                          rows={8}
                        />
                        <small className="field-note">One site per line.</small>
                      </label>

                      <div className="button-row">
                        <button
                          className="primary-button"
                          disabled={
                            wikipediaBatchStatus === 'loading' ||
                            wikipediaBatchSites.length === 0 ||
                            !canRunWikipediaCheck
                          }
                          type="submit"
                        >
                          {wikipediaBatchStatus === 'loading'
                            ? `Checking ${wikipediaBatchProgress.completed}/${wikipediaBatchProgress.total}...`
                            : `Run Batch Check (${wikipediaBatchSites.length})`}
                        </button>
                        <button
                          className="primary-button"
                          disabled={wikipediaBatchResults.length === 0}
                          onClick={() =>
                            downloadWikipediaBatchResultsExcel(wikipediaBatchResults)
                          }
                          type="button"
                        >
                          Export Excel
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => {
                            setWikipediaBatchInputText('');
                            setWikipediaBatchStatus('idle');
                            setWikipediaBatchError('');
                            setWikipediaBatchResults([]);
                            setWikipediaBatchProgress({
                              completed: 0,
                              total: 0,
                            });
                          }}
                          type="button"
                        >
                          Clear batch
                        </button>
                      </div>
                    </form>

                    {!canRunWikipediaCheck ? (
                      <div className="callout">
                        <strong>Connection required</strong>
                        <p>
                          Configure the backend connection in the Opportunities lane
                          before running an ad hoc Wikipedia URL check.
                        </p>
                      </div>
                    ) : null}

                    {wikipediaCheckStatus === 'error' && wikipediaCheckError ? (
                      <div className="callout wikipedia-check-callout-error">
                        <strong>Check failed</strong>
                        <p>{wikipediaCheckError}</p>
                      </div>
                    ) : null}

                    {wikipediaBatchStatus === 'error' && wikipediaBatchError ? (
                      <div className="callout wikipedia-check-callout-error">
                        <strong>Batch check failed</strong>
                        <p>{wikipediaBatchError}</p>
                      </div>
                    ) : null}
                  </section>

                  <section className="panel panel-tone-data">
                    <div className="panel-header">
                      <div>
                        <h2>Check Result</h2>
                        <p>
                          AI evaluator verdict for the latest single-site check.
                        </p>
                      </div>
                    </div>

                    {wikipediaCheckResult ? (
                      <div className="wikipedia-check-result-stack">
                        <div className="wikipedia-check-status-row">
                          <span
                            className={`status-pill status-pill-${getWikipediaStatusTone(
                              wikipediaCheckResult.verdict,
                            )}`}
                          >
                            {wikipediaCheckResult.verdictLabel}
                          </span>
                          {wikipediaCheckResult.confidence ? (
                            <span className="wikipedia-check-score">
                              Confidence: <strong>{capitalizeFirst(wikipediaCheckResult.confidence)}</strong>
                            </span>
                          ) : null}
                        </div>

                        <p className="wikipedia-check-summary">
                          {wikipediaCheckResult.summary}
                        </p>

                        <details className="wikipedia-result-details">
                          <summary>Show details</summary>
                          <div className="wikipedia-check-result-grid">
                            <article className="wikipedia-check-card">
                              <h3>Backend match</h3>
                              <dl className="wikipedia-check-definition-list">
                                <div>
                                  <dt>Requested site</dt>
                                  <dd>{wikipediaCheckResult.requestedSite}</dd>
                                </div>
                                <div>
                                  <dt>Resolved site</dt>
                                  <dd>
                                    {wikipediaCheckResult.resolvedSiteUrl ??
                                      'No resolved site returned'}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Site ID</dt>
                                  <dd>{wikipediaCheckResult.siteId ?? 'No site ID returned'}</dd>
                                </div>
                                <div>
                                  <dt>Opportunity ID</dt>
                                  <dd>
                                    {wikipediaCheckResult.opportunityId ??
                                      'No Wikipedia opportunity ID'}
                                  </dd>
                                </div>
                              </dl>
                            </article>

                            <article className="wikipedia-check-card">
                              <h3>Wikipedia URL</h3>
                              <dl className="wikipedia-check-definition-list">
                                <div>
                                  <dt>Primary backend URL</dt>
                                  <dd>
                                    {wikipediaCheckResult.backendWikipediaUrl ? (
                                      <a
                                        className="metric-link"
                                        href={wikipediaCheckResult.backendWikipediaUrl}
                                        rel="noreferrer"
                                        target="_blank"
                                      >
                                        {wikipediaCheckResult.backendWikipediaUrl}
                                      </a>
                                    ) : (
                                      'No Wikipedia URL found'
                                    )}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Extracted title</dt>
                                  <dd>
                                    {wikipediaCheckResult.extractedTitle ||
                                      'Could not derive a title from the backend URL'}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Wikipedia opportunities</dt>
                                  <dd>{wikipediaCheckResult.wikipediaOpportunityCount}</dd>
                                </div>
                                <div>
                                  <dt>Wikipedia suggestions</dt>
                                  <dd>{wikipediaCheckResult.wikipediaSuggestionCount}</dd>
                                </div>
                              </dl>
                            </article>

                            <article className="wikipedia-check-card">
                              <h3>Why this verdict</h3>
                              <p className="wikipedia-check-summary">
                                {wikipediaCheckResult.rationale}
                              </p>
                              {wikipediaCheckResult.evidenceSnippet ? (
                                <>
                                  <h4>Evidence</h4>
                                  <p className="wikipedia-check-summary">
                                    {wikipediaCheckResult.evidenceSnippet}
                                  </p>
                                </>
                              ) : null}
                            </article>
                          </div>
                        </details>
                      </div>
                    ) : (
                      <div className="empty-panel">
                        <h3>No check result yet</h3>
                        <p>
                          Submit a domain above to fetch backend data and inspect the
                          returned `wikipediaUrl` verdict.
                        </p>
                      </div>
                    )}
                  </section>
                </div>

                {wikipediaBatchResults.length > 0 ? (() => {
                  const correctCount = wikipediaBatchResults.filter(
                    (r) => r.verdict === 'Correct',
                  ).length;
                  const reviewCount = wikipediaBatchResults.filter(
                    (r) => r.verdict === 'Needs Review',
                  ).length;
                  const incorrectCount = wikipediaBatchResults.filter(
                    (r) => r.verdict === 'Incorrect',
                  ).length;
                  const unavailableCount = wikipediaBatchResults.filter(
                    (r) => !isClaudeWikipediaVerdict(r.verdict),
                  ).length;
                  const wikiHallucinationRate =
                    correctCount + incorrectCount > 0
                      ? Math.round(
                          (incorrectCount / (correctCount + incorrectCount)) * 100,
                        )
                      : null;

                  return (
                    <section className="panel panel-tone-data wikipedia-batch-panel">
                      <div className="panel-header">
                        <div>
                          <h2>Batch Results</h2>
                          <p>
                            AI evaluator verdicts for all {wikipediaBatchResults.length} sites in the batch run.
                          </p>
                        </div>
                        <div className="panel-summary">
                          <span>
                            Correct: <strong>{correctCount}</strong>
                          </span>
                          <span>
                            Needs review: <strong>{reviewCount}</strong>
                          </span>
                          <span>
                            Incorrect: <strong>{incorrectCount}</strong>
                          </span>
                          <span>
                            Missing/failed: <strong>{unavailableCount}</strong>
                          </span>
                          {wikiHallucinationRate !== null ? (
                            <span className="hallucination-rate-pill">
                              {wikiHallucinationRate}% hallucination rate
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="table-wrapper">
                        <table className="dashboard-table wikipedia-batch-table">
                          <thead>
                            <tr>
                              <th>Site</th>
                              <th>Wiki Opportunity</th>
                              <th>Wiki Page</th>
                              <th>Hallucination Rate</th>
                              <th>Confidence</th>
                              <th>Wikipedia URL</th>
                              <th>Title</th>
                              <th>Details</th>
                            </tr>
                          </thead>
                          <tbody>
                            {wikipediaBatchResults.map((result) => {
                              const wikiOpp =
                                result.wikipediaOpportunityCount > 0 ? 'Exists' : 'Missing';
                              const wikiPage = isClaudeWikipediaVerdict(result.verdict)
                                ? result.verdict
                                : 'N/A';
                              const hRate = getWikiHallucinationRate(result.verdict);
                              return (
                                <tr key={result.requestedSite}>
                                  <td>{result.requestedSite}</td>
                                  <td>
                                    <span
                                      className={`status-pill status-pill-${result.wikipediaOpportunityCount > 0 ? 'success' : 'neutral'}`}
                                    >
                                      {wikiOpp}
                                    </span>
                                  </td>
                                  <td>
                                    <span
                                      className={`status-pill status-pill-${getWikipediaStatusTone(
                                        result.verdict,
                                      )}`}
                                    >
                                      {wikiPage}
                                    </span>
                                  </td>
                                  <td>
                                    {hRate ? (
                                      <span className="hallucination-rate-pill">
                                        {hRate}
                                      </span>
                                    ) : (
                                      <span className="metric-neutral"> — </span>
                                    )}
                                  </td>
                                  <td>{capitalizeFirst(result.confidence)}</td>
                                  <td>
                                    {result.backendWikipediaUrl ? (
                                      <a
                                        className="metric-link"
                                        href={result.backendWikipediaUrl}
                                        rel="noreferrer"
                                        target="_blank"
                                      >
                                        {result.backendWikipediaUrl}
                                      </a>
                                    ) : (
                                      ' — '
                                    )}
                                  </td>
                                  <td>{result.extractedTitle ?? ' — '}</td>
                                  <td>
                                    <details className="wikipedia-batch-details">
                                      <summary>Show details</summary>
                                      <div className="wikipedia-batch-details-body">
                                        <strong>Why this verdict</strong>
                                        <p>{result.rationale}</p>
                                        {result.evidenceSnippet ? (
                                          <>
                                            <strong>Evidence</strong>
                                            <p>{result.evidenceSnippet}</p>
                                          </>
                                        ) : null}
                                      </div>
                                    </details>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  );
                })() : null}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
