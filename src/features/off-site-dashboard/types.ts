export type CanonicalOpportunityType =
  | 'Reddit'
  | 'YouTube'
  | 'Cited URLs'
  | 'Prompt Gap'
  | 'Wikipedia';

export type SiteFetchStatus = 'idle' | 'loading' | 'success' | 'error';

export type OpportunityPresenceState =
  | 'missing'
  | 'exists'
  | 'exists_mixed'
  | 'exists_new_ignored'
  | 'exists_ignored_only';
export type SentimentEvaluationStatus = 'idle' | 'running' | 'success' | 'error';
export type SuggestionEvaluationStatus = 'idle' | 'running' | 'success' | 'error';
export type SuggestionRecordStatus =
  | 'NEW'
  | 'PENDING_VALIDATION'
  | 'OUTDATED'
  | 'IGNORED'
  | 'FIXED'
  | 'UNKNOWN';
export type SentimentEvaluationFetchStatus =
  | 'success'
  | 'partial'
  | 'insufficient_evidence'
  | 'fetch_failed';
export type SuggestionEvaluationVerdict = 'Correct' | 'Incorrect' | 'Needs Review';
export type WikipediaUrlEvaluationVerdict =
  | 'Correct'
  | 'Incorrect'
  | 'Needs Review';
export type YouTubeTranscriptStatus =
  | 'available_and_used'
  | 'available_but_not_used'
  | 'not_available'
  | 'not_applicable'
  | 'unknown';

export interface DashboardConfig {
  apiBaseUrl: string;
  apiKey: string;
  siteInputText: string;
}

export interface SpacecatProxyConfig {
  configured: boolean;
  apiBaseUrl: string;
}

export interface SuggestionRecord {
  suggestionId: string;
  suggestionText: string;
  suggestionUrl?: string;
  status?: SuggestionRecordStatus;
  evidenceItems?: string[];
  rowKey?: string;
  canEvaluate?: boolean;
  evaluationStatus?: SuggestionEvaluationStatus;
  evaluationResult?: SuggestionEvaluationResult;
  evaluationError?: string;
}

export interface SentimentItemRecord {
  item: string;
  title?: string;
  sov: string;
  sentiment: string;
  timesCited?: number;
  /** Known competitor brand names for this item, sourced from the backend API (e.g. mentions.others). */
  competitors?: string[];
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
  usedComments?: boolean;
  transcriptStatus?: YouTubeTranscriptStatus;
  evidenceCharacters: number;
  isBrandOwned?: boolean;
}

export interface SentimentEvaluationResult {
  evaluatedSentiment: string;
  sentimentConfidence: number;
  evaluatedSov: string;
  sovConfidence: number;
  evaluatedTargetBrandSharePct: number;
  /** Full rationale covering both sentiment judgment and SOV audit. */
  rationale: string;
  /**
   * Sentiment-only rationale — describes how the content portrays the target
   * brand without mentioning SOV counts or percentage comparisons.
   * Present only when the evaluator supports the field (optional for back-compat).
   */
  sentimentRationale?: string;
  evidenceSnippet: string;
  evaluatedAt: string;
  evaluatorVersion: string;
  evaluatorProvider?: 'bedrock' | 'azure' | 'openai';
  evaluatorModel?: string;
  fetch: SentimentEvaluationFetchMetadata;
  targetBrand: string;
}

export interface SuggestionEvaluationEvidenceSource {
  status: SentimentEvaluationFetchStatus;
  sourceType: 'youtube' | 'reddit' | 'web';
  sourceUrl: string;
  usedTranscript: boolean;
  transcriptStatus?: YouTubeTranscriptStatus;
  evidenceCharacters: number;
}

export interface SuggestionEvaluationResult {
  verdict: SuggestionEvaluationVerdict;
  confidence: number;
  rationale: string;
  evidenceSnippet: string;
  correctedSuggestion: string;
  evaluatedAt: string;
  evaluatorVersion: string;
  evaluatorProvider?: 'bedrock' | 'azure' | 'openai';
  evaluatorModel?: string;
  evidenceSources: SuggestionEvaluationEvidenceSource[];
  targetBrand: string;
}

export interface WikipediaUrlEvaluationRequest {
  site: string;
  resolvedSiteUrl?: string;
  siteId?: string;
  opportunityId?: string;
  wikipediaUrl: string;
}

export interface WikipediaUrlEvaluationResult {
  verdict: WikipediaUrlEvaluationVerdict;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  evidenceSnippet: string;
  wikipediaTitle: string;
  evaluatedAt: string;
  evaluatorVersion: string;
  evaluatorProvider: 'bedrock';
  evaluatorModel: string;
}

export interface SuggestionEvidenceRow {
  item: string;
  title?: string;
  sov: string;
  sentiment: string;
  timesCited?: number;
}

export interface SentimentEvaluationRequest {
  site: string;
  siteId?: string;
  opportunityType: CanonicalOpportunityType;
  opportunityId: string;
  item: string;
  title?: string;
  extractedSov: string;
  extractedSentiment: string;
  timesCited?: number;
  /** Known competitor brand names to explicitly count in the LLM evaluation. */
  competitors?: string[];
}

export interface SuggestionEvaluationRequest {
  site: string;
  siteId?: string;
  opportunityType: CanonicalOpportunityType;
  opportunityId: string;
  suggestionId?: string;
  suggestionText: string;
  suggestionUrl?: string;
  evidenceItems: string[];
  sentimentRows: SuggestionEvidenceRow[];
}

export interface SentimentEvaluationStoredResult extends SentimentEvaluationResult {
  rowKey: string;
  extractedSentiment: string;
  extractedSov: string;
}

export interface SuggestionEvaluationStoredResult extends SuggestionEvaluationResult {
  rowKey: string;
  requestFingerprint: string;
  suggestionText: string;
  suggestionUrl?: string;
}

export interface SentimentEvaluationStore {
  evaluatorVersion: string;
  results: Record<string, SentimentEvaluationStoredResult>;
}

export interface SuggestionEvaluationStore {
  evaluatorVersion: string;
  results: Record<string, SuggestionEvaluationStoredResult>;
}

export interface OpportunityRecord {
  opportunityId: string;
  opportunityType: CanonicalOpportunityType;
  opportunityStatus: string;
  rawType: string;
  wikipediaUrl?: string;
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
  status?: SuggestionRecordStatus;
  evidenceItems?: string[];
  rowKey?: string;
  canEvaluate?: boolean;
  evaluationStatus?: SuggestionEvaluationStatus;
  evaluationResult?: SuggestionEvaluationResult;
  evaluationError?: string;
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
  proxyConfig?: SpacecatProxyConfig;
}

export interface FetchSiteSuccessResult extends SiteDashboardResult {
  status: 'success';
}
