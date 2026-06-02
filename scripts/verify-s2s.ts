// One-shot live check: IMS token -> session token -> GET /sites.
// Run: npm run verify:s2s   (reads .env via --env-file)
import {
  getImsAccessToken,
  getSessionToken,
  getSpacecatAuthHeaders,
  isS2SConfigured,
} from '../server/auth/spacecat-s2s.js';

const env = process.env;

async function main() {
  if (!isS2SConfigured(env)) {
    throw new Error('S2S not configured: set IMS_SP_CLIENT_ID and IMS_SP_CLIENT_SECRET in .env');
  }
  const base = (env.SPACECAT_API_BASE_URL?.trim() || 'https://llmo.experiencecloud.live/api/v1').replace(/\/+$/, '');

  const ims = await getImsAccessToken(env);
  console.log('IMS token OK:', `${ims.slice(0, 12)}...`);

  const session = await getSessionToken(env);
  console.log('Session token OK:', `${session.slice(0, 12)}...`);

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
