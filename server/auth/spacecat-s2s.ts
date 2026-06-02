// Shared Adobe IMS Server-to-Service (S2S) auth for SpaceCat.
//
// Flow: client_credentials -> IMS access token (24h) -> SpaceCat session
// token (15m) -> Authorization: Bearer <session token> on API calls.
// The client_secret stays server-side and is never sent to the browser.

export type SpacecatS2SEnv = {
  IMS_ENDPOINT?: string;
  IMS_SP_CLIENT_ID?: string;
  IMS_SP_CLIENT_SECRET?: string;
  IMS_SP_ORG_ID?: string;
  IMS_SP_SCOPE?: string;
  IMS_SP_RESOURCE?: string;
  SPACECAT_S2S_LOGIN_URL?: string;
  SPACECAT_API_BASE_URL?: string;
};

/** True when `now` is before the token's expiry minus the safety buffer. */
export function isTokenFresh(
  expiresAt: number | null,
  bufferMs: number,
  now: number,
): boolean {
  return expiresAt !== null && now < expiresAt - bufferMs;
}
