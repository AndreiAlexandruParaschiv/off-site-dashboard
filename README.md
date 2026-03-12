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

## Deploy (Recommended)

GitHub Pages is disabled for Enterprise Managed User repositories in your setup.
Use Netlify or Vercel instead.

### Netlify

This repo includes `netlify.toml` with the build and SPA routing config.

1. In Netlify, import this GitHub repo.
2. Deploy settings will be auto-detected:
   - Build command: `npm run build`
   - Publish directory: `dist`
3. Deploy and share the generated site URL with your team.

### Vercel

This repo includes `vercel.json` with build/output and SPA rewrite config.

1. In Vercel, import this GitHub repo.
2. Confirm settings:
   - Build command: `npm run build`
   - Output directory: `dist`
3. Deploy and share the generated site URL with your team.

## Notes

- Requests are `GET` only.
- API key is manual input only and is not persisted in browser `localStorage`.
- API requests include the configured authentication headers.
- If browser CORS blocks the API, add a server-side proxy for the fetches.
