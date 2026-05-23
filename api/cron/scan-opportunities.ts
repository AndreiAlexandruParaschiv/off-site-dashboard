import {
  runAutoEvaluateScan,
  type AutoEvaluateEnv,
} from '../../server/auto-evaluate/scan.js';

// Run as a Node serverless function. The auto-evaluation pipeline does
// CPU-light work (fetches + LLM call) but the LLM round-trip alone can
// take ~30s, so we explicitly request the longest function duration the
// Vercel Hobby plan allows (60 seconds).
export const runtime = 'nodejs';
export const maxDuration = 60;

const runtimeEnv =
  (
    globalThis as typeof globalThis & {
      process?: {
        env?: Record<string, string | undefined>;
      };
    }
  ).process?.env ?? {};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// Constant-time compare to avoid leaking the secret length via timing.
// We could pull `timingSafeEqual` from `node:crypto` here, but on the
// Vercel runtime the simple length-then-XOR pattern is sufficient given
// the secret length is fixed and the function is rate-limited externally
// (only GitHub Actions hits this).
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function isAuthorized(request: Request, expectedSecret: string): boolean {
  const header = request.headers.get('authorization')?.trim() ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const presented = header.slice(7).trim();
  if (!presented) return false;
  return timingSafeStringEqual(presented, expectedSecret);
}

// Per-request overrides accepted in the JSON body. Each is optional;
// when present, it overrides the corresponding Vercel env var for this
// invocation only. Keeping the surface small (just the three knobs an
// operator typically wants to change on an ad-hoc run) keeps the
// override path easy to reason about and prevents the endpoint from
// becoming a back-door for arbitrary configuration.
interface RequestOverrides {
  sites?: string;
  types?: string;
  maxPerRun?: string;
}

// Hard cap on the body we will parse — anything larger almost certainly
// isn't a legitimate request and should be rejected before we touch it.
const MAX_BODY_BYTES = 4 * 1024;
const MAX_OVERRIDE_LENGTH = 1024;

function sanitizeOverrideString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_OVERRIDE_LENGTH) return undefined;
  return trimmed;
}

async function parseOverrides(request: Request): Promise<RequestOverrides> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return {};

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return {};
  }
  if (!raw || raw.length > MAX_BODY_BYTES) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const candidate = parsed as Record<string, unknown>;
  return {
    sites: sanitizeOverrideString(candidate.sites),
    types: sanitizeOverrideString(candidate.types),
    maxPerRun: sanitizeOverrideString(candidate.maxPerRun),
  };
}

function applyOverrides(
  baseEnv: Record<string, string | undefined>,
  overrides: RequestOverrides,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...baseEnv };
  if (overrides.sites) merged.AUTO_EVAL_TRACKED_SITES = overrides.sites;
  if (overrides.types) merged.AUTO_EVAL_TYPES = overrides.types;
  if (overrides.maxPerRun) merged.AUTO_EVAL_MAX_PER_RUN = overrides.maxPerRun;
  return merged;
}

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed.' }, 405);
    }

    const expectedSecret = (runtimeEnv.CRON_SECRET ?? '').trim();
    if (!expectedSecret) {
      return jsonResponse(
        {
          error:
            'CRON_SECRET is not configured. The auto-evaluation endpoint is disabled.',
        },
        503,
      );
    }
    if (!isAuthorized(request, expectedSecret)) {
      return jsonResponse({ error: 'Unauthorized.' }, 401);
    }

    // Read optional per-run overrides from the request body. This lets
    // an operator run the workflow against a different site / type /
    // batch size without touching Vercel env vars. Body is only read
    // for POST requests; GETs always use the deployed defaults.
    const overrides =
      request.method === 'POST' ? await parseOverrides(request) : {};
    const effectiveEnv = applyOverrides(runtimeEnv, overrides);

    try {
      // The injected process.env is a permissive Record<string, string>;
      // narrow it to AutoEvaluateEnv. Only documented keys are read inside.
      const summary = await runAutoEvaluateScan(
        effectiveEnv as AutoEvaluateEnv,
      );
      return jsonResponse({
        ...summary,
        appliedOverrides: overrides,
      });
    } catch (error) {
      console.error('Auto-evaluation scan failed.', error);
      return jsonResponse(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Unexpected auto-evaluation error.',
        },
        500,
      );
    }
  },
};
