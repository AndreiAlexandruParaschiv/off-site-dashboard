import { DEFAULT_CONFIG, STORAGE_KEY } from './constants';
import type { DashboardConfig } from './types';

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
