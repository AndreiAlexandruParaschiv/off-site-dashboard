export type CanonicalOpportunityType =
  | 'Reddit'
  | 'YouTube'
  | 'Cited URLs'
  | 'Prompt Gap'
  | 'Wikipedia';

export type SiteFetchStatus = 'idle' | 'loading' | 'success' | 'error';

export type OpportunityPresenceState = 'missing' | 'exists' | 'exists_mixed';
export type SentimentEvaluationStatus = 'idle' | 'running' | 'success' | 'error';
export type SentimentEvaluationFetchStatus =
  | 'success'
  | 'partial'
  | 'insufficient_evidence'
  | 'fetch_failed';

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
  rowKey?: string;
  canEvaluate?: boolean;
  evaluationStatus?: SentimentEvaluationStatus;
  evaluationResult?: SentimentEvaluationResult;
  evaluationError?: string;
}

export interface SentimentEvaluationFetchMetadata {
  status: SentimentEvaluationFetchStatus;
  sourceType: 'youtube' | 'reddit' | 'web';
  sourceUrl: string;
  usedTranscript: boolean;
  evidenceCharacters: number;
}

export interface SentimentEvaluationResult {
  evaluatedSentiment: string;
  sentimentConfidence: number;
  rationale: string;
  evidenceSnippet: string;
  evaluatedAt: string;
  evaluatorVersion: string;
  fetch: SentimentEvaluationFetchMetadata;
  targetBrand: string;
}

export interface SentimentEvaluationRequest {
  site: string;
  siteId?: string;
  opportunityType: CanonicalOpportunityType;
  opportunityId: string;
  item: string;
  extractedSentiment: string;
}

export interface SentimentEvaluationStoredResult extends SentimentEvaluationResult {
  rowKey: string;
  extractedSentiment: string;
}

export interface SentimentEvaluationStore {
  evaluatorVersion: string;
  results: Record<string, SentimentEvaluationStoredResult>;
}

export interface OpportunityRecord {
  opportunityId: string;
  opportunityType: CanonicalOpportunityType;
  opportunityStatus: string;
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
  opportunityPresence: Record<CanonicalOpportunityType, OpportunityPresenceState>;
  opportunities: OpportunityRecord[];
}

export interface SiteOpportunityPresence {
  site: string;
  siteId?: string;
  lastUpdated?: string;
  status: SiteFetchStatus;
  statusMessage: string;
  presence: Record<CanonicalOpportunityType, OpportunityPresenceState>;
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
