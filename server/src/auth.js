// Auth for PingOne connections. Tokens (access, refresh, id) and the client secret live server-side only and are never
// returned, logged or audited. Two models (pingone-mcp skill):
//  worker:      client_credentials at the token endpoint; Basic or the secret in the body is used ONLY there.
//  interactive: authorization code + PKCE S256 + state + nonce; iss validated; id_token signature checked against the
//               AS jwks; single-use state with a short TTL; callback accepted only on the exact registered redirect URI.
// Token-endpoint shape and the refresh grant follow AI-DEMO2 services/pingoneMcpTokenService.js and
// routes/mcpPingOneAdminAuth.js. Scopes ('openid offline_access') are copied from the latter; their effect on a
// live tenant is UNVERIFIED by us.
import crypto from 'node:crypto';
import { scrub } from './redact.js';
import { asBase } from './urls.js';

const MARGIN_MS = 60_000;
const STATE_TTL_MS = 5 * 60_000;
const b64u = (b) => Buffer.from(b).toString('base64url');
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const SIGNATURE_ALGS = {
  RS256: { digest: 'RSA-SHA256' }, RS384: { digest: 'RSA-SHA384' }, RS512: { digest: 'RSA-SHA512' },
  ES256: { digest: 'SHA256', ec: true }, ES384: { digest: 'SHA384', ec: true }, ES512: { digest: 'SHA512', ec: true },
};
export function authError(code, message) { return Object.assign(new Error(message), { code }); }

function decodeJwt(t) {
  const [h, p, s] = String(t).split('.');
  if (!s) throw authError('bad_id_token', 'id_token is not a JWT');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')), signed: `${h}.${p}`, sig: Buffer.from(s, 'base64url') };
}

export function createAuth({ resolveBase, fetchImpl = fetch, now = Date.now, stateTtlMs = STATE_TTL_MS }) {
  // resolveBase(conn) -> { asBase } (offline connections point at the in-process mock).
  const tokens = new Map();   // connId -> { accessToken, refreshToken, expiresAt, sub }
  const pending = new Map();  // state -> { connId, verifier, nonce, redirectUri, at }

  const baseOf = (conn) => asBase({ region: conn.region, envId: conn.envId, offlineBase: resolveBase(conn), idp: conn.idp, idpBaseUrl: conn.idpBaseUrl });

  async function tokenRequest(conn, params, { basic, idp } = {}) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const body = new URLSearchParams(params);
    if (basic) headers.Authorization = `Basic ${Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64')}`;
    let res;
    try { res = await fetchImpl(ep({ ...conn, ...(idp ? { idp } : {}) }, 'token'), { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
    catch (e) { throw authError('token_endpoint_unreachable', `token endpoint unreachable (${e?.cause?.code || e?.code || 'network error'})`); }
    let json = null;
    try { json = JSON.parse((await res.text()).slice(0, 100_000)); } catch { /* not JSON */ }
    if (!res.ok || !json?.access_token) {
      const detail = scrub([json?.error, json?.error_description].filter((x) => typeof x === 'string').join(': ').slice(0, 200), [conn.clientSecret]);
      throw authError('token_request_failed', `token endpoint answered ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    return json;
  }

  function remember(conn, json, prev) {
    const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
    const rec = { accessToken: json.access_token, refreshToken: json.refresh_token || prev?.refreshToken || null, expiresAt: now() + ttl * 1000, sub: prev?.sub || null };
    tokens.set(conn.id, rec);
    return rec;
  }

  async function mintWorker(conn) {
    const params = { grant_type: 'client_credentials' };
    if (conn.tokenAuthMethod === 'post') { params.client_id = conn.clientId; params.client_secret = conn.clientSecret; }
    return remember(conn, await tokenRequest(conn, params, { basic: conn.tokenAuthMethod !== 'post' }));
  }

  async function refresh(conn) {
    const t = tokens.get(conn.id);
    if (!t?.refreshToken) return false;
    try { remember(conn, await tokenRequest(conn, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: conn.clientId }), t); return true; }
    catch { tokens.delete(conn.id); return false; }
  }

  async function accessToken(conn) {
    let t = tokens.get(conn.id);
    if (conn.auth === 'worker') {
      if (!t || t.expiresAt - MARGIN_MS <= now()) t = await mintWorker(conn);
      return t.accessToken;
    }
    if (t && t.expiresAt - MARGIN_MS <= now()) { await refresh(conn); t = tokens.get(conn.id); }
    if (!t || t.expiresAt <= now()) throw authError('login_required', 'not signed in: use Sign in on this connection');
    return t.accessToken;
  }

  // Called after a 401: true when a fresh token is ready.
  async function renew(conn) {
    if (conn.auth === 'worker') { tokens.delete(conn.id); await mintWorker(conn); return true; }
    return refresh(conn);
  }

  function status(conn) {
    const t = tokens.get(conn.id);
    if (conn.kind !== 'pingone') return { signedIn: false };
    if (conn.auth === 'worker') return t && t.expiresAt > now() ? { token: 'set', expiresAt: t.expiresAt } : { token: null };
    return t && t.expiresAt > now() ? { signedIn: true, as: t.sub || 'unknown', expiresAt: t.expiresAt } : { signedIn: false };
  }
  const secretsOf = (conn) => { const t = tokens.get(conn.id); return t ? [t.accessToken, t.refreshToken].filter(Boolean) : []; };
  const allSecrets = () => [...tokens.values()].flatMap((t) => [t.accessToken, t.refreshToken].filter(Boolean));

  // Per-IdP endpoint paths after the base. PingOne: /as/{authorize,token,jwks}.
  // PingFederate: /as/authorization.oauth2, /as/token.oauth2, /pf/JWKS.
  const ep = (conn, what) => {
    const b = baseOf(conn);
    if (conn.idp === 'pf') return { authorize: `${b}/authorization.oauth2`, token: `${b}/token.oauth2`, jwks: `${b.replace(/\/as$/, '')}/pf/JWKS` }[what];
    return { authorize: `${b}/authorize`, token: `${b}/token`, jwks: `${b}/jwks` }[what];
  };

  function startLogin(conn, { idp, returnTo = '/' } = {}) {
    if (conn.kind !== 'pingone' || conn.auth !== 'interactive') throw authError('not_interactive', 'this connection does not use interactive sign-in');
    const authorizeEndpoint = ep({ ...conn, idp: idp === 'pf' ? 'pf' : conn.idp }, 'authorize'); // throws pf_not_configured before any state exists
    for (const [s, p] of pending) if (now() - p.at > stateTtlMs) pending.delete(s);
    const state = b64u(crypto.randomBytes(24)); const nonce = b64u(crypto.randomBytes(24)); const verifier = b64u(crypto.randomBytes(48));
    pending.set(state, { connId: conn.id, verifier, nonce, redirectUri: conn.redirectUri, returnTo, at: now(), idp: idp === 'pf' ? 'pf' : (conn.idp || 'pingone') });
    const q = new URLSearchParams({ response_type: 'code', client_id: conn.clientId, redirect_uri: conn.redirectUri, scope: 'openid offline_access', state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' });
    return { authorizeUrl: `${authorizeEndpoint}?${q}`, state };
  }

  // ---- pi.flow sign-in (redirect-free; the password step stays in this lab's own modal) ----
  // The ceremony is the same as the redirect: authorization code + PKCE S256 + state + nonce, code-for-tokens at the
  // same token endpoint, the id_token checked the same way. The difference is response_mode=pi.flow: the authorize
  // request answers with a JSON flow instead of a redirect, the modal posts the password to it, and the finished flow
  // hands back the code here (PingOne via /as/resume, PingFederate inline on COMPLETED). No redirect is ever followed
  // or served. The password is a request body field used once in the flow call and kept nowhere.
  const PI_FLOW_TIMEOUT_MS = 10_000;
  const PF = { stepPath: (id) => `/pf-ws/authn/flows/${id}`, pwType: 'application/vnd.pingidentity.checkUsernamePassword+json', badCredentials: 'CREDENTIAL_VALIDATION_FAILED', csrf: 'PingFederate' };
  const P1 = { stepPath: (id) => `/flows/${id}`, pwType: 'application/vnd.pingidentity.usernamePassword.check+json', badCredentials: 'INVALID_CREDENTIALS', csrf: null };
  const FLOW_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  const piFlows = new Map(); // state -> { connId, flowId, verifier, nonce, redirectUri, returnTo, at, idp, cookies }
  const piCfg = (idp) => (idp === 'pf' ? PF : P1);
  const mergeCookies = (jar, res) => { for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(';'); const i = pair.indexOf('='); if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1)); } return jar; };
  const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const scrubTyped = (password, v) => (typeof password === 'string' && password.length >= 4 ? JSON.parse(JSON.stringify(v).split(JSON.stringify(password).slice(1, -1)).join('[the password]')) : v);

  // Opens the flow (GET authorize with response_mode=pi.flow) and parks it. Returns { state, usernameHint }.
  function startPiFlowLogin(conn, { idp, returnTo = '/' } = {}) {
    if (conn.kind !== 'pingone' || conn.auth !== 'interactive') throw authError('not_interactive', 'this connection does not use interactive sign-in');
    const eff = { ...conn, idp: idp === 'pf' ? 'pf' : conn.idp };
    const authorizeEndpoint = ep(eff, 'authorize'); // throws pf_not_configured before any state exists
    for (const [s, p] of piFlows) if (now() - p.at > stateTtlMs) piFlows.delete(s);
    const state = b64u(crypto.randomBytes(24)); const nonce = b64u(crypto.randomBytes(24)); const verifier = b64u(crypto.randomBytes(48));
    const q = new URLSearchParams({ response_type: 'code', client_id: conn.clientId, redirect_uri: conn.redirectUri, scope: 'openid offline_access', state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', response_mode: 'pi.flow' });
    const url = `${authorizeEndpoint}?${q}`;
    return { state, url, async open() {
      let res;
      try { res = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(PI_FLOW_TIMEOUT_MS) }); }
      catch (e) { throw authError('pi_flow_unreachable', `the authorization server did not answer (${e?.cause?.code || e?.code || 'network error'})`); }
      const jar = mergeCookies(new Map(), res);
      let flow = null; try { flow = JSON.parse((await res.text()).slice(0, 100_000)); } catch { /* not JSON */ }
      if (res.status !== 200 || !FLOW_ID_RE.test(String(flow?.id || ''))) throw authError('pi_flow_unavailable', `the authorization server refused to open a sign-in flow (HTTP ${res.status}${flow?.error ? `: ${scrub(String(flow.error), [conn.clientSecret])}` : ''})`);
      if (flow.status !== 'USERNAME_PASSWORD_REQUIRED' && flow.status !== 'COMPLETED') throw authError('pi_flow_step_unsupported', `the sign-on policy asks for a step this lab does not drive (only username and password) — got ${scrub(String(flow.status).slice(0, 40))}`);
      piFlows.set(state, { connId: conn.id, flowId: String(flow.id), verifier, nonce, redirectUri: conn.redirectUri, returnTo, at: now(), idp: eff.idp, cookies: jar });
      return { flowId: flow.id, status: flow.status, state };
    } };
  }

  // Posts the password to the parked flow and, on COMPLETED, finishes the sign-in exactly like the redirect
  // callback does (code for tokens, id_token verified). Resolves to completeLogin's result.
  async function piFlowCredentials(conn, { state, username, password }) {
    const p = piFlows.get(state);
    if (!p) throw authError('bad_state', 'unknown or expired sign-in flow; start again');
    piFlows.delete(state);
    if (now() - p.at > stateTtlMs) throw authError('state_expired', 'sign-in took too long; start again');
    if (typeof username !== 'string' || !username || username.length > 200) throw authError('bad_username', 'type the username (1 to 200 characters)');
    if (typeof password !== 'string' || !password || password.length > 256) throw authError('bad_password', 'type the password (1 to 256 characters)');
    const cfg = piCfg(p.idp);
    const step = async () => {
      const headers = { 'Content-Type': cfg.pwType, Accept: 'application/json', Cookie: cookieHeader(p.cookies), ...(cfg.csrf ? { 'X-XSRF-Header': cfg.csrf } : {}) };
      let res;
      try { res = await fetchImpl(`${baseOf({ ...conn, idp: p.idp }).replace(/\/as$/, '')}${cfg.stepPath(p.flowId)}`, { method: 'POST', headers, body: JSON.stringify({ username: username, password }), redirect: 'manual', signal: AbortSignal.timeout(PI_FLOW_TIMEOUT_MS) }); }
      catch (e) { throw authError('pi_flow_unreachable', `the authorization server did not answer (${e?.cause?.code || e?.code || 'network error'})`); }
      mergeCookies(p.cookies, res);
      let body = null; try { body = JSON.parse((await res.text()).slice(0, 100_000)); } catch { /* not JSON */ }
      return { res, body };
    };
    let r;
    try { r = await step(); } finally { /* state consumed either way */ }
    if (r.res.status === 400 || r.res.status === 401) {
      const code = r.body?.details?.[0]?.code || r.body?.code || '';
      if (code === cfg.badCredentials || code === 'VALIDATION_ERROR') throw authError('invalid_credentials', 'username or password is incorrect');
      throw authError('pi_flow_refused', `the sign-in step failed (HTTP ${r.res.status}${code ? `: ${scrub(String(code).slice(0, 60))}` : ''})`);
    }
    if (r.res.status !== 200 || !r.body) throw authError('pi_flow_refused', `the sign-in step failed (HTTP ${r.res.status})`);
    if (r.body.status !== 'COMPLETED') throw authError('pi_flow_step_unsupported', `the sign-on policy asks for a step after the password that this lab does not drive (for example MFA) — got ${scrub(String(r.body.status).slice(0, 40))}`);
    // The code: inline on COMPLETED (PingFederate always; PingOne when the policy finishes without a resume hop),
    // otherwise /as/resume with the flow's cookies.
    let code = typeof r.body.authorizeResponse?.code === 'string' ? r.body.authorizeResponse.code : '';
    const gotState = r.body.authorizeResponse?.state;
    if (code && gotState !== undefined && gotState !== state) throw authError('bad_state', 'the flow came back for a different sign-in request; the lab refuses it');
    if (!code && p.idp !== 'pf') {
      let res;
      try { res = await fetchImpl(`${baseOf({ ...conn, idp: p.idp })}/resume?flowId=${encodeURIComponent(p.flowId)}`, { headers: { Accept: 'application/json', Cookie: cookieHeader(p.cookies) }, redirect: 'manual', signal: AbortSignal.timeout(PI_FLOW_TIMEOUT_MS) }); }
      catch (e) { throw authError('pi_flow_unreachable', `the authorization server did not answer (${e?.cause?.code || e?.code || 'network error'})`); }
      let body = null; try { body = JSON.parse((await res.text()).slice(0, 100_000)); } catch { /* not JSON */ }
      code = typeof body?.authorizeResponse?.code === 'string' ? body.authorizeResponse.code : '';
      if (res.status !== 200 || !code) throw authError('pi_flow_refused', `the flow did not hand back an authorization code (HTTP ${res.status})`);
    }
    if (!code) throw authError('pi_flow_refused', 'the flow completed without an authorization code');
    const json = await tokenRequest(conn, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: conn.clientId, code_verifier: p.verifier }, { idp: p.idp });
    if (!json.id_token) throw authError('bad_id_token', 'no id_token returned, so the nonce cannot be checked');
    const claims = await verifyIdToken(conn, json.id_token, p.nonce, { idp: p.idp });
    const rec = remember(conn, json); rec.sub = String(claims.sub || '').slice(0, 80) || null;
    return { connId: conn.id, sub: rec.sub, returnTo: p.returnTo };
  }

  async function verifyIdToken(conn, idToken, nonce, { idp } = {}) {
    const { header, claims, signed, sig } = decodeJwt(idToken);
    const eff = { ...conn, ...(idp ? { idp } : {}) };
    let jwks;
    try { jwks = await (await fetchImpl(ep(eff, 'jwks'), { redirect: 'manual', signal: AbortSignal.timeout(15_000) })).json(); }
    catch { throw authError('jwks_unavailable', 'could not fetch the signing keys'); }
    const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
    // PingOne issues RS256; PingFederate can issue RS or ES. A JWS ES* signature is the raw r||s pair (IEEE P1363), not the DER form Node
    // expects by default, so EC algorithms must say so or no genuine token would ever verify. Anything else, including "none", is refused.
    if (!jwk) throw authError('bad_id_token', 'id_token has no matching key in the JWKS');
    const alg = SIGNATURE_ALGS[header.alg];
    if (!alg) throw authError('bad_id_token', `id_token algorithm ${JSON.stringify(String(header.alg).slice(0, 12))} is not supported`);
    let ok = false;
    try { ok = crypto.createVerify(alg.digest).update(signed).verify({ key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), ...(alg.ec ? { dsaEncoding: 'ieee-p1363' } : {}) }, sig); } catch { ok = false; } // a malformed signature or key throws; it is a refusal, not a crash
    if (!ok) throw authError('bad_id_token', 'id_token signature does not verify');
    if (claims.iss !== baseOf(eff)) throw authError('iss_mismatch', 'id_token issuer is not this environment');
    if (![].concat(claims.aud).includes(conn.clientId)) throw authError('aud_mismatch', 'id_token audience is not this client');
    if (!(claims.exp * 1000 > now())) throw authError('bad_id_token', 'id_token expired');
    if (claims.nonce !== nonce) throw authError('nonce_mismatch', 'id_token nonce does not match');
    return claims;
  }

  // q: callback query; at: the exact URL (origin+path) the callback arrived on. conn lookup by the stored state.
  async function completeLogin({ q, at, getConn }) {
    const p = pending.get(q.state);
    pending.delete(q.state); // single use, success or not
    if (!p) throw authError('bad_state', 'unknown or already used state');
    if (now() - p.at > stateTtlMs) throw authError('state_expired', 'sign-in took too long; start again');
    if (at !== p.redirectUri) throw authError('redirect_mismatch', 'callback did not arrive on the registered redirect URI');
    const conn = getConn(p.connId);
    if (!conn) throw authError('no_connection', 'connection no longer exists');
    if (q.error) throw authError('authorization_denied', `authorization server answered: ${scrub(String(q.error).slice(0, 60))}`);
    if (q.iss !== undefined && q.iss !== baseOf({ ...conn, idp: p.idp })) throw authError('iss_mismatch', 'issuer in the callback is not this environment');
    if (!q.code) throw authError('no_code', 'callback carried no code');
    const json = await tokenRequest(conn, { grant_type: 'authorization_code', code: String(q.code), redirect_uri: p.redirectUri, client_id: conn.clientId, code_verifier: p.verifier }, { idp: p.idp });
    if (!json.id_token) throw authError('bad_id_token', 'no id_token returned, so the nonce cannot be checked');
    const claims = await verifyIdToken(conn, json.id_token, p.nonce, { idp: p.idp });
    const rec = remember(conn, json); rec.sub = String(claims.sub || '').slice(0, 80) || null;
    return { connId: conn.id, sub: rec.sub };
  }

  const logout = (conn) => { tokens.delete(conn.id); };
  // Reset: every token and every half-finished sign-in is dropped; the saved connections stay.
  const resetAll = () => { tokens.clear(); pending.clear(); };
  const pendingConnId = (state) => pending.get(state)?.connId ?? null;
  const pendingReturnTo = (state) => pending.get(state)?.returnTo ?? '/';
  return { accessToken, renew, status, secretsOf, allSecrets, startLogin, completeLogin, logout, resetAll, pendingConnId, pendingReturnTo, _pending: pending, startPiFlowLogin, piFlowCredentials, _piFlows: piFlows };
}
