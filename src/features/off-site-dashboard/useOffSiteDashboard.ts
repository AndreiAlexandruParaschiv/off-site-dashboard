import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { DEFAULT_PAGE_SIZE, TARGET_OPPORTUNITY_TYPES } from './constants';
import { downloadRowsAsCsv } from './csv';
import { SpacecatApiError, fetchSiteDashboardData } from './api';
import { loadDashboardConfig, saveDashboardConfig } from './storage';
import {
  createIdleSiteResult,
  flattenSiteRows,
  getOpportunityTypeSummary,
  normalizeApiBaseUrl,
  normalizeSiteInput,
  normalizeSiteList,
} from './utils';
import type {
  CanonicalOpportunityType,
  DashboardConfig,
  DashboardRow,
  GroupedOpportunityRow,
  SiteDashboardResult,
  SiteOpportunityPresence,
} from './types';

function updateSelection<T extends string>(values: T[], value: T) {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function groupOpportunityRows(rows: DashboardRow[]) {
  const groups = new Map<string, GroupedOpportunityRow>();

  rows.forEach((row) => {
    if (!row.opportunityType || !row.opportunityId) {
      return;
    }

    const groupId = [
      row.site,
      row.siteId ?? '',
      row.opportunityType,
      row.opportunityId,
    ].join('::');

    if (!groups.has(groupId)) {
      groups.set(groupId, {
        id: groupId,
        site: row.site,
        siteId: row.siteId,
        opportunityType: row.opportunityType,
        opportunityId: row.opportunityId,
        suggestions: [],
        status: row.status,
      });
    }

    if (row.suggestionId || row.suggestionText || row.suggestionUrl) {
      groups.get(groupId)?.suggestions.push({
        suggestionId: row.suggestionId,
        suggestionText: row.suggestionText,
        suggestionUrl: row.suggestionUrl,
      });
    }
  });

  return Array.from(groups.values());
}

export function useOffSiteDashboard() {
  const [config, setConfig] = useState<DashboardConfig>(() => loadDashboardConfig());
  const [siteResults, setSiteResults] = useState<Record<string, SiteDashboardResult>>(
    {},
  );
  const [selectedTypes, setSelectedTypes] = useState<CanonicalOpportunityType[]>(
    TARGET_OPPORTUNITY_TYPES,
  );
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [didAutoRefresh, setDidAutoRefresh] = useState(false);

  const configuredSites = useMemo(
    () => normalizeSiteList(config.siteInputText),
    [config.siteInputText],
  );

  useEffect(() => {
    saveDashboardConfig(config);
  }, [config]);

  useEffect(() => {
    setSiteResults((previousResults) => {
      const nextResults: Record<string, SiteDashboardResult> = {};

      configuredSites.forEach((site) => {
        nextResults[site] = previousResults[site] ?? createIdleSiteResult(site);
      });

      return nextResults;
    });
  }, [configuredSites]);

  useEffect(() => {
    setSelectedSites((previousSites) => {
      if (configuredSites.length === 0) {
        return [];
      }

      const filteredSites = previousSites.filter((site) =>
        configuredSites.includes(site),
      );

      return filteredSites.length > 0 ? filteredSites : configuredSites;
    });
  }, [configuredSites]);

  const refreshSite = useCallback(
    async (site: string) => {
      const normalizedSite = normalizeSiteInput(site);
      const normalizedApiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);

      if (!normalizedSite || !normalizedApiBaseUrl || !config.apiKey.trim()) {
        return;
      }

      setSiteResults((previousResults) => ({
        ...previousResults,
        [normalizedSite]: {
          ...(previousResults[normalizedSite] ?? createIdleSiteResult(normalizedSite)),
          requestSite: normalizedSite,
          status: 'loading',
          statusMessage: 'Fetching opportunities and suggestions',
          error: undefined,
          retryAfterSeconds: undefined,
        },
      }));

      try {
        const result = await fetchSiteDashboardData({
          apiBaseUrl: normalizedApiBaseUrl,
          apiKey: config.apiKey,
          siteInput: normalizedSite,
        });

        setSiteResults((previousResults) => ({
          ...previousResults,
          [normalizedSite]: result,
        }));
      } catch (error) {
        const apiError =
          error instanceof SpacecatApiError
            ? error
            : new SpacecatApiError('Unexpected dashboard error.');

        console.error(`Failed to refresh ${normalizedSite}.`, error);

        setSiteResults((previousResults) => {
          const previousSiteState =
            previousResults[normalizedSite] ?? createIdleSiteResult(normalizedSite);

          return {
            ...previousResults,
            [normalizedSite]: {
              ...previousSiteState,
              requestSite: normalizedSite,
              status: 'error',
              statusMessage:
                apiError.status === 429
                  ? apiError.message
                  : previousSiteState.opportunities.length > 0
                    ? 'Refresh failed; showing previous data'
                    : 'Refresh failed',
              error: apiError.message,
              retryAfterSeconds: apiError.retryAfterSeconds,
              lastUpdated: previousSiteState.lastUpdated ?? new Date().toISOString(),
            },
          };
        });
      }
    },
    [config.apiBaseUrl, config.apiKey],
  );

  const refreshAll = useCallback(async () => {
    if (!config.apiKey.trim() || !config.apiBaseUrl.trim()) {
      return;
    }

    await Promise.all(configuredSites.map((site) => refreshSite(site)));
  }, [config.apiBaseUrl, config.apiKey, configuredSites, refreshSite]);

  useEffect(() => {
    if (
      didAutoRefresh ||
      !config.apiKey.trim() ||
      !config.apiBaseUrl.trim() ||
      configuredSites.length === 0
    ) {
      return;
    }

    setDidAutoRefresh(true);
    void refreshAll();
  }, [
    config.apiBaseUrl,
    config.apiKey,
    configuredSites.length,
    didAutoRefresh,
    refreshAll,
  ]);

  const resetFilters = useCallback(() => {
    setSelectedTypes(TARGET_OPPORTUNITY_TYPES);
    setSelectedSites(configuredSites);
    setPage(1);
  }, [configuredSites]);

  const clearResults = useCallback(() => {
    setSiteResults(
      configuredSites.reduce<Record<string, SiteDashboardResult>>((results, site) => {
        results[site] = createIdleSiteResult(site);
        return results;
      }, {}),
    );
    setPage(1);
  }, [configuredSites]);

  const siteCards = useMemo(
    () => configuredSites.map((site) => siteResults[site] ?? createIdleSiteResult(site)),
    [configuredSites, siteResults],
  );

  const sitePresenceRows = useMemo<SiteOpportunityPresence[]>(() => {
    return siteCards.map((siteCard) => {
      const presence = TARGET_OPPORTUNITY_TYPES.reduce<
        Record<CanonicalOpportunityType, boolean>
      >(
        (nextPresence, type) => {
          nextPresence[type] = false;
          return nextPresence;
        },
        {
          Reddit: false,
          YouTube: false,
          'Cited URLs': false,
          'Prompt Gap': false,
          Wikipedia: false,
        },
      );

      siteCard.opportunities.forEach((opportunity) => {
        presence[opportunity.opportunityType] = true;
      });

      return {
        site: siteCard.requestSite,
        siteId: siteCard.siteId,
        lastUpdated: siteCard.lastUpdated,
        status: siteCard.status,
        statusMessage: siteCard.error ?? siteCard.statusMessage,
        presence,
      };
    });
  }, [siteCards]);

  const allRows = useMemo(() => flattenSiteRows(siteCards), [siteCards]);

  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      const siteMatches = selectedSites.includes(row.site);
      const typeMatches = row.opportunityType
        ? selectedTypes.includes(row.opportunityType)
        : true;

      return siteMatches && typeMatches;
    });
  }, [allRows, selectedSites, selectedTypes]);

  const filteredOpportunityRows = useMemo(
    () => groupOpportunityRows(filteredRows),
    [filteredRows],
  );

  const deferredRows = useDeferredValue(filteredOpportunityRows);

  const totalPages = Math.max(1, Math.ceil(deferredRows.length / pageSize));
  const pagedOpportunityRows = useMemo(() => {
    const startIndex = (page - 1) * pageSize;
    return deferredRows.slice(startIndex, startIndex + pageSize);
  }, [deferredRows, page, pageSize]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, totalPages));
  }, [totalPages]);

  const summary = useMemo(() => {
    const opportunityCount = siteCards.reduce(
      (count, siteCard) => count + siteCard.opportunities.length,
      0,
    );
    const suggestionCount = siteCards.reduce(
      (count, siteCard) =>
        count +
        siteCard.opportunities.reduce(
          (siteSuggestionCount, opportunity) =>
            siteSuggestionCount + opportunity.suggestions.length,
          0,
        ),
      0,
    );

    const siteScopedRows = allRows.filter((row) => selectedSites.includes(row.site));

    return {
      opportunityCount,
      suggestionCount,
      typeCounts: getOpportunityTypeSummary(siteScopedRows),
    };
  }, [allRows, selectedSites, siteCards]);

  const isRefreshing = siteCards.some((siteCard) => siteCard.status === 'loading');
  const canRefresh =
    Boolean(config.apiKey.trim()) &&
    Boolean(config.apiBaseUrl.trim()) &&
    configuredSites.length > 0;

  const exportableRows = useMemo(
    () => allRows.filter((row) => Boolean(row.opportunityId)),
    [allRows],
  );

  const exportRows = useCallback(() => {
    downloadRowsAsCsv(exportableRows);
  }, [exportableRows]);

  return {
    config,
    siteCards,
    sitePresenceRows,
    configuredSites,
    selectedTypes,
    selectedSites,
    page,
    pageSize,
    totalPages,
    isRefreshing,
    canRefresh,
    hasExportRows: exportableRows.length > 0,
    pagedOpportunityRows,
    filteredRows,
    filteredOpportunityRows,
    summary,
    setApiBaseUrl: (value: string) =>
      setConfig((previousConfig) => ({
        ...previousConfig,
        apiBaseUrl: value,
      })),
    setApiKey: (value: string) =>
      setConfig((previousConfig) => ({
        ...previousConfig,
        apiKey: value,
      })),
    setSiteInputText: (value: string) =>
      setConfig((previousConfig) => ({
        ...previousConfig,
        siteInputText: value,
      })),
    toggleType: (type: CanonicalOpportunityType) => {
      setSelectedTypes((previousTypes) => updateSelection(previousTypes, type));
      setPage(1);
    },
    toggleSite: (site: string) => {
      setSelectedSites((previousSites) => updateSelection(previousSites, site));
      setPage(1);
    },
    refreshSite,
    refreshAll,
    resetFilters,
    clearResults,
    exportRows,
    setPage,
    setPageSize,
  };
}
