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

1. In Amplify, connect this GitHub repo and deploy the `main` branch.
2. Set `VITE_SERVER_API_BASE_URL` to your Vercel deployment URL so the frontend can use the hosted backend routes.
3. Keep backend secrets on Vercel. Use `APP_ALLOWED_ORIGINS` on Vercel to restrict access to your Amplify URL.

## Notes

- Requests are `GET` only.
- API key is manual input only and is not persisted in browser `localStorage`.
- API requests include the configured authentication headers.
- If browser CORS blocks the API, add a server-side proxy for the fetches.
