import type { CanonicalOpportunityType, DashboardConfig } from './types';

export const TARGET_OPPORTUNITY_TYPES: CanonicalOpportunityType[] = [
  'Reddit',
  'YouTube',
  'Cited URLs',
  'Prompt Gap',
  'Wikipedia',
];

export const DEFAULT_API_BASE_URL =
  'https://spacecat.experiencecloud.live/api/v1';

export const DEFAULT_CONFIG: DashboardConfig = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  apiKey: '',
  siteInputText: '',
};

export const STORAGE_KEY = 'off-site-dashboard.config.v1';
export const SENTIMENT_EVALUATION_STORAGE_KEY =
  'off-site-dashboard.sentiment-evaluations.v1';
export const SENTIMENT_EVALUATOR_VERSION = 'offsite-sentiment-evaluator.v4';
export const EVALUATOR_API_PATH = '/api/offsite-evaluate';

export const DEFAULT_PAGE_SIZE = 25;
