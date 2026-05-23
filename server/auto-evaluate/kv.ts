// Minimal Upstash Redis (Vercel KV) REST wrapper.
//
// We use the REST API directly instead of `@upstash/redis` to avoid pulling
// an extra dependency and to keep cold-start size small. Vercel injects
// KV_REST_API_URL + KV_REST_API_TOKEN automatically when the Vercel KV
// integration is enabled on the project.

export type KvEnv = {
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
};

const UPSTASH_REQUEST_TIMEOUT_MS = 5000;

function getCredentials(env: KvEnv) {
  const baseUrl = env.KV_REST_API_URL?.trim();
  const token = env.KV_REST_API_TOKEN?.trim();

  if (!baseUrl || !token) {
    throw new Error(
      'Vercel KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN on the deployment.',
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

async function pipelineRequest<T>(
  env: KvEnv,
  command: (string | number)[],
): Promise<T> {
  const { baseUrl, token } = getCredentials(env);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTASH_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Upstash KV command ${command[0]} failed with ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as { result?: T; error?: string };
    if (payload.error) {
      throw new Error(`Upstash KV error: ${payload.error}`);
    }
    return payload.result as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function kvGet<T = unknown>(
  env: KvEnv,
  key: string,
): Promise<T | null> {
  const raw = await pipelineRequest<string | null>(env, ['GET', key]);
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

export async function kvSet(
  env: KvEnv,
  key: string,
  value: unknown,
  options: { ttlSeconds?: number } = {},
): Promise<void> {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value);
  const command: (string | number)[] = ['SET', key, serialized];
  if (options.ttlSeconds && options.ttlSeconds > 0) {
    command.push('EX', Math.floor(options.ttlSeconds));
  }
  await pipelineRequest(env, command);
}

/**
 * SET with NX + optional EX. Returns true if the value was set (i.e. key did
 * not already exist), false otherwise. This is how we atomically "claim" a
 * suggestion for evaluation, preventing duplicate work across overlapping
 * cron runs.
 */
export async function kvSetIfAbsent(
  env: KvEnv,
  key: string,
  value: unknown,
  options: { ttlSeconds?: number } = {},
): Promise<boolean> {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value);
  const command: (string | number)[] = ['SET', key, serialized, 'NX'];
  if (options.ttlSeconds && options.ttlSeconds > 0) {
    command.push('EX', Math.floor(options.ttlSeconds));
  }
  const result = await pipelineRequest<string | null>(env, command);
  return result === 'OK';
}

export async function kvDelete(env: KvEnv, key: string): Promise<void> {
  await pipelineRequest(env, ['DEL', key]);
}

export async function kvZAdd(
  env: KvEnv,
  key: string,
  score: number,
  member: string,
): Promise<void> {
  await pipelineRequest(env, ['ZADD', key, score, member]);
}

export async function kvZRangeRev(
  env: KvEnv,
  key: string,
  limit: number,
): Promise<string[]> {
  const result = await pipelineRequest<string[] | null>(env, [
    'ZRANGE',
    key,
    0,
    Math.max(0, limit - 1),
    'REV',
  ]);
  return Array.isArray(result) ? result : [];
}
