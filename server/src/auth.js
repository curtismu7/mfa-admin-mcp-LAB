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

  const baseOf = (conn) => asBase({ region: conn.region, envId: conn.envId, offlineBase: resolveBase(conn) });

  async function tokenRequest(conn, params, { basic } = {}) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const body = new URLSearchParams(params);
    if (basic) headers.Authorization = `Basic ${Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64')}`;
    let res;
    try { res = await fetchImpl(`${baseOf(conn)}/token`, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
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

  function startLogin(conn) {
    if (conn.kind !== 'pingone' || conn.auth !== 'interactive') throw authError('not_interactive', 'this connection does not use interactive sign-in');
    for (const [s, p] of pending) if (now() - p.at > stateTtlMs) pending.delete(s);
    const state = b64u(crypto.randomBytes(24)); const nonce = b64u(crypto.randomBytes(24)); const verifier = b64u(crypto.randomBytes(48));
    pending.set(state, { connId: conn.id, verifier, nonce, redirectUri: conn.redirectUri, at: now() });
    const q = new URLSearchParams({ response_type: 'code', client_id: conn.clientId, redirect_uri: conn.redirectUri, scope: 'openid offline_access', state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' });
    return { authorizeUrl: `${baseOf(conn)}/authorize?${q}`, state };
  }

  async function verifyIdToken(conn, idToken, nonce) {
    const { header, claims, signed, sig } = decodeJwt(idToken);
    let jwks;
    try { jwks = await (await fetchImpl(`${baseOf(conn)}/jwks`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })).json(); }
    catch { throw authError('jwks_unavailable', 'could not fetch the signing keys'); }
    const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
    if (header.alg !== 'RS256' || !jwk) throw authError('bad_id_token', 'id_token is not RS256 or has no matching key');
    const ok = crypto.createVerify('RSA-SHA256').update(signed).verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), sig);
    if (!ok) throw authError('bad_id_token', 'id_token signature does not verify');
    if (claims.iss !== baseOf(conn)) throw authError('iss_mismatch', 'id_token issuer is not this environment');
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
    if (q.iss !== undefined && q.iss !== baseOf(conn)) throw authError('iss_mismatch', 'issuer in the callback is not this environment');
    if (!q.code) throw authError('no_code', 'callback carried no code');
    const json = await tokenRequest(conn, { grant_type: 'authorization_code', code: String(q.code), redirect_uri: p.redirectUri, client_id: conn.clientId, code_verifier: p.verifier });
    if (!json.id_token) throw authError('bad_id_token', 'no id_token returned, so the nonce cannot be checked');
    const claims = await verifyIdToken(conn, json.id_token, p.nonce);
    const rec = remember(conn, json); rec.sub = String(claims.sub || '').slice(0, 80) || null;
    return { connId: conn.id, sub: rec.sub };
  }

  const logout = (conn) => { tokens.delete(conn.id); };
  // Reset: every token and every half-finished sign-in is dropped; the saved connections stay.
  const resetAll = () => { tokens.clear(); pending.clear(); };
  const pendingConnId = (state) => pending.get(state)?.connId ?? null;
  return { accessToken, renew, status, secretsOf, allSecrets, startLogin, completeLogin, logout, resetAll, pendingConnId, _pending: pending };
}
