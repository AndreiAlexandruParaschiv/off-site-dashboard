import {
  DEFAULT_CONFIG,
  SENTIMENT_EVALUATION_STORAGE_KEY,
  SESSION_EXPIRY_BUFFER_MS,
  SESSION_FALLBACK_TTL_MS,
  SESSION_TOKEN_STORAGE_KEY,
  SUGGESTION_EVALUATION_STORAGE_KEY,
  STORAGE_KEY,
} from './constants';
import { normalizeSentimentEvaluationStore } from './evaluation';
import { normalizeSuggestionEvaluationStore } from './suggestionEvaluation';
import type {
  DashboardConfig,
  PersistedSession,
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

/**
 * Decode a JWT's `exp` (seconds since epoch) into epoch ms, client-side,
 * without verifying the signature — we only need the expiry to decide when to
 * stop reusing a persisted session. Mirrors the server's readJwtExpiryMs.
 * Returns null if the token isn't a JWT or has no numeric `exp`.
 */
export function readJwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload)) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Build a PersistedSession from a freshly minted session token. Prefers the
 * server-supplied `expiresAt`; otherwise decodes the JWT's own `exp`; otherwise
 * falls back to a short TTL so a no-exp token still persists, but briefly.
 */
export function buildPersistedSession(
  token: string,
  serverExpiresAt?: number,
): PersistedSession {
  const expiresAt =
    (typeof serverExpiresAt === 'number' ? serverExpiresAt : null) ??
    readJwtExpiryMs(token) ??
    Date.now() + SESSION_FALLBACK_TTL_MS;
  return { token, expiresAt };
}

/**
 * Read the persisted SpaceCat session token. Returns null if absent,
 * malformed, or already within SESSION_EXPIRY_BUFFER_MS of its expiry — so
 * callers never receive a token that is about to die mid-request.
 */
export function loadPersistedSession(): PersistedSession | null {
  if (!hasWindow()) {
    return null;
  }
  try {
    const rawValue = window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }
    const parsed = JSON.parse(rawValue) as Partial<PersistedSession>;
    if (
      typeof parsed.token !== 'string' ||
      !parsed.token ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    if (parsed.expiresAt - SESSION_EXPIRY_BUFFER_MS <= Date.now()) {
      // Expired (or about to) — drop it so we don't keep a dead token around.
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch (error) {
    console.warn('Failed to read persisted session.', error);
    return null;
  }
}

export function savePersistedSession(session: PersistedSession) {
  if (!hasWindow()) {
    return;
  }
  window.localStorage.setItem(
    SESSION_TOKEN_STORAGE_KEY,
    JSON.stringify(session),
  );
}

export function clearPersistedSession() {
  if (!hasWindow()) {
    return;
  }
  window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
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

/**
 * Wipe the local sentiment-evaluation cache so the next click on Evaluate
 * runs the full server pipeline (after the server-side cache is also
 * cleared via clearEvaluatorCache). Pair this with clearEvaluatorCache()
 * from api.ts when the user clicks the "Reset evaluator cache" button.
 */
export function clearSentimentEvaluationStore() {
  if (!hasWindow()) {
    return;
  }
  window.localStorage.removeItem(SENTIMENT_EVALUATION_STORAGE_KEY);
}
