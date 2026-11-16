// Auth for PingOne connections. Tokens (access, refresh, id) live server-side only and are never returned, logged or audited.
// One model: the hosted PingOne MCP server takes a USER sign-in (owner statement 2026-11-15; Ping's early-access MCP docs describe only
// an administrator signing in, the tools depending on that user's admin roles). No worker (client_credentials) path exists.
//  PingOne native flow (response_mode=pi.flow, rule 16): no redirect, no callback. This server opens the flow
//  (authorization code + PKCE S256 + nonce), keeps the flow id and its session cookies, and drives the steps
//  the browser's own form supplies (password, one-time code, device choice). The code is redeemed at the
//  token endpoint as a PUBLIC client (no secret); iss validated; id_token signature checked against the AS jwks.
//  The password and one-time code pass through to the authorization server and are never stored or logged.
//  For PingOne the authorize, code and refresh requests carry resource=<the connection's MCP URL> (RFC 8707): the MCP server's
//  protected-resource metadata names that URL as its resource. PingFederate sign-in is left as it was (no resource).
// Token-endpoint shape and the refresh grant follow AI-DEMO2 services/pingoneMcpTokenService.js and
// routes/mcpPingOneAdminAuth.js. Scopes ('openid offline_access') are copied from the latter; their effect on a
// live tenant is UNVERIFIED by us.
import crypto from 'node:crypto';
import { scrub } from './redact.js';
import { asBase, mcpUrl } from './urls.js';

const MARGIN_MS = 60_000;
const LOGIN_TTL_MS = 5 * 60_000;
const MAX_LOGINS = 20;
const MAX_ATTEMPTS = 5; // wrong passwords / codes allowed on one sign-in before it must be started again
// pi.flow still names a redirect URI in the authorize and token requests; nothing is served at it (no callback exists).
export const PI_FLOW_REDIRECT_URI = 'http://localhost/mfa-admin-mcp-lab/pi-flow';
const FLOW_ID = /^[A-Za-z0-9_-]{6,64}$/;
// A PingOne connection saved by an older build with auth 'worker': it is kept (and its secret stays write-only on disk) but cannot call.
export const LEGACY_WORKER = 'this connection was saved by an older build for a worker (client_credentials) token, which the hosted PingOne MCP server does not take: it needs a user sign-in. Delete it and add a PingOne connection (Setup creates the sign-in application).';
// What differs between the two authorization servers' native flows. PingOne: /flows/{id}, vendor content types, the code comes
// from /as/resume. PingFederate: /pf-ws/authn/flows/{id}, a CSRF header, the code is in the COMPLETED body.
const PROFILES = {
  pingone: {
    accept: '*/*', badPassword: 'INVALID_CREDENTIALS', badOtp: 'OTP_VALIDATION_FAILED',
    password: 'application/vnd.pingidentity.usernamePassword.check+json', lookup: 'application/vnd.pingidentity.user.lookup+json',
    otp: 'application/vnd.pingidentity.otp.check+json', device: 'application/vnd.pingidentity.device.select+json',
    deviceBody: (id) => ({ device: { id } }),
  },
  pf: {
    accept: 'application/json', badPassword: 'CREDENTIAL_VALIDATION_FAILED', badOtp: 'INVALID_OTP', headers: { 'X-XSRF-Header': 'PingFederate' },
    password: 'application/vnd.pingidentity.checkUsernamePassword+json', otp: 'application/vnd.pingidentity.checkOtp+json',
    device: 'application/vnd.pingidentity.selectDevice+json', deviceBody: (id) => ({ deviceRef: { id } }),
    cont: 'application/vnd.pingidentity.continueAuthentication+json',
  },
};
const PASSWORD_STATES = new Set(['USERNAME_PASSWORD_REQUIRED', 'PASSWORD_REQUIRED', 'SIGN_ON_REQUIRED']);
// PingOne binds a flow to a session-token cookie that changes as the flow advances: keep a name->value jar, merge every Set-Cookie.
const mergeCookies = (jar, res) => {
  const next = { ...jar };
  for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(';'); const i = pair.indexOf('='); if (i > 0) next[pair.slice(0, i).trim()] = pair.slice(i + 1); }
  return next;
};
// An empty jar sends no Cookie header at all (PingOne's authorize answers without setting one, measured 2026-11-15).
const cookieHeaders = (jar) => (Object.keys(jar).length ? { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {});
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

export function createAuth({ resolveBase, fetchImpl = fetch, now = Date.now, loginTtlMs = LOGIN_TTL_MS }) {
  // resolveBase(conn) -> { asBase } (offline connections point at the in-process mock).
  const tokens = new Map();   // connId -> { accessToken, refreshToken, expiresAt, sub }
  const logins = new Map();   // loginId -> { connId, idp, flowId, cookies, status, verifier, nonce, redirectUri, attempts, at }

  const baseOf = (conn) => asBase({ region: conn.region, envId: conn.envId, offlineBase: resolveBase(conn), idp: conn.idp, idpBaseUrl: conn.idpBaseUrl });
  // RFC 8707 resource indicator: the MCP URL this connection calls (the in-process mock's for an offline connection). PingOne only.
  const resourceOf = (conn) => mcpUrl({ region: conn.region, envId: conn.envId, endpointStyle: conn.endpointStyle, offlineBase: resolveBase(conn) });
  const withResource = (conn, idp, params) => (idp === 'pf' ? params : { ...params, resource: resourceOf(conn) });
  // The OAuth client at the authorization server that runs this sign-in: PingFederate may have its own client id on the connection.
  const clientOf = (conn, idp) => (idp === 'pf' && conn.pfClientId) || conn.clientId;
  const refuseLegacy = (conn) => { if (conn.kind === 'pingone' && conn.auth === 'worker') throw authError('worker_unsupported', LEGACY_WORKER); };

  async function tokenRequest(conn, params, { idp } = {}) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const body = new URLSearchParams(params);
    let res;
    try { res = await fetchImpl(ep({ ...conn, ...(idp ? { idp } : {}) }, 'token'), { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
    catch (e) { throw authError('token_endpoint_unreachable', `token endpoint unreachable (${e?.cause?.code || e?.code || 'network error'})`); }
    let json = null;
    try { json = JSON.parse((await res.text()).slice(0, 100_000)); } catch { /* not JSON */ }
    if (!res.ok || !json?.access_token) {
      // What was sent (the code, the PKCE verifier, the refresh token) never comes back in an error, even when the server echoes it.
      const detail = scrub([json?.error, json?.error_description].filter((x) => typeof x === 'string').join(': ').slice(0, 200), [params.code, params.code_verifier, params.refresh_token]);
      const needsPublic = json?.error === 'invalid_client' && params.grant_type === 'authorization_code'
        ? '. The sign-in application must be a public client (token endpoint authentication: None): create one with Setup' : '';
      throw authError('token_request_failed', `token endpoint answered ${res.status}${detail ? ` (${detail})` : ''}${needsPublic}`);
    }
    return json;
  }

  // idp: the authorization server that issued these tokens, so a refresh goes back to it (a PF login on a PingOne-default connection).
  function remember(conn, json, prev, idp = prev?.idp) {
    const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
    const rec = { accessToken: json.access_token, refreshToken: json.refresh_token || prev?.refreshToken || null, expiresAt: now() + ttl * 1000, sub: prev?.sub || null, idp: idp || conn.idp || 'pingone' };
    tokens.set(conn.id, rec);
    return rec;
  }

  async function refresh(conn) {
    const t = tokens.get(conn.id);
    if (!t?.refreshToken) return false;
    const idp = t.idp || conn.idp;
    try { remember(conn, await tokenRequest(conn, withResource(conn, idp, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: clientOf(conn, idp) }), { idp }), t); return true; }
    catch { tokens.delete(conn.id); return false; }
  }

  async function accessToken(conn) {
    refuseLegacy(conn);
    let t = tokens.get(conn.id);
    if (t && t.expiresAt - MARGIN_MS <= now()) { await refresh(conn); t = tokens.get(conn.id); }
    if (!t || t.expiresAt <= now()) throw authError('login_required', 'not signed in: use Sign in on this connection');
    return t.accessToken;
  }

  // Called after a 401: true when a fresh token is ready.
  const renew = (conn) => refresh(conn);

  function status(conn) {
    const t = tokens.get(conn.id);
    if (conn.kind !== 'pingone') return { signedIn: false };
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

  const effIdp = (conn, idp) => (idp === 'pf' ? 'pf' : (conn.idp || 'pingone'));
  const profileOf = (idp) => (idp === 'pf' ? PROFILES.pf : PROFILES.pingone);
  // The flow's own URL. PingOne: <auth host>/<env>/flows/<id>. PingFederate: <origin>/pf-ws/authn/flows/<id>.
  const baseFor = (conn, login) => baseOf({ ...conn, idp: login.idp });
  const flowUrl = (conn, login) => (login.idp === 'pf'
    ? `${new URL(baseFor(conn, login)).origin}/pf-ws/authn/flows/${login.flowId}`
    : `${baseFor(conn, login).replace(/\/as$/, '')}/flows/${login.flowId}`);
  const errDetail = (json, secrets = []) => scrub([json?.error, json?.error_description, json?.code, json?.message, json?.details?.[0]?.message].filter((x) => typeof x === 'string').join(': ').slice(0, 200), secrets);
  const pruneLogins = () => {
    for (const [id, l] of logins) if (now() - l.at > loginTtlMs) logins.delete(id);
    while (logins.size >= MAX_LOGINS) logins.delete(logins.keys().next().value);
  };

  // Opens a native flow at the authorization server and returns the first step for the browser's own form.
  async function startLogin(conn, { idp } = {}) {
    refuseLegacy(conn);
    if (conn.kind !== 'pingone' || conn.auth !== 'interactive') throw authError('not_interactive', 'this connection does not use interactive sign-in');
    const eff = effIdp(conn, idp);
    const authorizeEndpoint = ep({ ...conn, idp: eff }, 'authorize'); // throws pf_not_configured before any state exists
    pruneLogins();
    const nonce = b64u(crypto.randomBytes(24)); const verifier = b64u(crypto.randomBytes(48));
    // The saved redirect URI belongs to the connection's default sign-in app. A PF login on a PingOne-default connection uses the
    // lab's own placeholder, which is what its PingFederate client registers (the PingOne app's URI is not registered there).
    const redirectUri = (eff === 'pf' && conn.idp !== 'pf' ? '' : conn.redirectUri) || PI_FLOW_REDIRECT_URI;
    const q = new URLSearchParams(withResource(conn, eff, { response_type: 'code', client_id: clientOf(conn, eff), redirect_uri: redirectUri, scope: 'openid offline_access', nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', response_mode: 'pi.flow' }));
    if (conn.loginHint) q.set('login_hint', conn.loginHint); // advisory for PingOne (the dialog still takes whatever is typed); PingFederate binds the flow to it
    let res; let flow = null;
    try {
      res = await fetchImpl(`${authorizeEndpoint}?${q}`, { headers: { Accept: profileOf(eff).accept }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      flow = await res.json().catch(() => null);
    } catch (e) { throw authError('pi_flow_unavailable', `authorization server unreachable (${e?.cause?.code || e?.code || 'network error'})`); }
    if (!res.ok || !FLOW_ID.test(String(flow?.id || ''))) {
      const why = errDetail(flow);
      throw authError('pi_flow_unavailable', `the authorization server did not open a sign-in flow (HTTP ${res.status}${why ? `: ${why}` : ''}). The OAuth application must allow the authorization code grant, a public client, and this redirect URI: ${redirectUri}`);
    }
    const loginId = b64u(crypto.randomBytes(24));
    const login = { connId: conn.id, idp: eff, flowId: flow.id, cookies: mergeCookies({}, res), status: flow.status, verifier, nonce, redirectUri, attempts: 0, at: now() };
    logins.set(loginId, login);
    try { return { loginId, ...(conn.loginHint ? { usernameHint: conn.loginHint } : {}), ...(await settle(conn, login, flow)) }; } catch (e) { logins.delete(loginId); throw e; }
  }

  // Posts one step to the open flow. A non-2xx answer is returned, not thrown: callers branch on it.
  async function postStep(conn, login, contentType, payload) {
    const pr = profileOf(login.idp);
    let res; let body = {};
    try {
      res = await fetchImpl(flowUrl(conn, login), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': contentType, Accept: pr.accept, ...cookieHeaders(login.cookies), ...(pr.headers || {}) }, body: JSON.stringify(payload) });
      body = await res.json().catch(() => ({}));
    } catch (e) { throw authError('pi_flow_unavailable', `authorization server unreachable (${e?.cause?.code || e?.code || 'network error'})`); }
    login.cookies = mergeCookies(login.cookies, res);
    return { res, body };
  }

  const deviceView = (body) => (body._embedded?.devices || body.devices || [])
    .filter((d) => (d.usableStatus?.status || 'ENABLED') === 'ENABLED' && d.usable !== false)
    .map((d) => ({ id: String(d.id), type: String(d.type || '').toUpperCase().slice(0, 20), nickname: d.nickname ? String(d.nickname).slice(0, 60) : null, target: String(d.phone || d.email || d.target || '').slice(0, 120) || null }));

  // What the flow's status means for the browser: show a form, finish, or refuse. There is no redirect fallback (rule 16).
  async function settle(conn, login, body) {
    login.status = body.status;
    if (PASSWORD_STATES.has(body.status)) return { step: 'password' };
    if (body.status === 'OTP_REQUIRED') return { step: 'otp', devices: deviceView(body), selectedDeviceId: body.selectedDevice?.id || null };
    if (body.status === 'DEVICE_SELECTION_REQUIRED') return { step: 'device', devices: deviceView(body) };
    if (body.status === 'MFA_COMPLETED' && profileOf(login.idp).cont) { // PingFederate's MFA adapter ends here; this moves the policy on
      const next = await postStep(conn, login, profileOf(login.idp).cont, {});
      if (!next.res.ok) throw authError('pi_flow_failed', `the authorization server refused to continue the sign-in (HTTP ${next.res.status})`);
      return settle(conn, login, next.body);
    }
    if (body.status === 'COMPLETED') return finish(conn, login, body);
    throw authError('login_unsupported', `the sign-on policy asked for a step this lab cannot show (${scrub(String(body.status || 'unknown').slice(0, 40))}). Passkeys and external sign-in are not supported here; there is no redirect fallback.`);
  }

  // COMPLETED -> authorization code -> tokens. PingOne: the code comes from /as/resume. PingFederate: it is in the COMPLETED body.
  async function finish(conn, login, body) {
    let code = '';
    if (login.idp === 'pf') code = body?.authorizeResponse?.code || '';
    else {
      let r;
      try { r = await fetchImpl(`${baseFor(conn, login)}/resume?flowId=${encodeURIComponent(login.flowId)}`, { headers: { Accept: '*/*', ...cookieHeaders(login.cookies) }, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
      catch (e) { throw authError('pi_flow_unavailable', `authorization server unreachable (${e?.cause?.code || e?.code || 'network error'})`); }
      if ((r.headers.get('content-type') || '').includes('json')) { const j = await r.json().catch(() => ({})); code = j?.authorizeResponse?.code || j?.code || ''; }
      if (!code && r.headers.get('location')) { try { code = new URL(r.headers.get('location')).searchParams.get('code') || ''; } catch { /* not a URL */ } }
    }
    if (!code) throw authError('pi_flow_no_code', 'the sign-in finished but no authorization code came back');
    const json = await tokenRequest(conn, withResource(conn, login.idp, { grant_type: 'authorization_code', code: String(code), redirect_uri: login.redirectUri, client_id: clientOf(conn, login.idp), code_verifier: login.verifier }), { idp: login.idp });
    if (!json.id_token) throw authError('bad_id_token', 'no id_token returned, so the nonce cannot be checked');
    const claims = await verifyIdToken(conn, json.id_token, login.nonce, { idp: login.idp });
    const rec = remember(conn, json, null, login.idp); rec.sub = String(claims.sub || '').slice(0, 80) || null;
    return { step: 'done', as: rec.sub };
  }

  // One browser step: { action: 'password', username, password } | { action: 'otp', otp } | { action: 'device', deviceId }.
  async function loginStep(conn, { loginId, action, username, password, otp, deviceId }) {
    const login = logins.get(String(loginId));
    if (login && login.connId === conn.id && now() - login.at > loginTtlMs) logins.delete(String(loginId));
    if (!login || login.connId !== conn.id || now() - login.at > loginTtlMs) throw authError('login_expired', 'this sign-in has expired; start it again'); // a foreign connection's request does not end someone else's sign-in
    const pr = profileOf(login.idp);
    const secrets = [password, otp].filter((x) => typeof x === 'string' && x);
    const bad = (code, message) => { if (++login.attempts >= MAX_ATTEMPTS) { logins.delete(String(loginId)); throw authError('login_expired', 'too many wrong attempts; start the sign-in again'); } throw authError(code, message); };
    const refused = (res, body) => authError('pi_flow_failed', `the authorization server refused the step (HTTP ${res.status}${errDetail(body, secrets) ? `: ${errDetail(body, secrets)}` : ''})`);
    try {
      let out;
      if (action === 'password') {
        let l = null;
        if (login.status === 'SIGN_ON_REQUIRED' && login.idp !== 'pf') { // identifier first: name the user, then the password step opens
          l = await postStep(conn, login, pr.lookup, { username });
          if (!l.res.ok) throw refused(l.res, l.body);
          login.status = l.body.status;
        }
        if (l && l.body.status !== 'PASSWORD_REQUIRED') out = await settle(conn, login, l.body); // the policy needs no password for this user
        else {
          const r = await postStep(conn, login, pr.password, { username, password });
          if (r.res.status === 400 && r.body?.details?.some((d) => d.code === pr.badPassword)) return bad('invalid_credentials', 'Username or password is incorrect.');
          if (!r.res.ok) throw refused(r.res, r.body);
          out = await settle(conn, login, r.body);
        }
      } else if (action === 'otp') {
        if (login.status !== 'OTP_REQUIRED') throw authError('bad_request', 'no one-time code is expected at this point');
        const r = await postStep(conn, login, pr.otp, { otp });
        if (r.res.status === 400 && r.body?.details?.some((d) => d.code === pr.badOtp)) return bad('invalid_otp', 'That code is not valid. Check it and try again.');
        if (!r.res.ok) throw refused(r.res, r.body);
        out = await settle(conn, login, r.body);
      } else if (action === 'device') {
        if (login.status !== 'DEVICE_SELECTION_REQUIRED' && login.status !== 'OTP_REQUIRED') throw authError('bad_request', 'no device choice is expected at this point');
        const r = await postStep(conn, login, pr.device, pr.deviceBody(deviceId));
        if (!r.res.ok) throw refused(r.res, r.body);
        out = await settle(conn, login, r.body);
      } else throw authError('bad_request', 'action must be password, otp or device');
      if (out.step === 'done') logins.delete(String(loginId));
      return out;
    } catch (e) {
      if (!['invalid_credentials', 'invalid_otp', 'bad_request'].includes(e.code)) logins.delete(String(loginId)); // a refused or finished flow cannot be retried
      throw e;
    }
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
    // PingFederate's issuer is its base URL as configured in PF; some set it to <base>/as. Both are tied to the PingFederate saved on the connection.
    const issuers = eff.idp === 'pf' ? [baseOf(eff), baseOf(eff).replace(/\/as$/, '')] : [baseOf(eff)];
    if (!issuers.includes(claims.iss)) throw authError('iss_mismatch', 'id_token issuer is not this environment');
    if (![].concat(claims.aud).includes(clientOf(conn, eff.idp))) throw authError('aud_mismatch', 'id_token audience is not this client');
    if (!(claims.exp * 1000 > now())) throw authError('bad_id_token', 'id_token expired');
    if (claims.nonce !== nonce) throw authError('nonce_mismatch', 'id_token nonce does not match');
    return claims;
  }

  const logout = (conn) => { tokens.delete(conn.id); };
  // Reset: every token and every half-finished sign-in is dropped; the saved connections stay.
  const resetAll = () => { tokens.clear(); logins.clear(); };
  return { accessToken, renew, status, secretsOf, allSecrets, startLogin, loginStep, logout, resetAll, _logins: logins };
}
