// Tenant setup: use a Management worker token (pasted once, never stored) to
// find or create the OAuth app the lab's interactive sign-in needs, register
// this lab's callback on it, and hand back the values for a saved connection.
//
// What the hosted PingOne MCP actually needs (from the family's measurements,
// demo_api_server/services/mcpPingOneHttpAdapter.js): an authorization-code +
// PKCE token minted in the SAME environment the endpoint serves; roles ride on
// the signed-in user, not the app. So the app is a plain public OAuth client:
// AUTHORIZATION_CODE + REFRESH_TOKEN, tokenEndpointAuthMethod NONE, PKCE
// S256_REQUIRED, response type CODE. No roles on the app, no secret.
import { liveRefusal } from './config.js';
import { permit } from './netguard.js';

const APP_NAME = 'MFA Admin MCP LAB (sign-in)';
const CALLBACK = '/api/oauth/callback';

const j = (r) => r.json().then((b) => ({ status: r.status, b }), () => ({ status: r.status, b: null }));

// The writable subset for a full PUT of an existing app (the API refuses to
// nullify fields like refreshTokenDuration, so PUT-backs carry the GET's own
// writable scalars and only replace redirectUris).
const writable = (app) => {
  const skip = new Set(['id', 'environment', '_links', 'createdAt', 'updatedAt', 'grantTypes', 'responseTypes', 'postLogoutRedirectUris', 'oidcOptions', 'redirectUris', 'testClient', 'samlOptions', 'wsFedOptions', 'populations', 'billablePopulations']);
  const out = {};
  for (const [k, v] of Object.entries(app)) if (!skip.has(k)) out[k] = v;
  return out;
};

const bare = (u) => (typeof u === 'string' ? u : u?.url);

const withPermit = async (host, fn) => { const r = permit(host); try { return await fn(); } finally { r(); } };

export function setupRouter(app, { fetchImpl = fetch, env = process.env } = {}) {
  const refused = liveRefusal(env);
  // Read-only: check what setup would find/create. No credential handling.
  app.post('/api/setup/check', async (req, res) => {
    const region = String(req.body?.region || 'com').toLowerCase().replace(/[^a-z]/g, '');
    const envId = String(req.body?.envId || '');
    if (!/^[0-9a-f-]{36}$/.test(envId)) return res.status(400).json({ error: 'bad_request', message: 'envId must be a PingOne environment id (a UUID)' });
    const api = `https://api.pingone.${region}/v1/environments/${envId}`;
    let env;
    try { env = await withPermit(`api.pingone.${region}`, async () => j(await fetchImpl(api, { signal: AbortSignal.timeout(10_000) }))); } catch { env = { status: 0, b: null }; }
    if (env.status !== 200) return res.json({ ok: false, stage: 'environment', message: env.status === 404 ? 'No such environment (or the region is wrong).' : `The environment endpoint answered ${env.status}. Check the region and the id.` });
    const name = env.b?.name || 'the environment';
    // The callback this lab will demand, on the browser's own origin:
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',').pop().trim();
    const port = host.split(':').pop();
    return res.json({ ok: true, environment: name, region, envId, callback: `http://localhost:${port}${CALLBACK}` });
  });

  app.post('/api/setup/apply', async (req, res) => {
    if (refused) return res.status(403).json({ error: 'live_refused', message: `Live is refused: ${refused.failed.join(', ')}.`, failed: refused.failed });
    const region = String(req.body?.region || 'com').toLowerCase().replace(/[^a-z]/g, '');
    const envId = String(req.body?.envId || '');
    const workerId = String(req.body?.workerClientId || '');
    const workerSecret = String(req.body?.workerClientSecret || '');
    if (!/^[0-9a-f-]{36}$/.test(envId)) return res.status(400).json({ error: 'bad_request', message: 'envId must be a PingOne environment id (a UUID)' });
    if (!workerId || !workerSecret) return res.status(400).json({ error: 'bad_request', message: 'A Management worker client id and secret are required (the worker needs a role that can read and update applications).' });
    const as = `https://auth.pingone.${region}/${envId}/as`;
    const api = `https://api.pingone.${region}/v1/environments/${envId}`;
    const basic = Buffer.from(`${workerId}:${workerSecret}`).toString('base64');
    let t;
    try {
      t = await withPermit(`auth.pingone.${region}`, async () => j(await fetchImpl(`${as}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10_000) })));
    } catch { t = { status: 0, b: null }; }
    if (t.status !== 200 || !t.b?.access_token) return res.status(401).json({ error: 'worker_refused', message: `The Management worker token was refused (${t.status}). Check the client id and secret, the region and the environment.` });
    const H = { 'content-type': 'application/json', authorization: `Bearer ${t.b.access_token}` };
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',').pop().trim();
    const callback = `http://localhost:${host.split(':').pop()}${CALLBACK}`;
    // Find our app, or any app that already carries the callback:
    let apps;
    try { apps = await withPermit(`api.pingone.${region}`, async () => j(await fetchImpl(`${api}/applications?limit=100`, { headers: H, signal: AbortSignal.timeout(10_000) }))); } catch { apps = { status: 0, b: null }; }
    if (apps.status !== 200) return res.status(502).json({ error: 'api_error', message: `Listing applications failed (${apps.status}). The worker may lack a role that can read applications.` });
    const ours = (apps.b?._embedded?.applications || []).find((a) => a.name === APP_NAME);
    const bearer = (apps.b?._embedded?.applications || []).find((a) => a.type === 'WEB_APP' && (a.redirectUris || []).map(bare).includes(callback));
    let app = ours || bearer;
    let created = false;
    if (!app) {
      const body = { name: APP_NAME, description: 'Interactive sign-in for the MFA Admin MCP LAB (authorization code + PKCE; roles ride on the signed-in user).', enabled: true, type: 'WEB_APP', protocol: 'OPENID_CONNECT', grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN'], responseTypes: ['CODE'], tokenEndpointAuthMethod: 'NONE', pkceEnforcement: 'S256_REQUIRED', redirectUris: [callback] };
      const r = await withPermit(`api.pingone.${region}`, async () => j(await fetchImpl(`${api}/applications`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch(() => ({ status: 0, b: null }))));
      if (r.status !== 201) return res.status(502).json({ error: 'api_error', message: `Creating the sign-in application failed (${r.status}): ${r.b?.details?.map((d) => d.message).join('; ') || r.b?.message || 'unknown'}.` });
      app = r.b; created = true;
    } else if (!(app.redirectUris || []).map(bare).includes(callback)) {
      // Register the callback on the existing app: GET, merge, full PUT of the writable subset.
      const uris = (app.redirectUris || []).map(bare).concat(callback);
      const r = await withPermit(`api.pingone.${region}`, async () => j(await fetchImpl(`${api}/applications/${app.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ ...writable(app), redirectUris: uris }), signal: AbortSignal.timeout(10_000) }).catch(() => ({ status: 0, b: null }))));
      if (r.status !== 200) return res.status(502).json({ error: 'api_error', message: `Adding the callback to "${app.name}" failed (${r.status}): ${r.b?.details?.map((d) => d.message).join('; ') || r.b?.message || 'unknown'}.` });
      app = r.b;
    }
    return res.json({
      ok: true, created, appName: app.name, clientId: app.id, callback,
      connection: { kind: 'pingone', region, envId, auth: 'interactive', clientId: app.id, redirectUri: callback, label: 'PingOne hosted MCP (set up)' },
    });
  });
}
