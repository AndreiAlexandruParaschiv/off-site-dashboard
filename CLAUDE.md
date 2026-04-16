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
```

### State Management

No external state library — React hooks + versioned localStorage. `useOffSiteDashboard.ts` owns all async state. The API key is intentionally never persisted to localStorage.
