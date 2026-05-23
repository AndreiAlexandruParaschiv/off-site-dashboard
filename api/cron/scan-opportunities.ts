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

    try {
      // The injected process.env is a permissive Record<string, string>;
      // narrow it to AutoEvaluateEnv. Only documented keys are read inside.
      const summary = await runAutoEvaluateScan(
        runtimeEnv as AutoEvaluateEnv,
      );
      return jsonResponse(summary);
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
