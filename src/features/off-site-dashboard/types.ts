export type CanonicalOpportunityType =
  | 'Reddit'
  | 'YouTube'
  | 'Cited URLs'
  | 'Prompt Gap'
  | 'Wikipedia';

export type SiteFetchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface DashboardConfig {
  apiBaseUrl: string;
  apiKey: string;
  siteInputText: string;
}

export interface SuggestionRecord {
  suggestionId: string;
  suggestionText: string;
  suggestionUrl?: string;
}

export interface SentimentItemRecord {
  item: string;
  sov: string;
  sentiment: string;
}

export interface OpportunityRecord {
  opportunityId: string;
  opportunityType: CanonicalOpportunityType;
  rawType: string;
  suggestions: SuggestionRecord[];
  sentimentItems: SentimentItemRecord[];
}

export interface SiteDashboardResult {
  requestSite: string;
  resolvedSiteUrl?: string;
  siteId?: string;
  status: SiteFetchStatus;
  statusMessage: string;
  error?: string;
  lastUpdated?: string;
  retryAfterSeconds?: number;
  opportunities: OpportunityRecord[];
}

export interface SiteOpportunityPresence {
  site: string;
  siteId?: string;
  lastUpdated?: string;
  status: SiteFetchStatus;
  statusMessage: string;
  presence: Record<CanonicalOpportunityType, boolean>;
}

export interface DashboardRow {
  id: string;
  site: string;
  siteId?: string;
  opportunityType?: CanonicalOpportunityType;
  opportunityId?: string;
  suggestionId?: string;
  suggestionText?: string;
  suggestionUrl?: string;
  lastUpdated?: string;
  status: string;
}

export interface GroupedSuggestionItem {
  suggestionId?: string;
  suggestionText?: string;
  suggestionUrl?: string;
}

export interface GroupedOpportunityRow {
  id: string;
  site: string;
  siteId?: string;
  opportunityType?: CanonicalOpportunityType;
  opportunityId?: string;
  suggestions: GroupedSuggestionItem[];
  sentimentItems: SentimentItemRecord[];
  status: string;
}

export interface FetchSiteParams {
  apiBaseUrl: string;
  apiKey: string;
  siteInput: string;
}

export interface FetchSiteSuccessResult extends SiteDashboardResult {
  status: 'success';
}
