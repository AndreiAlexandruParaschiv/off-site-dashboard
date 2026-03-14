import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { DEFAULT_PAGE_SIZE, TARGET_OPPORTUNITY_TYPES } from './constants';
import { downloadRowsAsCsv, downloadRowsAsExcel } from './csv';
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
  GroupedOpportunityRow,
  SiteDashboardResult,
  SiteOpportunityPresence,
} from './types';

type OpportunityTypeSortOrder = 'default' | 'asc' | 'desc';

function updateSelection<T extends string>(values: T[], value: T) {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function buildExportableOpportunityRows(siteCards: SiteDashboardResult[]) {
  return siteCards.flatMap((siteCard) =>
    siteCard.opportunities.map((opportunity) => {
      const hasExportContent =
        opportunity.suggestions.length > 0 || opportunity.sentimentItems.length > 0;

      return {
        id: [
          siteCard.requestSite,
          siteCard.siteId ?? '',
          opportunity.opportunityType,
          opportunity.opportunityId,
        ].join('::'),
        site: siteCard.requestSite,
        siteId: siteCard.siteId,
        opportunityType: opportunity.opportunityType,
        opportunityId: opportunity.opportunityId,
        suggestions: opportunity.suggestions.map((suggestion) => ({
          suggestionId: suggestion.suggestionId,
          suggestionText: suggestion.suggestionText,
          suggestionUrl: suggestion.suggestionUrl,
        })),
        sentimentItems: opportunity.sentimentItems,
        status:
          siteCard.status === 'error'
            ? `Stale data - ${siteCard.error ?? siteCard.statusMessage}`
            : hasExportContent
              ? 'Ready'
              : 'No suggestions returned',
      } satisfies GroupedOpportunityRow;
    }),
  );
}

export function useOffSiteDashboard() {
  const [config, setConfig] = useState<DashboardConfig>(() => loadDashboardConfig());
  const [siteResults, setSiteResults] = useState<Record<string, SiteDashboardResult>>(
    {},
  );
  const [selectedTypes, setSelectedTypes] = useState<CanonicalOpportunityType[]>([]);
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [typeSortOrder, setTypeSortOrder] =
    useState<OpportunityTypeSortOrder>('default');
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
    setSelectedTypes([]);
    setSelectedSites(configuredSites);
    setTypeSortOrder('default');
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

  const allOpportunityRows = useMemo(
    () => buildExportableOpportunityRows(siteCards),
    [siteCards],
  );

  const filteredOpportunityRows = useMemo(() => {
    const nextRows = allOpportunityRows.filter((row) => {
      const siteMatches = selectedSites.includes(row.site);
      const typeMatches = row.opportunityType
        ? selectedTypes.includes(row.opportunityType)
        : true;

      return siteMatches && typeMatches;
    });

    if (typeSortOrder === 'default') {
      return nextRows;
    }

    const sortedRows = [...nextRows];
    const direction = typeSortOrder === 'asc' ? 1 : -1;

    sortedRows.sort((left, right) => {
      const typeComparison =
        (left.opportunityType ?? '').localeCompare(right.opportunityType ?? '') *
        direction;

      if (typeComparison !== 0) {
        return typeComparison;
      }

      const siteComparison = left.site.localeCompare(right.site);
      if (siteComparison !== 0) {
        return siteComparison;
      }

      return (left.opportunityId ?? '').localeCompare(right.opportunityId ?? '');
    });

    return sortedRows;
  }, [allOpportunityRows, selectedSites, selectedTypes, typeSortOrder]);

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

  const exportableRows = allOpportunityRows;

  const exportRows = useCallback(() => {
    downloadRowsAsCsv(exportableRows);
  }, [exportableRows]);

  const exportExcel = useCallback(() => {
    downloadRowsAsExcel(exportableRows);
  }, [exportableRows]);

  return {
    config,
    siteCards,
    sitePresenceRows,
    configuredSites,
    selectedTypes,
    selectedSites,
    typeSortOrder,
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
    setTypeSortOrder: (value: OpportunityTypeSortOrder) => {
      setTypeSortOrder(value);
      setPage(1);
    },
    refreshSite,
    refreshAll,
    resetFilters,
    clearResults,
    exportRows,
    exportExcel,
    setPage,
    setPageSize,
  };
}
