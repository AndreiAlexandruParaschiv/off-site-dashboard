import { TARGET_OPPORTUNITY_TYPES } from './constants';
import { useOffSiteDashboard } from './useOffSiteDashboard';
import { formatTimestamp, getStatusTone, trimSuggestionText } from './utils';
import type {
  GroupedOpportunityRow,
  SiteDashboardResult,
  SiteOpportunityPresence,
} from './types';

function StatsCard(props: { label: string; value: string }) {
  return (
    <article className="stats-card">
      <span className="stats-label">{props.label}</span>
      <strong className="stats-value">{props.value}</strong>
    </article>
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
      <table className="dashboard-table">
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
              {TARGET_OPPORTUNITY_TYPES.map((type) => (
                <td key={`${row.site}-${type}`}>
                  <span
                    className={`presence-pill ${
                      row.presence[type] ? 'presence-pill-yes' : 'presence-pill-no'
                    }`}
                  >
                    {row.presence[type] ? 'Exists' : 'Missing'}
                  </span>
                </td>
              ))}
              <td>{row.statusMessage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DashboardTable(props: { rows: GroupedOpportunityRow[] }) {
  if (props.rows.length === 0) {
    return (
      <div className="table-empty-state">
        <h3>No rows match the current filters</h3>
        <p>
          Keep all opportunity types selected or refresh the configured sites to
          load new suggestions.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="dashboard-table">
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
                  <ol className="suggestion-list">
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
                  </ol>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OffSiteDashboard() {
  const dashboard = useOffSiteDashboard();
  const visibleOpportunityCount = dashboard.filteredOpportunityRows.length;
  const visibleSuggestionCount = dashboard.filteredOpportunityRows.reduce(
    (count, row) => count + row.suggestions.length,
    0,
  );
  const visibleSiteCount = new Set(
    dashboard.filteredOpportunityRows.map((row) => row.site),
  ).size;

  return (
    <div className="dashboard-shell">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>Off-Site opportunity monitor</h1>
          <p>
            Resolve site IDs from site URLs, fetch matching SpaceCat opportunities,
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
        <div className="dashboard-column dashboard-column-left">
          <section className="panel panel-settings">
            <div className="panel-header">
              <div>
                <h2>Settings</h2>
                <p>Configuration is stored locally in this browser.</p>
              </div>
            </div>

            <label className="field">
              <span>SpaceCat API base URL</span>
              <input
                className="text-input"
                type="text"
                value={dashboard.config.apiBaseUrl}
                onChange={(event) => dashboard.setApiBaseUrl(event.target.value)}
                placeholder="https://spacecat.experiencecloud.live"
              />
            </label>

            <label className="field">
              <span>API key</span>
              <input
                className="text-input"
                type="password"
                value={dashboard.config.apiKey}
                onChange={(event) => dashboard.setApiKey(event.target.value)}
                placeholder="Paste your SpaceCat API key"
              />
              <small className="field-note">
                API key is manual input only and is not persisted in localStorage.
              </small>
            </label>

            <label className="field">
              <span>Site URLs</span>
              <textarea
                className="textarea-input"
                value={dashboard.config.siteInputText}
                onChange={(event) => dashboard.setSiteInputText(event.target.value)}
                placeholder={
                  'https://example.com\nhttps://www.example.org/products/widget'
                }
                rows={8}
              />
              <small className="field-note">
                One URL per line. Full URLs are reduced into lookup candidates
                automatically.
              </small>
            </label>

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
                onClick={dashboard.clearResults}
                type="button"
              >
                Clear results
              </button>
            </div>
          </section>

          <section className="panel panel-sites">
            <div className="panel-header">
              <div>
                <h2>Sites</h2>
                <p>Per-site status, last sync time, and inline API errors.</p>
              </div>
            </div>

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
          </section>
        </div>

        <div className="dashboard-column dashboard-column-right">
          <section className="panel panel-table">
            <div className="panel-header">
              <div>
                <h2>Opportunity coverage</h2>
                <p>
                  Per-site existence check for Reddit, YouTube, Cited URLs, Prompt Gap,
                  and Wikipedia opportunities.
                </p>
              </div>
            </div>

            <CoverageTable rows={dashboard.sitePresenceRows} />
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
          </section>

          <section className="panel panel-table">
            <div className="panel-header">
              <div>
                <h2>Suggestions</h2>
                <p>
                  {visibleOpportunityCount} opportunit
                  {visibleOpportunityCount === 1 ? 'y' : 'ies'} with{' '}
                  {visibleSuggestionCount} suggestion
                  {visibleSuggestionCount === 1 ? '' : 's'} across{' '}
                  {visibleSiteCount} site{visibleSiteCount === 1 ? '' : 's'}.
                </p>
              </div>

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
            </div>

            <DashboardTable rows={dashboard.pagedOpportunityRows} />
          </section>
        </div>
      </main>
    </div>
  );
}
