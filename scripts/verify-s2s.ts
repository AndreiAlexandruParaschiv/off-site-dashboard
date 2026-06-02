// One-shot live check of SpaceCat auth, mirroring what the proxy does.
// - If SPACECAT_SESSION_TOKEN is set, it is used directly (S2S minting skipped).
// - Otherwise the full S2S flow runs: IMS token -> session token.
// Then it calls GET /sites with the resolved auth header.
// Run: npm run verify:s2s   (reads .env via --env-file)
import {
  getImsAccessToken,
  getSessionToken,
  getSpacecatAuthHeaders,
  hasManagedAuth,
} from '../server/auth/spacecat-s2s.js';

const env = process.env;

async function main() {
  if (!hasManagedAuth(env)) {
    throw new Error(
      'No managed auth configured: set SPACECAT_SESSION_TOKEN, or IMS_SP_CLIENT_ID + IMS_SP_CLIENT_SECRET, in .env',
    );
  }
  const base = (
    env.SPACECAT_API_BASE_URL?.trim() || 'https://llmo.experiencecloud.live/api/v1'
  ).replace(/\/+$/, '');

  if (env.SPACECAT_SESSION_TOKEN?.trim()) {
    console.log('Using provided SPACECAT_SESSION_TOKEN (S2S minting skipped).');
  } else {
    const ims = await getImsAccessToken(env);
    console.log('IMS token OK:', `${ims.slice(0, 12)}...`);
    const session = await getSessionToken(env);
    console.log('Session token OK:', `${session.slice(0, 12)}...`);
  }

  const headers = await getSpacecatAuthHeaders(env);
  const res = await fetch(`${base}/sites`, { headers: { accept: 'application/json', ...headers } });
  console.log('GET /sites:', res.status, res.statusText);
  const text = await res.text();
  console.log('Body (first 300 chars):', text.slice(0, 300));
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('verify-s2s failed:', err);
  process.exitCode = 1;
});
