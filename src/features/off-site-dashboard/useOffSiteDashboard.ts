import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_PAGE_SIZE,
  SENTIMENT_EVALUATOR_VERSION,
  SUGGESTION_EVALUATOR_VERSION,
  TARGET_OPPORTUNITY_TYPES,
} from './constants';
import {
  downloadRowsAsCsv,
  downloadRowsAsExcel,
  downloadSentimentEvaluationExcel,
  downloadSovEvaluationExcel,
  downloadSuggestionEvaluationExcel,
} from './csv';
import {
  SpacecatApiError,
  clearEvaluatorCache,
  evaluateSentimentRow,
  evaluateSuggestionRow,
  exchangeImsAccessToken,
  fetchSpacecatProxyConfig,
  fetchSiteDashboardData,
} from './api';
import {
  buildSentimentEvaluationRequest,
  buildSentimentRowKey,
  canEvaluateSentimentItem,
  createStoredSentimentEvaluation,
} from './evaluation';
import {
  buildSuggestionEvaluationRequest,
  buildSuggestionEvaluationRequestFingerprint,
  buildSuggestionRowKey,
  canEvaluateSuggestionItem,
  createStoredSuggestionEvaluation,
  isSuggestionEvaluationType,
} from './suggestionEvaluation';
import {
  loadDashboardConfig,
  loadSentimentEvaluationStore,
  loadSuggestionEvaluationStore,
  saveDashboardConfig,
  saveSentimentEvaluationStore,
  saveSuggestionEvaluationStore,
} from './storage';
import {
  countSuggestions,
  createIdleSiteResult,
  flattenSiteRows,
  getOpportunityTypeSummary,
  isCurrentSuggestionStatus,
  normalizeApiBaseUrl,
  normalizeSiteInput,
  normalizeSiteList,
} from './utils';
import type {
  CanonicalOpportunityType,
  DashboardConfig,
  GroupedOpportunityRow,
  OpportunityFilterOption,
  SentimentEvaluationRequest,
  SentimentEvaluationStatus,
  SentimentEvaluationStoredResult,
  SiteDashboardResult,
  SiteOpportunityPresence,
  SpacecatProxyConfig,
  SuggestionEvaluationRequest,
  SuggestionEvaluationStatus,
  SuggestionEvaluationStoredResult,
} from './types';

export const ALL_OPPORTUNITIES_VALUE = 'all' as const;
export type SelectedOpportunityId = typeof ALL_OPPORTUNITIES_VALUE | string;

function shortenOpportunityId(opportunityId: string): string {
  if (!opportunityId) {
    return '';
  }
  return opportunityId.length > 8 ? `${opportunityId.slice(0, 8)}…` : opportunityId;
}

function isIgnoredOpportunityRow(row: GroupedOpportunityRow): boolean {
  return typeof row.status === 'string' && row.status.toLowerCase().includes('ignored');
}

function buildOpportunityOptionLabel(
  row: GroupedOpportunityRow,
  options: { multiSite: boolean },
): string {
  const parts: string[] = [];
  if (row.opportunityType) {
    parts.push(row.opportunityType);
  }
  const shortId = shortenOpportunityId(row.opportunityId ?? '');
  if (shortId) {
    parts.push(shortId);
  }
  const counts: string[] = [];
  if (row.suggestions.length > 0) {
    counts.push(
      `${row.suggestions.length} sug${row.suggestions.length === 1 ? '' : 's'}`,
    );
  }
  if (row.sentimentItems.length > 0) {
    counts.push(
      `${row.sentimentItems.length} item${row.sentimentItems.length === 1 ? '' : 's'}`,
    );
  }
  if (isIgnoredOpportunityRow(row)) {
    counts.push('ignored');
  }
  const head = parts.join(' · ');
  const sitePrefix = options.multiSite ? `${row.site} — ` : '';
  return counts.length > 0 ? `${sitePrefix}${head} (${counts.join(', ')})` : `${sitePrefix}${head}`;
}

type OpportunityTypeSortOrder = 'default' | 'asc' | 'desc';

function updateSelection<T extends string>(values: T[], value: T) {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function buildSuggestionEvidenceItems(
  suggestion: { evidenceItems?: string[] },
  sentimentItems: Array<{ item: string }>,
) {
  return Array.from(
    new Set([
      ...(suggestion.evidenceItems ?? []).map((item) => item.trim()).filter(Boolean),
      ...sentimentItems.map((item) => item.item.trim()).filter(Boolean),
    ]),
  );
}

function buildExportableOpportunityRows(
  siteCards: SiteDashboardResult[],
  evaluationResults: Record<string, SentimentEvaluationStoredResult>,
  evaluationStatuses: Record<string, SentimentEvaluationStatus>,
  evaluationErrors: Record<string, string>,
  suggestionEvaluationResults: Record<string, SuggestionEvaluationStoredResult>,
  suggestionEvaluationStatuses: Record<string, SuggestionEvaluationStatus>,
  suggestionEvaluationErrors: Record<string, string>,
) {
  const buildSuggestionEvidenceItems = (
    suggestion: { evidenceItems?: string[] },
    sentimentItems: Array<{ item: string }>,
  ) =>
    Array.from(
      new Set([
        ...(suggestion.evidenceItems ?? []).map((item) => item.trim()).filter(Boolean),
        ...sentimentItems.map((item) => item.item.trim()).filter(Boolean),
      ]),
    );

  return siteCards.flatMap((siteCard) =>
    siteCard.opportunities.map((opportunity) => {
      const hasExportContent =
        opportunity.suggestions.length > 0 || opportunity.sentimentItems.length > 0;
      const sentimentItems = opportunity.sentimentItems.map((item) => {
        const rowKey = buildSentimentRowKey({
          site: siteCard.requestSite,
          siteId: siteCard.siteId,
          opportunityType: opportunity.opportunityType,
          opportunityId: opportunity.opportunityId,
          item: item.item,
        });
        const storedEvaluation = evaluationResults[rowKey];
        const evaluationResult =
          storedEvaluation &&
          storedEvaluation.extractedSentiment === item.sentiment &&
          storedEvaluation.extractedSov === item.sov
            ? storedEvaluation
            : undefined;

        return {
          ...item,
          rowKey,
          canEvaluate: canEvaluateSentimentItem(item.item),
          evaluationStatus: evaluationStatuses[rowKey] ?? 'idle',
          evaluationResult,
          evaluationError: evaluationErrors[rowKey],
        };
      });
      const suggestions = opportunity.suggestions
        .filter((suggestion) => isCurrentSuggestionStatus(suggestion.status))
        .map((suggestion) => {
        const currentRequest = buildSuggestionEvaluationRequest({
          site: siteCard.requestSite,
          siteId: siteCard.siteId,
          opportunityType: opportunity.opportunityType,
          opportunityId: opportunity.opportunityId,
          suggestionId: suggestion.suggestionId,
          suggestionText: suggestion.suggestionText,
          suggestionUrl: suggestion.suggestionUrl,
          evidenceItems: buildSuggestionEvidenceItems(
            suggestion,
            opportunity.sentimentItems,
          ),
          sentimentRows: opportunity.sentimentItems.map((item) => ({
            item: item.item,
            title: item.title,
            sov: item.sov,
            sentiment: item.sentiment,
            timesCited: item.timesCited,
          })),
        });
        const rowKey = buildSuggestionRowKey({
          site: siteCard.requestSite,
          siteId: siteCard.siteId,
          opportunityType: opportunity.opportunityType,
          opportunityId: opportunity.opportunityId,
          suggestionId: suggestion.suggestionId,
          suggestionText: suggestion.suggestionText,
        });
        const storedEvaluation = suggestionEvaluationResults[rowKey];
        const evaluationResult =
          currentRequest &&
          storedEvaluation &&
          storedEvaluation.requestFingerprint ===
            buildSuggestionEvaluationRequestFingerprint(currentRequest)
            ? storedEvaluation
            : undefined;

        return {
          suggestionId: suggestion.suggestionId,
          suggestionText: suggestion.suggestionText,
          suggestionUrl: suggestion.suggestionUrl,
          status: suggestion.status,
          evidenceItems: suggestion.evidenceItems,
          rowKey,
          canEvaluate:
            Boolean(currentRequest) &&
            isSuggestionEvaluationType(opportunity.opportunityType) &&
            canEvaluateSuggestionItem(suggestion.suggestionText),
          evaluationStatus: suggestionEvaluationStatuses[rowKey] ?? 'idle',
          evaluationResult,
          evaluationError: suggestionEvaluationErrors[rowKey],
        };
      });

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
        suggestions,
        sentimentItems,
        status:
          siteCard.status === 'error'
            ? `Stale data - ${siteCard.error ?? siteCard.statusMessage}`
            : opportunity.opportunityStatus === 'ignored'
              ? hasExportContent
                ? 'Ready (Ignored)'
                : 'Ignored - no suggestions returned'
              : hasExportContent
                ? 'Ready'
                : 'No suggestions returned',
      } satisfies GroupedOpportunityRow;
    }),
  );
}

export function useOffSiteDashboard() {
  const [config, setConfig] = useState<DashboardConfig>(() => loadDashboardConfig());
  const [sentimentEvaluationResults, setSentimentEvaluationResults] = useState<
    Record<string, SentimentEvaluationStoredResult>
  >(() => loadSentimentEvaluationStore().results);
  const [suggestionEvaluationResults, setSuggestionEvaluationResults] = useState<
    Record<string, SuggestionEvaluationStoredResult>
  >(() => loadSuggestionEvaluationStore().results);
  const [sentimentEvaluationStatuses, setSentimentEvaluationStatuses] = useState<
    Record<string, SentimentEvaluationStatus>
  >({});
  const [suggestionEvaluationStatuses, setSuggestionEvaluationStatuses] = useState<
    Record<string, SuggestionEvaluationStatus>
  >({});
  const [sentimentEvaluationErrors, setSentimentEvaluationErrors] = useState<
    Record<string, string>
  >({});
  const [suggestionEvaluationErrors, setSuggestionEvaluationErrors] = useState<
    Record<string, string>
  >({});
  const [selectedSentimentRowKeys, setSelectedSentimentRowKeys] = useState<string[]>([]);
  const [selectedSuggestionRowKeys, setSelectedSuggestionRowKeys] = useState<string[]>(
    [],
  );
  const [siteResults, setSiteResults] = useState<Record<string, SiteDashboardResult>>(
    {},
  );
  const [selectedTypes, setSelectedTypes] = useState<CanonicalOpportunityType[]>([]);
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [selectedOpportunityId, setSelectedOpportunityId] =
    useState<SelectedOpportunityId>(ALL_OPPORTUNITIES_VALUE);
  const [typeSortOrder, setTypeSortOrder] =
    useState<OpportunityTypeSortOrder>('default');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [didAutoRefresh, setDidAutoRefresh] = useState(false);
  const [spacecatProxyConfig, setSpacecatProxyConfig] =
    useState<SpacecatProxyConfig>({
      configured: false,
      apiBaseUrl: DEFAULT_API_BASE_URL,
    });
  // Session-only token pasted by the user in the UI. Never persisted to
  // localStorage — colleagues paste it once per browser session.
  const [userToken, setUserToken] = useState<string>('');

  // "Log in with IMS token" flow: the user pastes a raw IMS *user* access
  // token, we exchange it server-side for a SpaceCat session token, and store
  // the result in `userToken`. Neither token is persisted. Kept in memory so a
  // one-click re-exchange is possible when the session expires.
  const [imsAccessToken, setImsAccessToken] = useState<string>('');
  const [imsLoginState, setImsLoginState] = useState<
    | { kind: 'idle' }
    | { kind: 'exchanging' }
    | { kind: 'success'; expiresAt?: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const loginWithImsToken = useCallback(async () => {
    const token = imsAccessToken.trim();
    if (!token) {
      setImsLoginState({
        kind: 'error',
        message: 'Paste an IMS access token first.',
      });
      return;
    }
    setImsLoginState({ kind: 'exchanging' });
    try {
      const { sessionToken, expiresAt } = await exchangeImsAccessToken({
        imsAccessToken: token,
      });
      setUserToken(sessionToken);
      setImsLoginState({ kind: 'success', expiresAt });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'IMS token exchange failed.';
      setImsLoginState({ kind: 'error', message });
    }
  }, [imsAccessToken]);

  useEffect(() => {
    let isCancelled = false;

    void fetchSpacecatProxyConfig().then((nextConfig) => {
      if (!isCancelled) {
        setSpacecatProxyConfig(nextConfig);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  const configuredSites = useMemo(
    () => normalizeSiteList(config.siteInputText),
    [config.siteInputText],
  );

  useEffect(() => {
    saveDashboardConfig(config);
  }, [config]);

  useEffect(() => {
    saveSentimentEvaluationStore({
      evaluatorVersion: SENTIMENT_EVALUATOR_VERSION,
      results: sentimentEvaluationResults,
    });
  }, [sentimentEvaluationResults]);

  useEffect(() => {
    saveSuggestionEvaluationStore({
      evaluatorVersion: SUGGESTION_EVALUATOR_VERSION,
      results: suggestionEvaluationResults,
    });
  }, [suggestionEvaluationResults]);

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
      const normalizedApiBaseUrl = normalizeApiBaseUrl(
        spacecatProxyConfig.configured
          ? spacecatProxyConfig.apiBaseUrl
          : config.apiBaseUrl,
      );

      if (
        !normalizedSite ||
        !normalizedApiBaseUrl ||
        (!spacecatProxyConfig.configured && !config.apiKey.trim())
      ) {
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
          proxyConfig: spacecatProxyConfig,
          siteInput: normalizedSite,
          userToken,
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
    // userToken MUST be here — without it the memoized callback closes over
    // a stale (empty) token and never sends x-client-token after a paste.
    [config.apiBaseUrl, config.apiKey, spacecatProxyConfig, userToken],
  );

  const refreshAll = useCallback(async () => {
    const effectiveApiBaseUrl = normalizeApiBaseUrl(
      spacecatProxyConfig.configured
        ? spacecatProxyConfig.apiBaseUrl
        : config.apiBaseUrl,
    );

    if (
      !effectiveApiBaseUrl.trim() ||
      (!spacecatProxyConfig.configured && !config.apiKey.trim())
    ) {
      return;
    }

    await Promise.all(configuredSites.map((site) => refreshSite(site)));
  }, [config.apiBaseUrl, config.apiKey, configuredSites, refreshSite, spacecatProxyConfig]);

  useEffect(() => {
    if (
      didAutoRefresh ||
      (!spacecatProxyConfig.configured && !config.apiKey.trim()) ||
      !normalizeApiBaseUrl(
        spacecatProxyConfig.configured
          ? spacecatProxyConfig.apiBaseUrl
          : config.apiBaseUrl,
      ).trim() ||
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
    spacecatProxyConfig,
  ]);

  const resetFilters = useCallback(() => {
    setSelectedTypes([]);
    setSelectedSites(configuredSites);
    setSelectedOpportunityId(ALL_OPPORTUNITIES_VALUE);
    setTypeSortOrder('default');
    setPage(1);
  }, [configuredSites]);

  const selectOpportunityId = useCallback((value: SelectedOpportunityId) => {
    setSelectedOpportunityId(value);
    setSelectedSentimentRowKeys([]);
    setSelectedSuggestionRowKeys([]);
    setPage(1);
  }, []);

  const clearResults = useCallback(() => {
    setSiteResults(
      configuredSites.reduce<Record<string, SiteDashboardResult>>((results, site) => {
        results[site] = createIdleSiteResult(site);
        return results;
      }, {}),
    );
    setSelectedSentimentRowKeys([]);
    setSelectedSuggestionRowKeys([]);
    setSentimentEvaluationStatuses({});
    setSentimentEvaluationErrors({});
    setSuggestionEvaluationStatuses({});
    setSuggestionEvaluationErrors({});
    setPage(1);
  }, [configuredSites]);

  const siteCards = useMemo(
    () => configuredSites.map((site) => siteResults[site] ?? createIdleSiteResult(site)),
    [configuredSites, siteResults],
  );

  const sitePresenceRows = useMemo<SiteOpportunityPresence[]>(() => {
    return siteCards.map((siteCard) => {
      return {
        site: siteCard.requestSite,
        siteId: siteCard.siteId,
        lastUpdated: siteCard.lastUpdated,
        status: siteCard.status,
        statusMessage: siteCard.error ?? siteCard.statusMessage,
        presence: siteCard.opportunityPresence,
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
    () =>
      buildExportableOpportunityRows(
        siteCards,
        sentimentEvaluationResults,
        sentimentEvaluationStatuses,
        sentimentEvaluationErrors,
        suggestionEvaluationResults,
        suggestionEvaluationStatuses,
        suggestionEvaluationErrors,
      ),
    [
      sentimentEvaluationErrors,
      sentimentEvaluationResults,
      sentimentEvaluationStatuses,
      suggestionEvaluationErrors,
      suggestionEvaluationResults,
      suggestionEvaluationStatuses,
      siteCards,
    ],
  );

  const sentimentEvaluationRequestMap = useMemo(() => {
    return allOpportunityRows.reduce<Map<string, SentimentEvaluationRequest>>(
      (nextMap, row) => {
        row.sentimentItems.forEach((item) => {
          const request = buildSentimentEvaluationRequest({
            site: row.site,
            siteId: row.siteId,
            opportunityType: row.opportunityType,
            opportunityId: row.opportunityId,
            item: item.item,
            title: item.title,
            extractedSov: item.sov,
            extractedSentiment: item.sentiment,
            timesCited: item.timesCited,
          });

          if (request && item.rowKey) {
            nextMap.set(item.rowKey, request);
          }
        });

        return nextMap;
      },
      new Map<string, SentimentEvaluationRequest>(),
    );
  }, [allOpportunityRows]);

  const suggestionEvaluationRequestMap = useMemo(() => {
    return allOpportunityRows.reduce<Map<string, SuggestionEvaluationRequest>>(
      (nextMap, row) => {
        row.suggestions.forEach((suggestion) => {
          const request = buildSuggestionEvaluationRequest({
            site: row.site,
            siteId: row.siteId,
            opportunityType: row.opportunityType,
            opportunityId: row.opportunityId,
            suggestionId: suggestion.suggestionId,
            suggestionText: suggestion.suggestionText ?? '',
            suggestionUrl: suggestion.suggestionUrl,
            evidenceItems: buildSuggestionEvidenceItems(suggestion, row.sentimentItems),
            sentimentRows: row.sentimentItems.map((item) => ({
              item: item.item,
              title: item.title,
              sov: item.sov,
              sentiment: item.sentiment,
              timesCited: item.timesCited,
            })),
          });

          if (request && suggestion.rowKey) {
            nextMap.set(suggestion.rowKey, request);
          }
        });

        return nextMap;
      },
      new Map<string, SuggestionEvaluationRequest>(),
    );
  }, [allOpportunityRows]);

  useEffect(() => {
    setSelectedSentimentRowKeys((currentKeys) =>
      currentKeys.filter((rowKey) => sentimentEvaluationRequestMap.has(rowKey)),
    );
  }, [sentimentEvaluationRequestMap]);

  useEffect(() => {
    setSelectedSuggestionRowKeys((currentKeys) =>
      currentKeys.filter((rowKey) => suggestionEvaluationRequestMap.has(rowKey)),
    );
  }, [suggestionEvaluationRequestMap]);

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

  const opportunityOptions = useMemo<OpportunityFilterOption[]>(() => {
    const distinctSites = new Set(filteredOpportunityRows.map((row) => row.site));
    const multiSite = distinctSites.size > 1;
    const options: OpportunityFilterOption[] = [];

    for (const row of filteredOpportunityRows) {
      if (!row.opportunityId || !row.opportunityType) {
        continue;
      }
      options.push({
        opportunityId: row.opportunityId,
        opportunityType: row.opportunityType,
        site: row.site,
        label: buildOpportunityOptionLabel(row, { multiSite }),
        suggestionCount: row.suggestions.length,
        sentimentItemCount: row.sentimentItems.length,
      });
    }

    return options;
  }, [filteredOpportunityRows]);

  useEffect(() => {
    if (selectedOpportunityId === ALL_OPPORTUNITIES_VALUE) {
      return;
    }

    const stillExists = opportunityOptions.some(
      (option) => option.opportunityId === selectedOpportunityId,
    );

    if (!stillExists) {
      setSelectedOpportunityId(ALL_OPPORTUNITIES_VALUE);
    }
  }, [opportunityOptions, selectedOpportunityId]);

  const opportunityScopedRows = useMemo(() => {
    if (selectedOpportunityId === ALL_OPPORTUNITIES_VALUE) {
      return filteredOpportunityRows;
    }
    return filteredOpportunityRows.filter(
      (row) => row.opportunityId === selectedOpportunityId,
    );
  }, [filteredOpportunityRows, selectedOpportunityId]);

  const deferredRows = useDeferredValue(opportunityScopedRows);

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
        count + countSuggestions(siteCard.opportunities),
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
  const effectiveApiBaseUrl = normalizeApiBaseUrl(
    spacecatProxyConfig.configured
      ? spacecatProxyConfig.apiBaseUrl
      : config.apiBaseUrl,
  );
  const canRefresh =
    Boolean(effectiveApiBaseUrl.trim()) &&
    (Boolean(config.apiKey.trim()) || Boolean(spacecatProxyConfig.configured) || Boolean(userToken.trim())) &&
    configuredSites.length > 0;

  const exportableRows = allOpportunityRows;
  const filteredExportableRows = opportunityScopedRows;

  const isEvaluatingSentiment = Object.values(sentimentEvaluationStatuses).some(
    (status) => status === 'running',
  );
  const isEvaluatingSuggestions = Object.values(suggestionEvaluationStatuses).some(
    (status) => status === 'running',
  );
  const selectedSentimentRowsCount = selectedSentimentRowKeys.filter((rowKey) =>
    sentimentEvaluationRequestMap.has(rowKey),
  ).length;
  const selectedSuggestionRowsCount = selectedSuggestionRowKeys.filter((rowKey) =>
    suggestionEvaluationRequestMap.has(rowKey),
  ).length;
  const selectedVisibleSentimentRowKeys = pagedOpportunityRows.flatMap((row) =>
    row.sentimentItems
      .filter(
        (item) =>
          item.canEvaluate &&
          item.rowKey &&
          selectedSentimentRowKeys.includes(item.rowKey),
      )
      .map((item) => item.rowKey as string),
  );
  const selectedVisibleSuggestionRowKeys = pagedOpportunityRows.flatMap((row) =>
    row.suggestions
      .filter(
        (suggestion) =>
          suggestion.canEvaluate &&
          suggestion.rowKey &&
          selectedSuggestionRowKeys.includes(suggestion.rowKey),
      )
      .map((suggestion) => suggestion.rowKey as string),
  );
  const selectedVisibleSentimentRowsCount = selectedVisibleSentimentRowKeys.length;
  const selectedVisibleSuggestionRowsCount = selectedVisibleSuggestionRowKeys.length;

  const exportRows = useCallback(() => {
    downloadRowsAsCsv(filteredExportableRows);
  }, [filteredExportableRows]);

  const exportExcel = useCallback(() => {
    downloadRowsAsExcel(filteredExportableRows);
  }, [filteredExportableRows]);

  const exportSuggestionEvaluation = useCallback(() => {
    downloadSuggestionEvaluationExcel(filteredExportableRows);
  }, [filteredExportableRows]);

  const exportSentimentEvaluation = useCallback(() => {
    downloadSentimentEvaluationExcel(filteredExportableRows);
  }, [filteredExportableRows]);

  const exportSovEvaluation = useCallback(() => {
    downloadSovEvaluationExcel(filteredExportableRows);
  }, [filteredExportableRows]);

  const toggleSentimentRowSelection = useCallback((rowKey: string) => {
    setSelectedSentimentRowKeys((currentKeys) =>
      currentKeys.includes(rowKey)
        ? currentKeys.filter((currentKey) => currentKey !== rowKey)
        : [...currentKeys, rowKey],
    );
  }, []);

  const setSentimentRowSelections = useCallback(
    (rowKeys: string[], selected: boolean) => {
      setSelectedSentimentRowKeys((currentKeys) => {
        const validRowKeys = rowKeys.filter((rowKey) =>
          sentimentEvaluationRequestMap.has(rowKey),
        );

        if (selected) {
          return Array.from(new Set([...currentKeys, ...validRowKeys]));
        }

        return currentKeys.filter((rowKey) => !validRowKeys.includes(rowKey));
      });
    },
    [sentimentEvaluationRequestMap],
  );

  const toggleSuggestionRowSelection = useCallback((rowKey: string) => {
    setSelectedSuggestionRowKeys((currentKeys) =>
      currentKeys.includes(rowKey)
        ? currentKeys.filter((currentKey) => currentKey !== rowKey)
        : [...currentKeys, rowKey],
    );
  }, []);

  const setSuggestionRowSelections = useCallback(
    (rowKeys: string[], selected: boolean) => {
      setSelectedSuggestionRowKeys((currentKeys) => {
        const validRowKeys = rowKeys.filter((rowKey) =>
          suggestionEvaluationRequestMap.has(rowKey),
        );

        if (selected) {
          return Array.from(new Set([...currentKeys, ...validRowKeys]));
        }

        return currentKeys.filter((rowKey) => !validRowKeys.includes(rowKey));
      });
    },
    [suggestionEvaluationRequestMap],
  );

  const runSentimentEvaluation = useCallback(
    async (rowKeys: string[]) => {
      const uniqueRowKeys = Array.from(new Set(rowKeys)).filter((rowKey) =>
        sentimentEvaluationRequestMap.has(rowKey),
      );

      if (uniqueRowKeys.length === 0) {
        return;
      }

      setSentimentEvaluationStatuses((currentStatuses) => {
        const nextStatuses = { ...currentStatuses };
        uniqueRowKeys.forEach((rowKey) => {
          nextStatuses[rowKey] = 'running';
        });
        return nextStatuses;
      });
      setSentimentEvaluationErrors((currentErrors) => {
        const nextErrors = { ...currentErrors };
        uniqueRowKeys.forEach((rowKey) => {
          delete nextErrors[rowKey];
        });
        return nextErrors;
      });

      for (const rowKey of uniqueRowKeys) {
        const request = sentimentEvaluationRequestMap.get(rowKey);

        if (!request) {
          continue;
        }

        try {
          const result = await evaluateSentimentRow(request);

          setSentimentEvaluationResults((currentResults) => ({
            ...currentResults,
            [rowKey]: createStoredSentimentEvaluation(rowKey, request, result),
          }));
          setSentimentEvaluationStatuses((currentStatuses) => ({
            ...currentStatuses,
            [rowKey]: 'success',
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Evaluation failed.';

          setSentimentEvaluationStatuses((currentStatuses) => ({
            ...currentStatuses,
            [rowKey]: 'error',
          }));
          setSentimentEvaluationErrors((currentErrors) => ({
            ...currentErrors,
            [rowKey]: message,
          }));
        }
      }
    },
    [sentimentEvaluationRequestMap],
  );

  const runSuggestionEvaluation = useCallback(
    async (rowKeys: string[]) => {
      const uniqueRowKeys = Array.from(new Set(rowKeys)).filter((rowKey) =>
        suggestionEvaluationRequestMap.has(rowKey),
      );

      if (uniqueRowKeys.length === 0) {
        return;
      }

      setSuggestionEvaluationStatuses((currentStatuses) => {
        const nextStatuses = { ...currentStatuses };
        uniqueRowKeys.forEach((rowKey) => {
          nextStatuses[rowKey] = 'running';
        });
        return nextStatuses;
      });
      setSuggestionEvaluationErrors((currentErrors) => {
        const nextErrors = { ...currentErrors };
        uniqueRowKeys.forEach((rowKey) => {
          delete nextErrors[rowKey];
        });
        return nextErrors;
      });

      for (const rowKey of uniqueRowKeys) {
        const request = suggestionEvaluationRequestMap.get(rowKey);

        if (!request) {
          continue;
        }

        try {
          const result = await evaluateSuggestionRow(request);

          setSuggestionEvaluationResults((currentResults) => ({
            ...currentResults,
            [rowKey]: createStoredSuggestionEvaluation(rowKey, request, result),
          }));
          setSuggestionEvaluationStatuses((currentStatuses) => ({
            ...currentStatuses,
            [rowKey]: 'success',
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Suggestion evaluation failed.';

          setSuggestionEvaluationStatuses((currentStatuses) => ({
            ...currentStatuses,
            [rowKey]: 'error',
          }));
          setSuggestionEvaluationErrors((currentErrors) => ({
            ...currentErrors,
            [rowKey]: message,
          }));
        }
      }
    },
    [suggestionEvaluationRequestMap],
  );

  /**
   * Clear the server's in-memory evaluator cache AND wipe all locally
   * stored sentiment-evaluation results so the next click on Evaluate
   * runs the full pipeline (fresh evidence fetch + fresh LLM call).
   *
   * Use the button in the dashboard header to trigger this. Returns the
   * cleared counts from the server so the UI can surface them.
   */
  const resetEvaluatorCache = useCallback(async (): Promise<{
    serverCleared: number;
    brandProfilesCleared: number;
    localCleared: number;
  }> => {
    const localCleared = Object.keys(sentimentEvaluationResults).length;
    const serverResponse = await clearEvaluatorCache();
    setSentimentEvaluationResults({});
    setSentimentEvaluationStatuses({});
    setSentimentEvaluationErrors({});
    return {
      serverCleared: serverResponse.cleared,
      brandProfilesCleared: serverResponse.brandProfilesCleared,
      localCleared,
    };
  }, [sentimentEvaluationResults]);

  return {
    config,
    spacecatProxyConfig,
    siteCards,
    sitePresenceRows,
    configuredSites,
    selectedTypes,
    selectedSites,
    selectedOpportunityId,
    opportunityOptions,
    typeSortOrder,
    page,
    pageSize,
    totalPages,
    isRefreshing,
    isEvaluatingSentiment,
    isEvaluatingSuggestions,
    canRefresh,
    hasExportRows: exportableRows.length > 0,
    selectedSentimentRowKeys,
    selectedSentimentRowsCount,
    selectedVisibleSentimentRowKeys,
    selectedVisibleSentimentRowsCount,
    selectedSuggestionRowKeys,
    selectedSuggestionRowsCount,
    selectedVisibleSuggestionRowKeys,
    selectedVisibleSuggestionRowsCount,
    pagedOpportunityRows,
    filteredRows,
    filteredOpportunityRows,
    opportunityScopedRows,
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
    userToken,
    setUserToken,
    imsAccessToken,
    setImsAccessToken,
    imsLoginState,
    loginWithImsToken,
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
    selectOpportunityId,
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
    exportSuggestionEvaluation,
    exportSentimentEvaluation,
    exportSovEvaluation,
    toggleSentimentRowSelection,
    setSentimentRowSelections,
    toggleSuggestionRowSelection,
    setSuggestionRowSelections,
    evaluateSentimentRows: runSentimentEvaluation,
    evaluateSuggestionRows: runSuggestionEvaluation,
    resetEvaluatorCache,
    setPage,
    setPageSize,
  };
}
