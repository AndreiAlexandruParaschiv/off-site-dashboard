# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start Vite dev server at localhost:5173 (includes evaluation middleware)
npm run build    # TypeScript type-check + Vite production build → dist/
npm run preview  # Preview production build locally
```

There are no lint or test scripts. TypeScript strict mode is enforced at build time (`npm run build` runs `tsc` before bundling).

## Architecture

**Off-Site Dashboard** is a read-only React + TypeScript app that fetches content opportunity data from a SpaceCat API, displays grouped suggestions, and runs on-demand AI evaluations.

### Data Flow

```
User inputs (API key, base URL, site URLs)
  → SpaceCat API: site lookup → opportunities → suggestions (per-opportunity)
  → Filter to: Reddit, YouTube, Cited URLs, Prompt Gap, Wikipedia
  → Display grouped table + on-demand AI evaluation + XLSX export
```

### Dual-Environment Server Pattern

The evaluation backend runs in two environments that must stay in sync:

- **Development**: `server/*.ts` files — loaded as Vite middleware (see `vite.config.ts`)
- **Production**: `api/*.ts` files — Vercel serverless functions (thin wrappers calling `server/`)

When adding a new evaluation endpoint, add both a `server/` implementation and an `api/` stub. The Vite middleware maps `/api/*` routes to the corresponding `server/` handler.

### Key Frontend Files (`src/features/off-site-dashboard/`)

| File | Purpose |
|------|---------|
| `OffSiteDashboard.tsx` | Main UI component — all panels, tables, and evaluation controls |
| `useOffSiteDashboard.ts` | Custom hook — loading state machine, data fetching orchestration |
| `api.ts` | SpaceCat API client + evaluation request functions with retry logic |
| `utils.ts` | Data normalization: site lookup, opportunity parsing, suggestion merging |
| `types.ts` | All TypeScript interfaces (30+) — start here to understand data shapes |
| `constants.ts` | API paths, default config, evaluator versions, target opportunity types |
| `evaluation.ts` | Sentiment row evaluation: request building, result caching by `rowKey` |
| `suggestionEvaluation.ts` | Suggestion evaluation: verdict tracking, evidence merging |
| `storage.ts` | Versioned localStorage for config and evaluation results |
| `csv.ts` | XLSX export with grouped multi-sheet workbooks |

### Key Backend Files

| File | Purpose |
|------|---------|
| `server/offsite-evaluate.ts` | Sentiment & Share of Voice evaluation (LLM + web scraping via BrightData) |
| `server/offsite-evaluate-suggestion.ts` | Suggestion fact-checking (multi-source evidence gathering + LLM verdict) |
| `server/offsite-evaluate-wikipedia-url.ts` | Wikipedia URL validation (title/content matching) |
| `server/spacecat-proxy.ts` | Optional CORS proxy for SpaceCat API requests |
| `server/auto-evaluate/scan.ts` | Auto-evaluation orchestrator (claim → evaluate → persist → notify) |
| `server/auto-evaluate/kv.ts` | Upstash REST wrapper for Vercel KV |
| `server/auto-evaluate/spacecat-client.ts` | Server-only SpaceCat client (no browser deps) |
| `server/auto-evaluate/github-notify.ts` | GitHub Issues client for `Incorrect` verdicts |
| `api/cron/scan-opportunities.ts` | HTTP entry; bearer auth via `CRON_SECRET` |

### Evaluation Caching

Results are cached in localStorage keyed by a fingerprint of the request inputs. Check `evaluation.ts` and `suggestionEvaluation.ts` for cache key construction before changing input shapes — stale cache entries use versioned storage keys defined in `constants.ts`.

### LLM Provider Chain

The evaluator supports three providers, tried in this order based on which env vars are set:

1. **Azure OpenAI** (`AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_KEY`)
2. **OpenAI** (`OPENAI_API_KEY`)
3. **AWS Bedrock** (`AWS_REGION` + `BEDROCK_MODEL_ID`)

### Environment Variables

```bash
# At least one LLM provider required for evaluation:
OPENAI_API_KEY=...
OPENAI_EVALUATOR_MODEL=gpt-4.1-mini          # optional

AZURE_OPENAI_ENDPOINT=https://...openai.azure.com/
AZURE_OPENAI_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini         # optional

AWS_REGION=us-east-1
BEDROCK_MODEL_ID=us.anthropic.claude-3-5-haiku-20241022-v1:0

# BrightData (web scraping for evaluation evidence):
BRIGHTDATA_API_KEY=...
BRIGHTDATA_WEB_UNLOCKER_ZONE=web_unlocker1
BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID=...
BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID=...
BRIGHTDATA_REDDIT_POST_DATASET_ID=...
BRIGHTDATA_REDDIT_COMMENT_DATASET_ID=...

# Amplify + Vercel split deployment:
VITE_SERVER_API_BASE_URL=https://your-vercel.vercel.app  # frontend only
APP_ALLOWED_ORIGINS=https://your-amplify-url.com         # backend CORS

# SpaceCat auth — S2S (Adobe IMS Server-to-Service), preferred:
IMS_ENDPOINT=https://ims-na1.adobelogin.com
IMS_SP_CLIENT_ID=aem-sites-mystique
IMS_SP_CLIENT_SECRET=...            # secret — Vercel/local env only, never commit
IMS_SP_ORG_ID=...@AdobeOrg
IMS_SP_SCOPE=aem.adobe.service,openid,AdobeID,...   # full provisioned scope
IMS_SP_RESOURCE=                    # optional; only if the IMS token needs a `resource` param
SPACECAT_S2S_LOGIN_URL=             # optional; defaults to <base>/auth/s2s/login
SPACECAT_API_BASE_URL=https://llmo.experiencecloud.live/api/v1   # LLMO host (dev: .../page/api/ci)
# Note: IMS_SP_ORG_ID is also sent on the IMS token request itself (org_id),
# required for ownerless service principals. S2S only works if the SP is
# entitled in SpaceCat's consumer registry for the target site's org.

# Pre-obtained session token — takes precedence over S2S minting when set.
# Used directly as the bearer (S2S skipped). Stopgap for when the SP is not yet
# entitled; tokens are short-lived (~24h), so prefer entitled S2S for prod.
# Its issuer/audience must match SPACECAT_API_BASE_URL's host.
SPACECAT_SESSION_TOKEN=

# User-login path — a raw IMS *user* access token (e.g. copied from the
# Experience Cloud shell / exc_app). When set (and no SPACECAT_SESSION_TOKEN
# or S2S creds), the server exchanges it for a SpaceCat session token via
# POST <base>/auth/login {accessToken}, caching until the returned JWT's exp
# (~24h). Removes the manual "run the /auth/login curl, copy the session JWT"
# step — you set the IMS access token instead. The IMS token itself still
# expires, so prefer entitled S2S (IMS_SP_*) for a fully hands-off setup.
SPACECAT_IMS_ACCESS_TOKEN=
SPACECAT_USER_LOGIN_URL=            # optional; defaults to <base>/auth/login

# Legacy API key — fallback only, removed after 2026-04-15:
SPACECAT_API_KEY=...

# Auth precedence: SPACECAT_SESSION_TOKEN > S2S (IMS_SP_*) >
# user-login (SPACECAT_IMS_ACCESS_TOKEN) > SPACECAT_API_KEY.
# Token minting is server-side only; the browser never receives credentials and routes through `/api/spacecat`.
# On a 401, S2S and the user-login path re-mint once and retry (a pasted
# SPACECAT_SESSION_TOKEN cannot be re-minted, so it is not retried).

# Auto-evaluation cron (optional — only required if running the
# /api/cron/scan-opportunities endpoint):
CRON_SECRET=...                                  # bearer token; matches GH Actions secret
KV_REST_API_URL=https://<id>.upstash.io          # auto-set by Vercel KV integration
KV_REST_API_TOKEN=...                            # auto-set by Vercel KV integration
GITHUB_NOTIFY_TOKEN=ghp_...                      # PAT with `repo` scope for issue creation
GITHUB_NOTIFY_REPO=AndreiAlexandruParaschiv/off-site-dashboard
GITHUB_NOTIFY_LABELS=auto-eval,incorrect         # optional, defaults shown
AUTO_EVAL_TRACKED_SITES=gmc.com,lovesac.com      # comma-separated, no spaces required
AUTO_EVAL_MAX_PER_RUN=2                          # optional; cap evaluations per cron tick
AUTO_EVAL_TYPES=Wikipedia                        # optional; defaults to "Wikipedia" (POC mode)
                                                 # widen with e.g. Wikipedia,Reddit,YouTube,Cited URLs
AUTO_EVAL_DASHBOARD_URL=https://off-site-evaluator.<id>.amplifyapp.com  # optional deep-link
```

### Auto-evaluation pipeline

Files under `server/auto-evaluate/` and `api/cron/scan-opportunities.ts` implement
an automated scan that:

1. Walks each site in `AUTO_EVAL_TRACKED_SITES` via the SpaceCat API
2. Atomically claims new suggestions in Vercel KV (so overlapping runs never double-evaluate)
3. Runs `runOffsiteSuggestionEvaluation` on each new suggestion
4. Persists the verdict to KV; if `Incorrect`, files a labeled GitHub issue

The trigger is **GitHub Actions** (`.github/workflows/auto-evaluate.yml`),
currently manual-only via `workflow_dispatch` (the scheduled trigger is
commented out — uncomment the `schedule:` block to re-enable). The Actions
job POSTs to `/api/cron/scan-opportunities` with
`Authorization: Bearer ${CRON_SECRET}` and an optional JSON body of per-run
overrides:

```json
{ "sites": "gmc.com,lovesac.com", "types": "Wikipedia,Reddit", "maxPerRun": "3" }
```

Each override key is optional. When present, it overlays the corresponding
Vercel env var (`AUTO_EVAL_TRACKED_SITES`, `AUTO_EVAL_TYPES`,
`AUTO_EVAL_MAX_PER_RUN`) for that single invocation only. The endpoint
caps body size and override-string length to keep the surface area small,
and authentication still gates everything via `CRON_SECRET`.

### State Management

No external state library — React hooks + versioned localStorage. `useOffSiteDashboard.ts` owns all async state. The API key is intentionally never persisted to localStorage.
