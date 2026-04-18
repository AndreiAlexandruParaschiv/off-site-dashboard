import type { CanonicalOpportunityType, DashboardConfig } from './types.js';

export const TARGET_OPPORTUNITY_TYPES: CanonicalOpportunityType[] = [
  'Reddit',
  'YouTube',
  'Cited URLs',
  'Wikipedia',
];

export const DEFAULT_API_BASE_URL =
  'https://spacecat.experiencecloud.live/api/v1';
export const SPACECAT_PROXY_CONFIG_API_PATH = '/api/spacecat-config';
export const SPACECAT_PROXY_API_PATH = '/api/spacecat';

export const DEFAULT_CONFIG: DashboardConfig = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  apiKey: '',
  siteInputText: '',
};

export const STORAGE_KEY = 'off-site-dashboard.config.v1';
export const SENTIMENT_EVALUATION_STORAGE_KEY =
  'off-site-dashboard.sentiment-evaluations.v1';
export const SUGGESTION_EVALUATION_STORAGE_KEY =
  'off-site-dashboard.suggestion-evaluations.v1';
export const SENTIMENT_EVALUATOR_VERSION = 'offsite-sentiment-evaluator.v15';
export const SUGGESTION_EVALUATOR_VERSION = 'offsite-suggestion-evaluator.v24';
export const WIKIPEDIA_URL_EVALUATOR_VERSION = 'offsite-wikipedia-url-evaluator.v1';
export const EVALUATOR_API_PATH = '/api/offsite-evaluate';
export const SUGGESTION_EVALUATOR_API_PATH = '/api/offsite-evaluate-suggestion';
export const WIKIPEDIA_URL_EVALUATOR_API_PATH = '/api/offsite-evaluate-wikipedia-url';

export const DEFAULT_PAGE_SIZE = 25;
