# Off-Site Dashboard

Small React + TypeScript dashboard for read-only API workflows.

## What it does

- Accepts an API key and API base URL.
- Accepts one or more site URLs.
- Resolves `siteId` values through site lookup endpoints.
- Fetches `GET /api/v1/sites/{siteId}/opportunities`.
- Filters to Reddit, YouTube, Cited URLs, Prompt Gap, and Wikipedia opportunities.
- Shows grouped suggestions per opportunity with CSV export.

## Run locally

```bash
npm install
npm run dev
```

## Verify

```bash
npm run build
```

## Sentiment evaluator

The dashboard now includes an on-demand row evaluator for `Sentiment & Share of Voice`.

- Frontend calls `POST /api/offsite-evaluate`
- Vercel uses `api/offsite-evaluate.ts`
- Local `npm run dev` serves the same route through Vite middleware

Required environment variables:

```bash
OPENAI_API_KEY=...
# Optional override
OPENAI_EVALUATOR_MODEL=gpt-4.1-mini
```

Azure OpenAI is also supported:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_KEY=...
# Use your Azure deployment name here. If omitted, the evaluator falls back
# to OPENAI_EVALUATOR_MODEL and then gpt-4.1-mini.
AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini
```

The evaluator independently fetches the cited URL/thread/video and returns:

- evaluated sentiment
- sentiment confidence score
- rationale and evidence snippet

## Deploy

### Vercel

This repo includes `vercel.json` with build/output and SPA rewrite config.

1. In Vercel, import this GitHub repo.
2. Confirm settings:
   - Build command: `npm run build`
   - Output directory: `dist`
3. Deploy and share the generated site URL with your team.

### Amplify

Amplify is supported as a frontend host.

1. In Amplify, connect this GitHub repo and deploy the `off-site-evaluator` branch.
2. Set `VITE_SERVER_API_BASE_URL` to your Vercel deployment URL so the frontend can use the hosted backend routes.
3. Keep backend secrets on Vercel. Use `APP_ALLOWED_ORIGINS` on Vercel to restrict access to your Amplify URL.

### Auto-evaluation cron (optional)

When you want new SpaceCat opportunities to be evaluated automatically and
get GitHub issues filed for `Incorrect` suggestions, enable the cron pipeline:

1. **Enable Vercel KV** on the project (Settings → Storage → Create Database).
   This injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
2. **Add Vercel env vars** (Production):
   - `CRON_SECRET` — random 32+ char string (matches the GitHub Actions secret below)
   - `SPACECAT_API_KEY` — already set if you use the managed proxy
   - `GITHUB_NOTIFY_TOKEN` — GitHub Personal Access Token with `repo` scope (use a
     fine-grained token scoped to the `off-site-dashboard` repo, write Issues)
   - `GITHUB_NOTIFY_REPO` — e.g. `AndreiAlexandruParaschiv/off-site-dashboard`
   - `AUTO_EVAL_TRACKED_SITES` — comma-separated site URLs (e.g. `gmc.com,lovesac.com`)
   - `AUTO_EVAL_TYPES` — optional, comma-separated allowlist of opportunity types
     to evaluate. Defaults to `Wikipedia` so deployments start in POC mode. Widen
     with e.g. `Wikipedia,Reddit,YouTube,Cited URLs` once you trust the pipeline.
   - `AUTO_EVAL_DASHBOARD_URL` — optional, e.g. your Amplify URL, used for deep-links in issues
3. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `AUTO_EVAL_ENDPOINT` — e.g. `https://off-site-dashboard.vercel.app/api/cron/scan-opportunities`
   - `AUTO_EVAL_TOKEN` — same value as `CRON_SECRET`
4. The workflow at `.github/workflows/auto-evaluate.yml` is **manual-only**
   right now (scheduled trigger is commented out). Run it from
   **GitHub → Actions → "Auto-evaluate off-site opportunities" → Run workflow**.
   The Run-workflow form exposes three optional inputs that override the
   Vercel env vars for that single run:
   - `sites` — comma-separated site URLs, e.g. `gmc.com,lovesac.com`. Falls
     back to `AUTO_EVAL_TRACKED_SITES` when blank.
   - `types` — comma-separated opportunity types, e.g. `Wikipedia,Reddit`.
     Falls back to `AUTO_EVAL_TYPES` when blank.
   - `max_per_run` — integer cap on evaluations. Falls back to
     `AUTO_EVAL_MAX_PER_RUN` when blank.

   Re-enable the daily schedule by uncommenting the `schedule:` block in the
   workflow file.

The pipeline atomically claims each new suggestion in KV, so overlapping runs
never double-evaluate. Tune the cadence by editing the cron expression in the
workflow file, and tune throughput per run with `AUTO_EVAL_MAX_PER_RUN`
(default `2`, sized for Vercel Hobby's 60s function timeout).

## Notes

- Requests are `GET` only.
- API key is manual input only and is not persisted in browser `localStorage`.
- API requests include the configured authentication headers.
- If browser CORS blocks the API, add a server-side proxy for the fetches.
