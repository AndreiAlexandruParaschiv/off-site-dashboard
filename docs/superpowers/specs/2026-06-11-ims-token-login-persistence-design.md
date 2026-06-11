# IMS-Token Login with 24h Cross-Tab Session Persistence

**Date:** 2026-06-11
**Branch:** off-site-evaluator
**Status:** Approved design — ready for implementation plan

## Problem

A SpaceCat session token is required to read opportunities/suggestions across
the dashboard's five workspaces (Opportunities, Evaluation, Wikipedia Check,
Suggestions Patcher, Back Office). Today the token (`userToken` in
`useOffSiteDashboard.ts`) must be obtained manually — run the `/auth/login`
curl, copy the session JWT, paste it — and it is **not persisted**, so it must
be re-pasted on every reload and in every new browser tab.

We want: paste an IMS *user* access token (valid ~24h, e.g. copied from the
Experience Cloud shell) once, have the app exchange it server-side for a
SpaceCat session token, and keep that session usable across all five
workspaces **and** across browser tabs/reloads until it expires (~24h). On
expiry, the user re-pastes a fresh IMS token.

A prior commit (`1b04a44`, "feat(auth): log in with an IMS token to mint the
session token") built the IMS-token exchange flow but was reverted four
minutes later (`0fa28f5`) as premature — not because of a defect. It lacked
persistence. This design re-instates that work and adds the missing
persistence layer.

## Decisions (locked with the user)

- **Mechanism:** Login UI where the user pastes an IMS user access token; the
  app exchanges it server-side for a SpaceCat session token. (Not full
  hands-off S2S; not a one-off minted token.)
- **What is persisted:** The **SpaceCat session token only** (plus its expiry),
  in `localStorage`. The IMS access token is *never* persisted. When the
  session expires, the user re-pastes the IMS token. (We do not retain the IMS
  token to silently re-exchange.)
- **Reuse over rewrite:** Restore the reverted commit verbatim, then layer
  persistence on top (Approach A).

## Approach

**Approach A (chosen): Revert-the-revert + add session persistence.**
`git revert 0fa28f5` restores the full IMS-login stack unchanged, then we add a
session-persistence layer as the only net-new code.

Approach B (rebuild fresh from scratch) was rejected: same end state, more
churn, no benefit — the reverted code is sound.

## Architecture

### Part 1 — Restore (revert the revert `0fa28f5`)

Brings back, unchanged from `1b04a44`:

- `server/auth/spacecat-s2s.ts`: extracts `exchangeAccessTokenForSession()` —
  an uncached `POST <base>/auth/login {accessToken}` + tolerant parse;
  `getUserLoginSessionToken` layers its cache on top.
- `server/spacecat-login.ts`: `handleSpacecatLoginRequest(request, env)` —
  reads `{ accessToken }`, strips a stray leading `Bearer `, calls
  `exchangeAccessTokenForSession`, returns `{ sessionToken, expiresAt }`.
  Per-request; never logs or persists either token. 502 on upstream rejection.
- `api/spacecat-login.ts`: Vercel stub with CORS/OPTIONS via `server/api-cors`.
- `vite.config.ts`: dev middleware route for `POST /api/spacecat-login`.
- `src/.../api.ts`: `exchangeImsAccessToken({ imsAccessToken })` client →
  `{ sessionToken, expiresAt? }`.
- `src/.../constants.ts`: `SPACECAT_LOGIN_API_PATH = '/api/spacecat-login'`.
- `src/.../useOffSiteDashboard.ts`: `imsAccessToken` state, `imsLoginState`
  machine (`idle | exchanging | success | error`), `loginWithImsToken()`
  action (on success sets `userToken`).
- `src/.../OffSiteDashboard.tsx` + `styles.css`: IMS-token input + Exchange
  button + status pill in the managed-connection panel of Workspace Setup.

### Part 2 — Session persistence (net-new code)

**`constants.ts`**
- `SESSION_TOKEN_STORAGE_KEY = 'off-site-dashboard.session.v1'`

**`storage.ts`** — three new functions, following the existing
`hasWindow()` / try-catch / `console.warn` pattern:
- `loadPersistedSession(): { token: string; expiresAt: number } | null`
  — reads the key; returns `null` if missing, malformed, or already past
  `expiresAt` (with a small refresh buffer, e.g. 60s).
- `savePersistedSession(session: { token: string; expiresAt: number }): void`
- `clearPersistedSession(): void`

**`types.ts`** — a `PersistedSession` interface for the stored shape.

**`useOffSiteDashboard.ts`**
- On mount: initialize `userToken` from `loadPersistedSession()` (lazy
  `useState` initializer or a mount effect).
- On `loginWithImsToken` success: compute `expiresAt` from the server's
  `expiresAt`; if absent, decode the session JWT's `exp` client-side (a small
  `readJwtExpiryMs` helper mirroring the server's). Then `savePersistedSession`.
- **Manual-paste parity:** when `setUserToken` is called with a non-empty token
  (manual paste path), decode its `exp` and persist it the same way; clearing
  the field clears the persisted session.
- **Cross-tab sync:** a `window` `storage` event listener on
  `SESSION_TOKEN_STORAGE_KEY` so logging in on one tab live-updates `userToken`
  in others (and logout propagates).
- **Logout:** a `logout()` action that calls `clearPersistedSession()`, clears
  `userToken` and `imsAccessToken`, and resets `imsLoginState` to `idle`.
- **Expiry on load:** if `loadPersistedSession()` returns `null` because the
  stored session is past expiry, leave `userToken` empty and let the existing
  "paste your session token" UI prompt the user; surface a gentle "session
  expired — paste a fresh IMS token" hint.

## Data Flow

```
Paste IMS token → loginWithImsToken()
  → POST /api/spacecat-login { accessToken }
  → server exchangeAccessTokenForSession → POST <base>/auth/login { accessToken }
  → { sessionToken, expiresAt }
  → setUserToken(sessionToken) + savePersistedSession({ token, expiresAt })
  → userToken flows to all 5 workspaces (existing) as x-client-token
  → other browser tabs pick it up via the `storage` event

Reload / new tab → loadPersistedSession() → unexpired? hydrate userToken : prompt re-paste
Expiry          → next load returns null → prompt re-paste IMS token
```

## Error Handling

- Exchange failure (bad/expired IMS token, upstream 4xx/5xx): server returns
  502 with the SpaceCat detail; the client surfaces it in `imsLoginState`'s
  error pill (already in restored code).
- Corrupt or unparseable `localStorage` value: treated as "no session"
  (`null`), logged via `console.warn`, never throws.
- Missing/invalid JWT `exp`: fall back to a conservative TTL (mirror the
  server's `SESSION_TTL_MS`) so a token without a decodable exp still persists
  but is treated as short-lived.

## Security Tradeoff (deliberate)

This departs from CLAUDE.md's "the API key is intentionally never persisted to
localStorage" stance. A session token in `localStorage` is readable by any XSS
on the origin. Accepted by the user for the 24h-across-tabs UX, mitigated by:
- Persisting **only** the short-lived SpaceCat session token — never the IMS
  access token, never the legacy API key.
- A versioned key so the shape can be invalidated later.
- Updating CLAUDE.md to document this as an explicit, scoped exception.

## Testing

- `server/auth/spacecat-s2s.test.ts` already covers
  `exchangeAccessTokenForSession` / `getUserLoginSessionToken` (restored by the
  revert).
- Add unit coverage for `loadPersistedSession` expiry logic (unexpired →
  returns session; past `expiresAt` → returns `null`; malformed → `null`).
- `npm run build` (tsc strict + Vite) must pass — the project's only gate.
- Manual verification: paste IMS token → exchange succeeds → reload keeps you
  logged in → open a second browser tab and confirm it is already logged in →
  logout clears both tabs.

## Out of Scope

- Full hands-off S2S minting from `IMS_SP_*` (separate, entitlement-gated work).
- Auto re-exchange using a retained IMS token (explicitly rejected:
  "session token only").
- The multi-tenant `{baseURL}` per-site session scoping gotcha in CLAUDE.md.
