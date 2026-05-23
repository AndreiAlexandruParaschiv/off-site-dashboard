// Auto-evaluation cron orchestrator.
//
// Called by the /api/cron/scan-opportunities endpoint (triggered from a
// GitHub Actions schedule). Steps:
//   1. Walk each tracked site → list opportunities → list suggestions.
//   2. Atomically "claim" each unseen suggestion via Vercel KV (SET NX),
//      so overlapping cron runs never double-evaluate the same item.
//   3. Run runOffsiteSuggestionEvaluation() on each claim (capped per run
//      to stay under the Hobby 60s function timeout).
//   4. Persist the verdict to KV. If verdict === "Incorrect", file a
//      GitHub issue and remember the issue number (for future dedup +
//      dashboard linkbacks).
//
// IMPORTANT: This module is server-only. Do not import anything that
// touches `window`, `document`, `import.meta.env`, or `localStorage`.

import { runOffsiteSuggestionEvaluation } from '../offsite-evaluate-suggestion.js';
import type {
  SuggestionEvaluationRequest,
  SuggestionEvaluationResult,
} from '../../src/features/off-site-dashboard/types.js';
import {
  kvGet,
  kvSet,
  kvSetIfAbsent,
  kvZAdd,
  type KvEnv,
} from './kv.js';
import {
  createIncorrectIssue,
  type GithubNotifyEnv,
} from './github-notify.js';
import {
  listOpportunities,
  listSuggestions,
  resolveSiteId,
  type AutoEvalOpportunityType,
  type SpacecatClientEnv,
} from './spacecat-client.js';

// The auto-evaluation cron forwards env vars directly into the underlying
// evaluator (`runOffsiteSuggestionEvaluation`), so this type explicitly
// lists every key the evaluator may read. We deliberately avoid an open
// `[key: string]: string | undefined` index signature because TypeScript's
// strict mode treats such an index as incompatible with the evaluator's
// closed `ServerEnv` literal type.
export type AutoEvaluateEnv = KvEnv &
  GithubNotifyEnv &
  SpacecatClientEnv & {
    AUTO_EVAL_TRACKED_SITES?: string;
    AUTO_EVAL_MAX_PER_RUN?: string;
    AUTO_EVAL_LOCK_TTL_SECONDS?: string;
    AUTO_EVAL_DASHBOARD_URL?: string;
    /**
     * Comma-separated allowlist of opportunity types to evaluate.
     * Defaults to "Wikipedia" so a fresh deployment starts in POC mode
     * and only widens scope when the operator explicitly opts in.
     * Valid values: Reddit, YouTube, Cited URLs, Wikipedia (case-insensitive).
     */
    AUTO_EVAL_TYPES?: string;
    // Mirrors of the evaluator's `ServerEnv` so we can pass `env` straight
    // through without losing type information.
    AWS_BEARER_TOKEN_BEDROCK?: string;
    BEDROCK_BEARER_TOKEN?: string;
    AWS_REGION?: string;
    BEDROCK_REGION?: string;
    BEDROCK_MODEL_ID?: string;
    BEDROCK_MODEL?: string;
    BRIGHTDATA_API_KEY?: string;
    BRIGHTDATA_WEB_UNLOCKER_ZONE?: string;
    BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID?: string;
    BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID?: string;
    BRIGHTDATA_YOUTUBE_TRANSCRIPTION_LANGUAGE?: string;
    BRIGHTDATA_YOUTUBE_ASYNC_FALLBACK?: string;
    BRIGHTDATA_YOUTUBE_ASYNC_TIMEOUT_MS?: string;
    BRIGHTDATA_REDDIT_POST_DATASET_ID?: string;
    BRIGHTDATA_REDDIT_COMMENT_DATASET_ID?: string;
    OPENAI_API_KEY?: string;
    OPENAI_EVALUATOR_MODEL?: string;
    AZURE_OPENAI_ENDPOINT?: string;
    AZURE_OPENAI_KEY?: string;
    AZURE_OPENAI_DEPLOYMENT?: string;
  };

const SCAN_LOCK_KEY = 'auto-eval:scan:lock';
const DEFAULT_LOCK_TTL_SECONDS = 14 * 60;
const SEEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const DEFAULT_MAX_PER_RUN = 2;
const INBOX_KEY = 'auto-eval:inbox:incorrect';

const ALL_AUTO_EVAL_TYPES: readonly AutoEvalOpportunityType[] = [
  'Reddit',
  'YouTube',
  'Cited URLs',
  'Wikipedia',
];

// POC mode: default to Wikipedia only so a fresh deployment starts in a
// narrow, well-validated scope. Operators widen by setting
// AUTO_EVAL_TYPES=Wikipedia,Reddit,YouTube,Cited URLs on Vercel.
const DEFAULT_AUTO_EVAL_TYPES: readonly AutoEvalOpportunityType[] = [
  'Wikipedia',
];

export interface SiteDiscoveryReport {
  site: string;
  siteId?: string;
  rawOpportunities: number;
  classifiedOpportunities: number;
  inspectedOpportunities: number;
  skippedOpportunities: number;
  /**
   * Classified opportunities filtered out by the AUTO_EVAL_TYPES
   * allowlist (e.g. a Reddit opportunity when only Wikipedia is enabled).
   */
  filteredByTypeOpportunities: number;
  totalRawSuggestions: number;
  totalParsedSuggestions: number;
  /** Suggestions from `inspect` opportunities whose content did not match any off-site type. */
  inspectedSuggestionsDropped: number;
  /** Parsed suggestions filtered out by the AUTO_EVAL_TYPES allowlist (inspect-mode case). */
  filteredByTypeSuggestions: number;
  newlyClaimed: number;
  unclassifiedRawTypes?: string[];
  /**
   * Debug-only: when the raw suggestion payload has entries but our
   * extractor returns nothing, we surface a sample so we can adapt the
   * parser. Cleared on healthy runs.
   */
  sampleUnparseableSuggestion?: unknown;
}

export interface ScanSummary {
  ran: boolean;
  skippedReason?: string;
  sites: string[];
  enabledTypes: AutoEvalOpportunityType[];
  discovery: SiteDiscoveryReport[];
  processed: number;
  flaggedIncorrect: number;
  issuesCreated: number;
  errors: Array<{ site: string; suggestionId?: string; error: string }>;
}

function parseTrackedSites(env: AutoEvaluateEnv): string[] {
  const raw = env.AUTO_EVAL_TRACKED_SITES?.trim() || '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseEnabledTypes(
  env: AutoEvaluateEnv,
): ReadonlySet<AutoEvalOpportunityType> {
  const raw = env.AUTO_EVAL_TYPES?.trim() || '';
  if (!raw) return new Set(DEFAULT_AUTO_EVAL_TYPES);

  const enabled = new Set<AutoEvalOpportunityType>();
  for (const piece of raw.split(',')) {
    const normalized = piece.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const candidate of ALL_AUTO_EVAL_TYPES) {
      const canonical = candidate.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (canonical === normalized) {
        enabled.add(candidate);
      }
    }
  }

  return enabled.size > 0 ? enabled : new Set(DEFAULT_AUTO_EVAL_TYPES);
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSeenKey(
  siteId: string,
  opportunityId: string,
  suggestionId: string,
) {
  return `auto-eval:seen:${siteId}:${opportunityId}:${suggestionId}`;
}

function buildVerdictKey(
  siteId: string,
  opportunityId: string,
  suggestionId: string,
) {
  return `auto-eval:verdict:${siteId}:${opportunityId}:${suggestionId}`;
}

function buildNotifiedKey(
  siteId: string,
  opportunityId: string,
  suggestionId: string,
) {
  return `auto-eval:notified:${siteId}:${opportunityId}:${suggestionId}`;
}

function buildDashboardDeepLink(
  env: AutoEvaluateEnv,
  siteUrl: string,
  opportunityId: string,
  suggestionId: string,
) {
  const base = env.AUTO_EVAL_DASHBOARD_URL?.trim();
  if (!base) return undefined;
  const params = new URLSearchParams({
    site: siteUrl,
    opportunity: opportunityId,
    suggestion: suggestionId,
  });
  return `${base.replace(/\/+$/, '')}/?${params.toString()}`;
}

interface ScanWorkItem {
  site: string;
  siteId: string;
  siteUrl: string;
  opportunityId: string;
  opportunityType: 'Reddit' | 'YouTube' | 'Cited URLs' | 'Wikipedia';
  suggestionId: string;
  suggestionText: string;
  suggestionUrl?: string;
  evidenceItems: string[];
}

async function discoverNewSuggestions(
  trackedSites: string[],
  maxPerRun: number,
  enabledTypes: ReadonlySet<AutoEvalOpportunityType>,
  env: AutoEvaluateEnv,
  summary: ScanSummary,
): Promise<ScanWorkItem[]> {
  const work: ScanWorkItem[] = [];

  for (const site of trackedSites) {
    const siteReport: SiteDiscoveryReport = {
      site,
      rawOpportunities: 0,
      classifiedOpportunities: 0,
      inspectedOpportunities: 0,
      skippedOpportunities: 0,
      filteredByTypeOpportunities: 0,
      totalRawSuggestions: 0,
      totalParsedSuggestions: 0,
      inspectedSuggestionsDropped: 0,
      filteredByTypeSuggestions: 0,
      newlyClaimed: 0,
    };
    summary.discovery.push(siteReport);

    if (work.length >= maxPerRun) continue;

    let siteId: string;
    let siteUrl: string;
    try {
      const resolved = await resolveSiteId(site, env);
      siteId = resolved.siteId;
      siteUrl = resolved.siteUrl;
      siteReport.siteId = siteId;
    } catch (error) {
      summary.errors.push({
        site,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let opportunities;
    let diagnostics;
    try {
      const result = await listOpportunities(siteId, env);
      opportunities = result.opportunities;
      diagnostics = result.diagnostics;
    } catch (error) {
      summary.errors.push({
        site,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    siteReport.rawOpportunities = diagnostics.rawCount;
    siteReport.classifiedOpportunities = diagnostics.classifiedCount;
    siteReport.inspectedOpportunities = diagnostics.inspectCount;
    siteReport.skippedOpportunities = diagnostics.skippedCount;
    if (diagnostics.unclassifiedRawTypes.length > 0) {
      siteReport.unclassifiedRawTypes = diagnostics.unclassifiedRawTypes;
    }

    for (const opportunity of opportunities) {
      const fallbackType =
        opportunity.classification.mode === 'classified'
          ? opportunity.classification.opportunityType
          : undefined;

      // Skip whole opportunities of a disabled type at this layer
      // (saves the SpaceCat /suggestions fetch). `inspect` opportunities
      // still need to be fetched because we don't know their suggestions'
      // types until we read the content.
      if (fallbackType && !enabledTypes.has(fallbackType)) {
        siteReport.filteredByTypeOpportunities += 1;
        continue;
      }

      let suggestionListing;
      try {
        suggestionListing = await listSuggestions(
          siteId,
          opportunity.opportunityId,
          fallbackType,
          env,
        );
      } catch (error) {
        summary.errors.push({
          site,
          error: `opportunity ${opportunity.opportunityId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
      siteReport.totalRawSuggestions += suggestionListing.rawEntryCount;
      siteReport.totalParsedSuggestions += suggestionListing.suggestions.length;
      siteReport.inspectedSuggestionsDropped +=
        suggestionListing.unclassifiedByContentCount;
      if (
        suggestionListing.unparseableSample &&
        !siteReport.sampleUnparseableSuggestion
      ) {
        siteReport.sampleUnparseableSuggestion =
          suggestionListing.unparseableSample;
      }

      for (const classifiedSuggestion of suggestionListing.suggestions) {
        if (work.length >= maxPerRun) break;

        // For `inspect`-mode opportunities, each suggestion's type was
        // decided per-suggestion. Filter out the ones whose type isn't on
        // the allowlist.
        if (!enabledTypes.has(classifiedSuggestion.opportunityType)) {
          siteReport.filteredByTypeSuggestions += 1;
          continue;
        }

        const suggestion = classifiedSuggestion.suggestion;
        const seenKey = buildSeenKey(
          siteId,
          opportunity.opportunityId,
          suggestion.suggestionId,
        );

        let claimed: boolean;
        try {
          claimed = await kvSetIfAbsent(
            env,
            seenKey,
            { claimedAt: new Date().toISOString() },
            { ttlSeconds: SEEN_TTL_SECONDS },
          );
        } catch (error) {
          summary.errors.push({
            site,
            suggestionId: suggestion.suggestionId,
            error: `kv claim: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          continue;
        }
        if (!claimed) continue;
        siteReport.newlyClaimed += 1;

        work.push({
          site,
          siteId,
          siteUrl,
          opportunityId: opportunity.opportunityId,
          opportunityType: classifiedSuggestion.opportunityType,
          suggestionId: suggestion.suggestionId,
          suggestionText: suggestion.suggestionText,
          suggestionUrl: suggestion.suggestionUrl,
          evidenceItems: suggestion.evidenceItems,
        });
      }
    }
  }

  return work;
}

function buildEvaluationRequest(
  item: ScanWorkItem,
): SuggestionEvaluationRequest {
  return {
    site: item.siteUrl,
    siteId: item.siteId,
    opportunityType: item.opportunityType,
    opportunityId: item.opportunityId,
    suggestionId: item.suggestionId,
    suggestionText: item.suggestionText,
    suggestionUrl: item.suggestionUrl,
    evidenceItems: item.evidenceItems,
    sentimentRows: [],
  };
}

async function processWorkItem(
  item: ScanWorkItem,
  env: AutoEvaluateEnv,
  summary: ScanSummary,
): Promise<void> {
  let result: SuggestionEvaluationResult;
  try {
    result = await runOffsiteSuggestionEvaluation(
      buildEvaluationRequest(item),
      env,
    );
  } catch (error) {
    summary.errors.push({
      site: item.site,
      suggestionId: item.suggestionId,
      error: `evaluate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return;
  }

  summary.processed += 1;

  const verdictKey = buildVerdictKey(
    item.siteId,
    item.opportunityId,
    item.suggestionId,
  );
  try {
    await kvSet(env, verdictKey, {
      siteUrl: item.siteUrl,
      site: item.site,
      opportunityId: item.opportunityId,
      opportunityType: item.opportunityType,
      suggestionId: item.suggestionId,
      suggestionText: item.suggestionText,
      suggestionUrl: item.suggestionUrl,
      verdict: result.verdict,
      confidence: result.confidence,
      rationale: result.rationale,
      correctedSuggestion: result.correctedSuggestion,
      evidenceSnippet: result.evidenceSnippet,
      evaluatedAt: result.evaluatedAt,
      evaluatorVersion: result.evaluatorVersion,
    });
  } catch (error) {
    summary.errors.push({
      site: item.site,
      suggestionId: item.suggestionId,
      error: `kv verdict: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  if (result.verdict !== 'Incorrect') return;

  summary.flaggedIncorrect += 1;

  const notifiedKey = buildNotifiedKey(
    item.siteId,
    item.opportunityId,
    item.suggestionId,
  );
  let alreadyNotified: unknown = null;
  try {
    alreadyNotified = await kvGet(env, notifiedKey);
  } catch {
    // If we cannot reach KV for the dedup check, prefer not to spam new
    // issues — log and bail.
    summary.errors.push({
      site: item.site,
      suggestionId: item.suggestionId,
      error: 'kv notified-check unavailable; skipping issue creation',
    });
    return;
  }
  if (alreadyNotified) return;

  try {
    const issue = await createIncorrectIssue(
      {
        site: item.siteUrl,
        opportunityType: item.opportunityType,
        opportunityId: item.opportunityId,
        suggestionId: item.suggestionId,
        suggestionText: item.suggestionText,
        suggestionUrl: item.suggestionUrl,
        verdict: 'Incorrect',
        rationale: result.rationale,
        evidenceSnippet: result.evidenceSnippet,
        correctedSuggestion: result.correctedSuggestion,
        evaluatedAt: result.evaluatedAt,
        evidenceSourceUrls: (result.evidenceSources ?? [])
          .map((source) => source.sourceUrl)
          .filter(Boolean),
        dashboardUrl: buildDashboardDeepLink(
          env,
          item.siteUrl,
          item.opportunityId,
          item.suggestionId,
        ),
      },
      env,
    );

    summary.issuesCreated += 1;

    await kvSet(env, notifiedKey, {
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
      notifiedAt: new Date().toISOString(),
    });
    await kvZAdd(env, INBOX_KEY, Date.now(), verdictKey);
  } catch (error) {
    summary.errors.push({
      site: item.site,
      suggestionId: item.suggestionId,
      error: `github notify: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

export async function runAutoEvaluateScan(
  env: AutoEvaluateEnv,
): Promise<ScanSummary> {
  const trackedSites = parseTrackedSites(env);
  const enabledTypes = parseEnabledTypes(env);
  const summary: ScanSummary = {
    ran: false,
    sites: trackedSites,
    enabledTypes: Array.from(enabledTypes),
    discovery: [],
    processed: 0,
    flaggedIncorrect: 0,
    issuesCreated: 0,
    errors: [],
  };

  if (trackedSites.length === 0) {
    summary.skippedReason =
      'AUTO_EVAL_TRACKED_SITES is empty; no sites to monitor.';
    return summary;
  }

  const lockTtl = parsePositiveInt(
    env.AUTO_EVAL_LOCK_TTL_SECONDS,
    DEFAULT_LOCK_TTL_SECONDS,
  );

  let acquiredLock = false;
  try {
    acquiredLock = await kvSetIfAbsent(
      env,
      SCAN_LOCK_KEY,
      { startedAt: new Date().toISOString() },
      { ttlSeconds: lockTtl },
    );
  } catch (error) {
    summary.skippedReason = `kv lock acquire failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return summary;
  }

  if (!acquiredLock) {
    summary.skippedReason = 'another scan is already in progress';
    return summary;
  }

  summary.ran = true;

  try {
    const maxPerRun = parsePositiveInt(
      env.AUTO_EVAL_MAX_PER_RUN,
      DEFAULT_MAX_PER_RUN,
    );
    const work = await discoverNewSuggestions(
      trackedSites,
      maxPerRun,
      enabledTypes,
      env,
      summary,
    );

    for (const item of work) {
      await processWorkItem(item, env, summary);
    }
  } finally {
    // Lock expires on its own TTL; release early so the next run isn't
    // blocked when this finishes well before the TTL.
    try {
      await kvSet(env, SCAN_LOCK_KEY, { released: true }, { ttlSeconds: 1 });
    } catch {
      // Lock self-expires; nothing to do if release fails.
    }
  }

  return summary;
}
