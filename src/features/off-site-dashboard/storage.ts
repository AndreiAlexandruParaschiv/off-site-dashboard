import {
  DEFAULT_CONFIG,
  SENTIMENT_EVALUATION_STORAGE_KEY,
  SUGGESTION_EVALUATION_STORAGE_KEY,
  STORAGE_KEY,
} from './constants';
import { normalizeSentimentEvaluationStore } from './evaluation';
import { normalizeSuggestionEvaluationStore } from './suggestionEvaluation';
import type {
  DashboardConfig,
  SentimentEvaluationStore,
  SuggestionEvaluationStore,
} from './types';

function hasWindow() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadDashboardConfig(): DashboardConfig {
  if (!hasWindow()) {
    return DEFAULT_CONFIG;
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_CONFIG;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<DashboardConfig>;
    return {
      apiBaseUrl:
        typeof parsedValue.apiBaseUrl === 'string'
          ? parsedValue.apiBaseUrl
          : DEFAULT_CONFIG.apiBaseUrl,
      // Keep API key manual-only; do not hydrate from localStorage.
      apiKey: DEFAULT_CONFIG.apiKey,
      siteInputText:
        typeof parsedValue.siteInputText === 'string'
          ? parsedValue.siteInputText
          : DEFAULT_CONFIG.siteInputText,
    };
  } catch (error) {
    console.warn('Failed to read saved dashboard config.', error);
    return DEFAULT_CONFIG;
  }
}

export function saveDashboardConfig(config: DashboardConfig) {
  if (!hasWindow()) {
    return;
  }

  // Persist non-sensitive fields only.
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...config,
      apiKey: '',
    }),
  );
}

export function loadSentimentEvaluationStore(): SentimentEvaluationStore {
  if (!hasWindow()) {
    return normalizeSentimentEvaluationStore(null);
  }

  try {
    const rawValue = window.localStorage.getItem(SENTIMENT_EVALUATION_STORAGE_KEY);

    if (!rawValue) {
      return normalizeSentimentEvaluationStore(null);
    }

    return normalizeSentimentEvaluationStore(JSON.parse(rawValue));
  } catch (error) {
    console.warn('Failed to read saved sentiment evaluations.', error);
    return normalizeSentimentEvaluationStore(null);
  }
}

export function saveSentimentEvaluationStore(store: SentimentEvaluationStore) {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(
    SENTIMENT_EVALUATION_STORAGE_KEY,
    JSON.stringify(store),
  );
}

export function loadSuggestionEvaluationStore(): SuggestionEvaluationStore {
  if (!hasWindow()) {
    return normalizeSuggestionEvaluationStore(null);
  }

  try {
    const rawValue = window.localStorage.getItem(SUGGESTION_EVALUATION_STORAGE_KEY);

    if (!rawValue) {
      return normalizeSuggestionEvaluationStore(null);
    }

    return normalizeSuggestionEvaluationStore(JSON.parse(rawValue));
  } catch (error) {
    console.warn('Failed to read saved suggestion evaluations.', error);
    return normalizeSuggestionEvaluationStore(null);
  }
}

export function saveSuggestionEvaluationStore(store: SuggestionEvaluationStore) {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(
    SUGGESTION_EVALUATION_STORAGE_KEY,
    JSON.stringify(store),
  );
}
