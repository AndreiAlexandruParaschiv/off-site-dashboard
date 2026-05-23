// Thin GitHub Issues REST wrapper for the auto-evaluation cron.
//
// We POST directly with fetch instead of pulling in @octokit/* to keep the
// serverless bundle small and the dependency surface narrow.

export type GithubNotifyEnv = {
  GITHUB_NOTIFY_TOKEN?: string;
  GITHUB_NOTIFY_REPO?: string;
  GITHUB_NOTIFY_LABELS?: string;
  GITHUB_NOTIFY_API_BASE_URL?: string;
};

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_REQUEST_TIMEOUT_MS = 10000;

export interface IncorrectFindingPayload {
  site: string;
  opportunityType: 'Reddit' | 'YouTube' | 'Cited URLs' | 'Wikipedia';
  opportunityId: string;
  suggestionId: string;
  suggestionText: string;
  suggestionUrl?: string;
  verdict: 'Incorrect';
  rationale: string;
  evidenceSnippet: string;
  correctedSuggestion?: string;
  evaluatedAt: string;
  evidenceSourceUrls: string[];
  dashboardUrl?: string;
}

interface GithubRepoCoords {
  owner: string;
  repo: string;
}

function parseRepoCoords(env: GithubNotifyEnv): GithubRepoCoords {
  const value = env.GITHUB_NOTIFY_REPO?.trim();
  if (!value || !value.includes('/')) {
    throw new Error(
      'GITHUB_NOTIFY_REPO must be set to "owner/repo" (e.g. AndreiAlexandruParaschiv/off-site-dashboard).',
    );
  }
  const [owner, repo] = value.split('/', 2);
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_NOTIFY_REPO "${value}" is malformed. Expected "owner/repo".`,
    );
  }
  return { owner, repo };
}

function parseLabels(env: GithubNotifyEnv): string[] {
  const raw = env.GITHUB_NOTIFY_LABELS?.trim() || 'auto-eval,incorrect';
  return raw
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

function getApiBaseUrl(env: GithubNotifyEnv) {
  return (
    env.GITHUB_NOTIFY_API_BASE_URL?.trim() || DEFAULT_GITHUB_API_BASE_URL
  ).replace(/\/+$/, '');
}

async function githubRequest<T>(
  url: string,
  init: RequestInit & { token: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${init.token}`,
        ...(init.body
          ? { 'content-type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `GitHub ${response.status} ${response.statusText} for ${url}: ${detail.slice(0, 200)}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(value: string, limit: number) {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function buildIssueTitle(payload: IncorrectFindingPayload): string {
  return `[Auto-eval] Incorrect (${payload.opportunityType}): ${truncate(
    payload.suggestionText,
    80,
  )} — ${payload.site}`;
}

function buildIssueBody(payload: IncorrectFindingPayload): string {
  const lines: string[] = [];

  lines.push('## Verdict: Incorrect', '');
  lines.push(`- **Site:** ${payload.site}`);
  lines.push(
    `- **Opportunity type:** ${payload.opportunityType} (\`${payload.opportunityId}\`)`,
  );
  lines.push(`- **Suggestion ID:** \`${payload.suggestionId}\``);
  if (payload.suggestionUrl) {
    lines.push(`- **Source URL:** ${payload.suggestionUrl}`);
  }
  lines.push(`- **Evaluated at:** ${payload.evaluatedAt}`);
  lines.push('');

  lines.push('### Suggestion', '', payload.suggestionText, '');

  lines.push('### Why it was flagged', '', payload.rationale, '');

  if (payload.correctedSuggestion?.trim()) {
    lines.push(
      '### Suggested correction',
      '',
      payload.correctedSuggestion.trim(),
      '',
    );
  }

  if (payload.evidenceSnippet.trim()) {
    lines.push('### Evidence snippet', '', '> ' +
      payload.evidenceSnippet.trim().replace(/\n/g, '\n> '), '');
  }

  if (payload.evidenceSourceUrls.length > 0) {
    lines.push('### Evidence sources', '');
    for (const url of payload.evidenceSourceUrls.slice(0, 5)) {
      lines.push(`- ${url}`);
    }
    lines.push('');
  }

  if (payload.dashboardUrl) {
    lines.push(`[Open in dashboard →](${payload.dashboardUrl})`, '');
  }

  lines.push(
    '---',
    '_Created automatically by the off-site auto-evaluation cron._',
  );

  return lines.join('\n');
}

export interface CreatedGithubIssue {
  issueNumber: number;
  issueUrl: string;
}

export async function createIncorrectIssue(
  payload: IncorrectFindingPayload,
  env: GithubNotifyEnv,
): Promise<CreatedGithubIssue> {
  const token = env.GITHUB_NOTIFY_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'GITHUB_NOTIFY_TOKEN is not configured. Auto-evaluation cannot file issues.',
    );
  }
  const { owner, repo } = parseRepoCoords(env);
  const labels = parseLabels(env);
  const baseUrl = getApiBaseUrl(env);

  const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/issues`;

  const body = {
    title: buildIssueTitle(payload),
    body: buildIssueBody(payload),
    labels,
  };

  const response = await githubRequest<{
    number: number;
    html_url: string;
  }>(url, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });

  return {
    issueNumber: response.number,
    issueUrl: response.html_url,
  };
}
