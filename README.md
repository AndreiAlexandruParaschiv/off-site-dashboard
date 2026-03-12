# Off-Site Dashboard

Small React + TypeScript dashboard for SpaceCat read-only API workflows.

## What it does

- Accepts an API key and SpaceCat API base URL.
- Accepts one or more site URLs.
- Resolves `siteId` values through SpaceCat site lookup endpoints.
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

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow at:

- `.github/workflows/deploy-pages.yml`

To enable it:

1. Push to `main`.
2. In GitHub repo settings, open `Pages`.
3. Set `Source` to `GitHub Actions`.
4. The workflow will build and deploy `dist/`.

## Notes

- Requests are `GET` only.
- API key is manual input only and is not persisted in browser `localStorage`.
- API requests send `Authorization: Bearer <API_KEY>` (and `x-api-key` for compatibility).
- If browser CORS blocks the API, add a server-side proxy for the fetches.
