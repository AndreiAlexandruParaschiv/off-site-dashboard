import { useState } from 'react';
import { TARGET_OPPORTUNITY_TYPES } from './constants';
import { getConfidenceBand, getConfidenceLabel } from './evaluation';
import { useOffSiteDashboard } from './useOffSiteDashboard';
import { formatTimestamp, getStatusTone, trimSuggestionText } from './utils';
import type {
  GroupedOpportunityRow,
  OpportunityPresenceState,
  SiteDashboardResult,
  SiteOpportunityPresence,
} from './types';

const SENTIMENT_OPPORTUNITY_TYPES = new Set<string>([
  'Reddit',
  'YouTube',
  'Cited URLs',
  'Prompt Gap',
]);

function StatsCard(props: { label: string; value: string }) {
  return (
    <article className="stats-card">
      <span className="stats-label">{props.label}</span>
      <strong className="stats-value">{props.value}</strong>
    </article>
  );
}

function PanelToggleButton(props: {
  expanded: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className="ghost-button panel-toggle-button"
      onClick={props.onClick}
      type="button"
      aria-expanded={props.expanded}
    >
      <span>{props.expanded ? 'Collapse' : 'Expand'} {props.label}</span>
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

  if (normalizedValue.includes('favorable')) {
    return 'success';
  }

  if (normalizedValue.includes('unfavorable')) {
    return 'error';
  }

  if (normalizedValue.includes('neutral')) {
    return 'warning';
  }

  return 'neutral';
}

function getDisplayUrl(value: string) {
  return value.replace(/^https?:\/\//i, '');
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
    getConfidenceLabel(input.sentimentConfidence) !== 'LOW'
  );
}

function getPresenceDetails(value: OpportunityPresenceState) {
  if (value === 'exists_mixed') {
    return {
      className: 'presence-pill-yes',
      label: 'Exists*',
      title: 'Both active and ignored opportunities were found for this type.',
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
            <th>Site ID</th>
            {TARGET_OPPORTUNITY_TYPES.map((type) => (
              <th key={type}>{type}</th>
            ))}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.site}>
              <td>{row.site}</td>
              <td>{row.siteId ?? ' - '}</td>
              {TARGET_OPPORTUNITY_TYPES.map((type) => {
                const presence = getPresenceDetails(row.presence[type]);

                return (
                  <td key={`${row.site}-${type}`}>
                    <span
                      className={`presence-pill ${presence.className}`}
                      title={presence.title}
                    >
                      {presence.label}
                    </span>
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

  return (
    <div className="table-wrapper">
      <table className="dashboard-table suggestions-table">
        <colgroup>
          <col className="suggestions-col-site" />
          <col className="suggestions-col-site-id" />
          <col className="suggestions-col-type" />
          <col className="suggestions-col-opportunity-id" />
          <col className="suggestions-col-suggestions" />
        </colgroup>
        <thead>
          <tr>
            <th>Site</th>
            <th>Site ID</th>
            <th>Opportunity Type</th>
            <th>Opportunity ID</th>
            <th>Suggestions</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.id}>
              <td>{row.site}</td>
              <td>{row.siteId ?? ' - '}</td>
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
                      const suggestionLines = suggestionText
                        ? suggestionText.split('\n')
                        : [];
                      const suggestionHeading =
                        suggestionLines.length > 1 ? suggestionLines[0] : '';
                      const suggestionBody =
                        suggestionLines.length > 1
                          ? suggestionLines.slice(1).join('\n')
                          : suggestionText;

                      return (
                        <li
                          className="suggestion-list-item"
                          key={`${row.id}-${suggestion.suggestionId ?? index}`}
                        >
                          {suggestion.suggestionId && (
                            <span className="suggestion-meta-id">
                              {suggestion.suggestionId}
                            </span>
                          )}
                          {suggestionHeading ? (
                            <>
                              <strong className="suggestion-heading">
                                {suggestionHeading}
                              </strong>
                              <span className="suggestion-copy">
                                {suggestionBody || ' - '}
                              </span>
                            </>
                          ) : (
                            <span className="suggestion-copy">
                              {suggestionBody || ' - '}
                            </span>
                          )}
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
          <col className="sentiment-col-site-id" />
          <col className="sentiment-col-type" />
          <col className="sentiment-col-opportunity-id" />
          <col className="sentiment-col-url" />
          <col className="sentiment-col-sov" />
          <col className="sentiment-col-sentiment" />
        </colgroup>
        <thead>
          <tr>
            <th>Site</th>
            <th>Site ID</th>
            <th>Opportunity Type</th>
            <th>Opportunity ID</th>
            <th>URL</th>
            <th>SOV</th>
            <th>Sentiment</th>
          </tr>
        </thead>
        <tbody>
          {sentimentRows.flatMap((row) => {
            if (row.sentimentItems.length === 0) {
              return (
                <tr key={`${row.id}-sentiment-empty`}>
                  <td>{row.site}</td>
                  <td>{row.siteId ?? ' - '}</td>
                  <td>{row.opportunityType ?? ' - '}</td>
                  <td>{row.opportunityId ?? ' - '}</td>
                  <td>
                    <span className="metric-copy metric-card" title={row.status}>
                      No URL / SOV / sentiment rows returned
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
                      <td rowSpan={rowSpan}>{row.site}</td>
                      <td rowSpan={rowSpan}>{row.siteId ?? ' - '}</td>
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
                    <span className="metric-copy metric-card" title={item.sov}>
                      {trimSuggestionText(item.sov) || ' - '}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`sentiment-pill sentiment-pill-${getSentimentTone(
                        item.sentiment,
                      )}`}
                      title={item.sentiment}
                    >
                      <span className="sentiment-dot" aria-hidden="true" />
                      <span className="sentiment-copy">
                        {trimSuggestionText(item.sentiment) || ' - '}
                      </span>
                    </span>
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

function EvaluationTable(props: {
  rows: GroupedOpportunityRow[];
  selectedRowKeys: string[];
  onToggleRowSelection: (rowKey: string) => void;
  onSelectRows: (rowKeys: string[], selected: boolean) => void;
  isEvaluating: boolean;
}) {
  const evaluationRows = props.rows
    .filter(
      (row) => row.opportunityType && SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType),
    )
    .flatMap((row) =>
      row.sentimentItems.map((item, index) => ({
        id: item.rowKey ?? `${row.id}-evaluation-${index}`,
        site: row.site,
        siteId: row.siteId,
        opportunityType: row.opportunityType ?? ' - ',
        opportunityId: row.opportunityId ?? ' - ',
        item,
      })),
    );
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
          <col className="evaluation-col-rationale" />
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
            <th>Opportunity Type</th>
            <th>URL</th>
            <th>Extracted Sentiment</th>
            <th>Confidence</th>
            <th>Evaluator Sentiment</th>
            <th>Rationale / Evidence</th>
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
            const evaluationResult = row.item.evaluationResult;
            const evaluationOutput = evaluationResult
              ? evaluationResult.evaluatedSentiment
              : 'Not evaluated';
            const rationaleOutput = row.item.evaluationError
              ? `Error: ${row.item.evaluationError}`
              : evaluationResult
                ? [
                    evaluationResult.rationale,
                    evaluationResult.evidenceSnippet
                      ? `Evidence: ${evaluationResult.evidenceSnippet}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                : 'Run evaluation to score sentiment.';

            return (
              <tr key={row.id}>
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
                  <span
                    className={`sentiment-pill sentiment-pill-${getSentimentTone(
                      row.item.sentiment,
                    )}`}
                    title={row.item.sentiment}
                  >
                    <span className="sentiment-dot" aria-hidden="true" />
                    <span className="sentiment-copy">
                      {trimSuggestionText(row.item.sentiment) || ' - '}
                    </span>
                  </span>
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
                    <span className="metric-copy metric-card">
                      {isRunning ? 'Evaluating...' : 'Not evaluated'}
                    </span>
                  )}
                </td>
                <td>
                  <span className="metric-copy metric-card" title={evaluationOutput}>
                    {evaluationOutput}
                  </span>
                </td>
                <td>
                  <span className="metric-copy metric-card" title={rationaleOutput}>
                    {rationaleOutput}
                  </span>
                </td>
                <td>
                  <span className="metric-copy metric-card">
                    {formatTimestamp(evaluationResult?.evaluatedAt)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OffSiteDashboard() {
  const [isCoverageExpanded, setIsCoverageExpanded] = useState(true);
  const dashboard = useOffSiteDashboard();
  const [isSitesExpanded, setIsSitesExpanded] = useState(false);
  const [isSentimentExpanded, setIsSentimentExpanded] = useState(true);
  const [isEvaluationExpanded, setIsEvaluationExpanded] = useState(false);
  const [isSuggestionsExpanded, setIsSuggestionsExpanded] = useState(true);
  const visibleOpportunityCount = dashboard.filteredOpportunityRows.length;
  const visibleSuggestionOpportunityCount = dashboard.filteredOpportunityRows.filter(
    (row) => row.suggestions.length > 0,
  ).length;
  const visibleSuggestionCount = dashboard.filteredOpportunityRows.reduce(
    (count, row) => count + row.suggestions.length,
    0,
  );
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
  const visibleEvaluationCount = dashboard.pagedOpportunityRows
    .filter(
      (row) => row.opportunityType && SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType),
    )
    .reduce((count, row) => count + row.sentimentItems.length, 0);
  const evaluationSummary = dashboard.pagedOpportunityRows
    .filter(
      (row) => row.opportunityType && SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType),
    )
    .flatMap((row) => row.sentimentItems)
    .reduce(
      (summary, item) => {
        if (item.evaluationResult) {
          summary.evaluated += 1;

          if (
            isConfirmedSentimentEvaluation({
              extractedSentiment: item.sentiment,
              evaluatedSentiment: item.evaluationResult.evaluatedSentiment,
              sentimentConfidence: item.evaluationResult.sentimentConfidence,
            })
          ) {
            summary.confirmed += 1;
          } else {
            summary.review += 1;
          }

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
      {
        evaluated: 0,
        confirmed: 0,
        review: 0,
        notEvaluated: 0,
      },
    );

  return (
    <div className="dashboard-shell">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>Off-Site Opportunity Monitor</h1>
          <p>
            Resolve site IDs from site URLs, fetch matching off-site opportunities,
            and review every Reddit, YouTube, Cited URLs, Prompt Gap, and Wikipedia
            suggestion in one place.
          </p>
        </div>
        <div className="hero-stats">
          <StatsCard
            label="Configured sites"
            value={String(dashboard.configuredSites.length)}
          />
          <StatsCard
            label="Matching opportunities"
            value={String(dashboard.summary.opportunityCount)}
          />
          <StatsCard
            label="Suggestions"
            value={String(dashboard.summary.suggestionCount)}
          />
        </div>
      </header>

      <main className="dashboard-layout">
        <section className="dashboard-overview-grid">
          <section className="panel panel-settings panel-settings-compact">
            <div className="panel-header">
              <div>
                <h2>Settings</h2>
                <p>Configuration is stored locally in this browser.</p>
              </div>
            </div>

            <div className="settings-grid">
              <label className="field">
                <span>API base URL</span>
                <input
                  className="text-input"
                  type="text"
                  value={dashboard.config.apiBaseUrl}
                  onChange={(event) => dashboard.setApiBaseUrl(event.target.value)}
                  placeholder="https://spacecat.experiencecloud.live/api/v1"
                />
              </label>

              <label className="field">
                <span>API key</span>
                <input
                  className="text-input"
                  type="password"
                  value={dashboard.config.apiKey}
                  onChange={(event) => dashboard.setApiKey(event.target.value)}
                  placeholder="Paste your API Key"
                />
                <small className="field-note">
                  API key is manual input only and is not persisted in localStorage.
                </small>
              </label>

              <label className="field field-site-urls">
                <span>Site URLs</span>
                <textarea
                  className="textarea-input textarea-input-compact"
                  value={dashboard.config.siteInputText}
                  onChange={(event) => dashboard.setSiteInputText(event.target.value)}
                  placeholder={
                    'https://example.com\nhttps://www.example.org/products/widget'
                  }
                  rows={6}
                />
                <small className="field-note">
                  One URL per line. Full URLs are reduced into lookup candidates
                  automatically.
                </small>
              </label>
            </div>

            <div className="button-row">
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
                onClick={dashboard.exportRows}
                type="button"
              >
                Export CSV
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
                onClick={dashboard.clearResults}
                type="button"
              >
                Clear results
              </button>
            </div>
          </section>

          <section className="panel panel-filters">
            <div className="panel-header">
              <div>
                <h2>Filters</h2>
                <p>Use multi-select chips to narrow the current table view.</p>
              </div>
              <button className="ghost-button" onClick={dashboard.resetFilters} type="button">
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

        <section className="panel panel-table panel-coverage">
          <div className="panel-header">
            <div>
              <h2>Opportunity coverage</h2>
              <p>
                Per-site existence check for Reddit, YouTube, Cited URLs, Prompt Gap,
                and Wikipedia opportunities.
              </p>
            </div>

            <div className="panel-header-actions">
              <PanelToggleButton
                expanded={isCoverageExpanded}
                onClick={() => setIsCoverageExpanded((value) => !value)}
                label="Opportunity coverage"
              />
            </div>
          </div>

          {isCoverageExpanded && <CoverageTable rows={dashboard.sitePresenceRows} />}
        </section>

        <section className="panel panel-sites panel-sites-inline">
          <div className="panel-header">
            <div>
              <h2>Sites</h2>
              <p>Per-site status, last sync time, and inline API errors.</p>
            </div>

            <div className="panel-header-actions">
              <PanelToggleButton
                expanded={isSitesExpanded}
                onClick={() => setIsSitesExpanded((value) => !value)}
                label="Sites"
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
                    onRefresh={(requestSite) => void dashboard.refreshSite(requestSite)}
                  />
                ))
              )}
            </div>
          )}
        </section>

        <section className="panel panel-table panel-table-wide">
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
              {isSentimentExpanded && (
                <div className="table-controls">
                  <label className="inline-field">
                    <span>Rows per page</span>
                    <select
                      className="select-input"
                      value={dashboard.pageSize}
                      onChange={(event) =>
                        dashboard.setPageSize(Number.parseInt(event.target.value, 10))
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
                label="Sentiment"
              />
            </div>
          </div>

          {isSentimentExpanded && (
            <SentimentTable rows={dashboard.pagedOpportunityRows} />
          )}
        </section>

        <section className="panel panel-table panel-table-wide">
          <div className="panel-header">
            <div>
              <h2>Sentiment Evaluation</h2>
              <p>
                Independently re-check extracted sentiment for{' '}
                {visibleEvaluationCount} URL entr
                {visibleEvaluationCount === 1 ? 'y' : 'ies'} on the current page.
              </p>
              <p className="panel-summary">
                {evaluationSummary.evaluated === 0
                  ? 'No evaluation results yet on this page.'
                  : `Confirmed: ${evaluationSummary.confirmed} · Needs review: ${evaluationSummary.review} · Not evaluated: ${evaluationSummary.notEvaluated}`}
              </p>
            </div>

            <div className="panel-header-actions">
              {isEvaluationExpanded && (
                <div className="table-controls">
                  <button
                    className="primary-button"
                    disabled={
                      dashboard.selectedVisibleSentimentRowsCount === 0 ||
                      dashboard.isEvaluatingSentiment
                    }
                    onClick={() =>
                      void dashboard.evaluateSentimentRows(
                        dashboard.selectedVisibleSentimentRowKeys,
                      )
                    }
                    type="button"
                  >
                    {dashboard.isEvaluatingSentiment
                      ? 'Evaluating...'
                      : `Evaluate Selected Rows (${dashboard.selectedVisibleSentimentRowsCount})`}
                  </button>
                </div>
              )}
              <PanelToggleButton
                expanded={isEvaluationExpanded}
                onClick={() => setIsEvaluationExpanded((value) => !value)}
                label="Evaluation"
              />
            </div>
          </div>

          {isEvaluationExpanded && (
            <EvaluationTable
              rows={dashboard.pagedOpportunityRows}
              selectedRowKeys={dashboard.selectedSentimentRowKeys}
              onToggleRowSelection={dashboard.toggleSentimentRowSelection}
              onSelectRows={dashboard.setSentimentRowSelections}
              isEvaluating={dashboard.isEvaluatingSentiment}
            />
          )}
        </section>

        <section className="panel panel-table panel-table-wide">
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
                label="Suggestions"
              />
            </div>
          </div>

          {isSuggestionsExpanded && <SuggestionsTable rows={dashboard.pagedOpportunityRows} />}
        </section>
      </main>
    </div>
  );
}
