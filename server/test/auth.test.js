import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import { createAuth, LEGACY_WORKER, pkceChallenge, PI_FLOW_REDIRECT_URI } from '../src/auth.js';
import { createMock, MOCK_LOGIN } from '../src/mock.js';
import { ENV_ID } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
const mock = createMock();
before(() => mock.start());
after(async () => { await mock.stop(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });
beforeEach(() => { mock.config.expiresIn = 3600; mock.config.issOverride = null; mock.config.nonceOverride = null; mock.config.forgeIdToken = false; mock.config.audOverride = null; mock.config.afterPassword = null; mock.config.resumeAsJson = false; mock.config.flowSteps.length = 0; mock.config.resources.length = 0; mock.tokens.clear(); mock.refreshes.clear(); });

const inter = (o = {}) => ({ id: 'i1', kind: 'pingone', auth: 'interactive', region: 'com', envId: ENV_ID, clientId: 'admin-app', ...o });
const mk = (extra = {}) => createAuth({ resolveBase: () => mock.base, ...extra });
const PW = MOCK_LOGIN.password;
const recording = () => { const rec = []; return { rec, fetchImpl: (u, o) => { rec.push({ url: String(u), ...o }); return fetch(u, o); } }; };
// Signs in the mock account: password, then the code when asked. Returns the last step.
async function signIn(a, c, username = MOCK_LOGIN.username) {
  const s = await a.startLogin(c);
  let r = await a.loginStep(c, { loginId: s.loginId, action: 'password', username, password: PW });
  if (r.step === 'device') r = await a.loginStep(c, { loginId: s.loginId, action: 'device', deviceId: r.devices[0].id });
  if (r.step === 'otp') r = await a.loginStep(c, { loginId: s.loginId, action: 'otp', otp: MOCK_LOGIN.otp });
  return { ...r, loginId: s.loginId };
}

test('PKCE S256 challenge is the base64url sha256 of the verifier', () => {
  assert.equal(pkceChallenge('abc'), crypto.createHash('sha256').update('abc').digest('base64url'));
});
test('a connection saved as a worker by an older build is refused with a clear message: no token is minted, no sign-in opens, nothing is sent', async () => {
  const { rec, fetchImpl } = recording(); const a = mk({ fetchImpl });
  const legacy = { id: 'w1', kind: 'pingone', auth: 'worker', region: 'com', envId: ENV_ID, clientId: 'old-worker', clientSecret: 'sekrit-worker', tokenAuthMethod: 'basic' };
  await assert.rejects(a.accessToken(legacy), (e) => e.code === 'worker_unsupported' && e.message === LEGACY_WORKER && /user sign-in/.test(e.message) && !e.message.includes('sekrit'));
  await assert.rejects(a.startLogin(legacy), (e) => e.code === 'worker_unsupported');
  assert.equal(await a.renew(legacy), false);
  assert.deepEqual(a.status(legacy), { signedIn: false });
  assert.deepEqual(rec, [], 'nothing was sent to any server');
});
test('the mock authorization server has no client_credentials grant: a worker gets no token from it', async () => {
  const r = await fetch(`${mock.base}/${ENV_ID}/as/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from('admin-app:s').toString('base64')}` }, body: 'grant_type=client_credentials' });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'unsupported_grant_type');
  assert.equal(mock.tokens.size, 0);
});
test('the role comes from the signed-in mock account, not the client id: mock.viewer is a viewer, the others are admins', async () => {
  const roleOf = async (user, clientId = 'admin-app') => { const a = mk(); const c = inter({ clientId }); const done = await signIn(a, c, user); return { as: done.as, role: mock.tokens.get(await a.accessToken(c)).role }; };
  assert.deepEqual(await roleOf(MOCK_LOGIN.viewer), { as: 'mock-viewer-user', role: 'viewer' });
  assert.deepEqual(await roleOf(MOCK_LOGIN.viewer, 'admin-demo'), { as: 'mock-viewer-user', role: 'viewer' }, 'an admin-sounding client id changes nothing');
  assert.deepEqual(await roleOf(MOCK_LOGIN.username, 'viewer-demo'), { as: 'mock-admin-user', role: 'admin' }, 'a viewer-sounding client id changes nothing');
  for (const u of ['mock.nomfa', 'mock.multi']) assert.equal((await roleOf(u)).role, 'admin', u);
});
test('pi.flow sends the RFC 8707 resource (the MCP URL of the connection) on the authorize, the code redemption and the refresh; the mock AS receives it', async () => {
  // offline: the in-process mock's MCP URL
  const { rec, fetchImpl } = recording(); mock.config.expiresIn = 30; // inside the refresh margin, so the next use refreshes
  const a = mk({ fetchImpl }); const c = inter();
  await signIn(a, c); await a.accessToken(c);
  const want = `${mock.base}/mcp/${ENV_ID}`;
  assert.equal(new URL(rec.find((r) => r.url.includes('/as/authorize')).url).searchParams.get('resource'), want);
  assert.deepEqual(rec.filter((r) => r.url.endsWith('/as/token')).map((r) => [new URLSearchParams(r.body).get('grant_type'), new URLSearchParams(r.body).get('resource')]), [['authorization_code', want], ['refresh_token', want]]);
  assert.deepEqual(mock.config.resources, [{ at: 'authorize', resource: want }, { at: 'authorization_code', resource: want }, { at: 'refresh_token', resource: want }]);
  // a live connection: the hosted MCP URL for its region and endpoint style (mcp-host by default). The requests are answered by the mock.
  const live = 'https://auth.pingone.eu';
  const forward = (u, o) => fetch(String(u).replace(live, mock.base), o);
  mock.config.issOverride = `${live}/${ENV_ID}/as`;
  for (const [style, url] of [[undefined, `https://mcp.pingone.eu/admin/${ENV_ID}/mcp`], ['mcp-host', `https://mcp.pingone.eu/admin/${ENV_ID}/mcp`], ['api', `https://api.pingone.eu/v1/environments/${ENV_ID}/mcp`]]) {
    mock.config.resources.length = 0;
    await signIn(createAuth({ resolveBase: () => null, fetchImpl: forward }), inter({ region: 'eu', ...(style ? { endpointStyle: style } : {}) }));
    assert.deepEqual(mock.config.resources.map((x) => x.resource), [url, url], style || 'default');
  }
});
test('interactive (pi.flow): the flow is opened with code + PKCE S256 + nonce and no redirect, steps carry the vendor content types, status shows sub only, logout clears', async () => {
  const { rec, fetchImpl } = recording(); const a = mk({ fetchImpl }); const c = inter();
  await assert.rejects(a.accessToken(c), (e) => e.code === 'login_required');
  const s = await a.startLogin(c);
  assert.equal(s.step, 'password'); assert.ok(s.loginId);
  const u = new URL(rec[0].url);
  assert.equal(u.pathname, `/${ENV_ID}/as/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', response_mode: 'pi.flow', code_challenge_method: 'S256', client_id: 'admin-app', redirect_uri: PI_FLOW_REDIRECT_URI })) assert.equal(u.searchParams.get(k), v, k);
  assert.ok(u.searchParams.get('nonce') && u.searchParams.get('code_challenge'));
  assert.equal(u.searchParams.has('state'), false, 'a native flow has no redirect, so no state');
  assert.equal(rec[0].redirect, 'manual');
  const otp = await a.loginStep(c, { loginId: s.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW });
  assert.equal(otp.step, 'otp'); assert.equal(otp.devices[0].type, 'SMS'); assert.equal(otp.selectedDeviceId, otp.devices[0].id);
  assert.deepEqual(a.status(c), { signedIn: false }, 'a password alone signs nobody in');
  const done = await a.loginStep(c, { loginId: s.loginId, action: 'otp', otp: MOCK_LOGIN.otp });
  assert.deepEqual(done, { step: 'done', as: 'mock-admin-user' });
  assert.ok(new URL(rec[0].url).searchParams.get('resource'), 'the authorize names the resource');
  assert.deepEqual(mock.config.flowSteps.map((x) => x.contentType), ['application/vnd.pingidentity.usernamePassword.check+json', 'application/vnd.pingidentity.otp.check+json']);
  const tokenCall = rec.find((r) => r.url.endsWith('/as/token'));
  assert.equal(new URLSearchParams(tokenCall.body).get('client_secret'), null, 'a public client sends no secret');
  assert.equal(tokenCall.headers.Authorization, undefined);
  assert.deepEqual({ ...a.status(c), expiresAt: 0 }, { signedIn: true, as: 'mock-admin-user', expiresAt: 0 });
  assert.match(await a.accessToken(c), /^mock-at-/);
  a.logout(c); assert.deepEqual(a.status(c), { signedIn: false });
});
test('interactive (pi.flow): a password-only account finishes at once; an account with two devices must choose one first; the resume may answer JSON', async () => {
  const a = mk(); const c = inter();
  assert.equal((await signIn(a, c, 'mock.nomfa')).step, 'done');
  const a2 = mk(); const s = await a2.startLogin(c);
  const dev = await a2.loginStep(c, { loginId: s.loginId, action: 'password', username: 'mock.multi', password: PW });
  assert.equal(dev.step, 'device'); assert.deepEqual(dev.devices.map((d) => d.type), ['SMS', 'EMAIL']);
  const otp = await a2.loginStep(c, { loginId: s.loginId, action: 'device', deviceId: dev.devices[1].id });
  assert.equal(otp.step, 'otp'); assert.equal(otp.devices.length, 1); assert.equal(otp.devices[0].type, 'EMAIL');
  assert.equal((await a2.loginStep(c, { loginId: s.loginId, action: 'otp', otp: MOCK_LOGIN.otp })).step, 'done');
  mock.config.resumeAsJson = true;
  assert.equal((await signIn(mk(), c)).step, 'done');
});
test('interactive (pi.flow): wrong password and wrong code are retried on the same flow; five misses end it; nothing is signed in meanwhile', async () => {
  const a = mk(); const c = inter(); const s = await a.startLogin(c);
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'password', username: MOCK_LOGIN.username, password: 'nope' }), (e) => e.code === 'invalid_credentials');
  await a.loginStep(c, { loginId: s.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW });
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'otp', otp: '000000' }), (e) => e.code === 'invalid_otp');
  assert.equal((await a.loginStep(c, { loginId: s.loginId, action: 'otp', otp: MOCK_LOGIN.otp })).step, 'done');
  const b = mk(); const s2 = await b.startLogin(c);
  for (let i = 0; i < 4; i++) await assert.rejects(b.loginStep(c, { loginId: s2.loginId, action: 'password', username: 'x', password: 'y' }), (e) => e.code === 'invalid_credentials');
  await assert.rejects(b.loginStep(c, { loginId: s2.loginId, action: 'password', username: 'x', password: 'y' }), (e) => e.code === 'login_expired');
  await assert.rejects(b.loginStep(c, { loginId: s2.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW }), (e) => e.code === 'login_expired', 'the flow is gone, even for the right password');
  assert.deepEqual(b.status(c), { signedIn: false });
});
test('interactive (pi.flow): an unknown, foreign, expired or finished sign-in is refused; a step out of order is refused; reset drops half-finished sign-ins', async () => {
  let t = 1_000_000; const a = mk({ now: () => t, loginTtlMs: 1000 }); const c = inter();
  await assert.rejects(a.loginStep(c, { loginId: 'forged', action: 'password', username: 'u', password: 'p' }), (e) => e.code === 'login_expired');
  const s = await a.startLogin(c);
  await assert.rejects(a.loginStep(inter({ id: 'other' }), { loginId: s.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW }), (e) => e.code === 'login_expired', 'another connection cannot use this sign-in');
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'otp', otp: MOCK_LOGIN.otp }), (e) => e.code === 'bad_request', 'a code before the password');
  t += 2000;
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW }), (e) => e.code === 'login_expired');
  const fin = await signIn(mk(), c);
  await assert.rejects(mk().loginStep(c, { loginId: fin.loginId, action: 'otp', otp: MOCK_LOGIN.otp }), (e) => e.code === 'login_expired', 'a finished sign-in cannot be replayed');
  const r = mk(); const s3 = await r.startLogin(c); r.resetAll();
  await assert.rejects(r.loginStep(c, { loginId: s3.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW }), (e) => e.code === 'login_expired');
});
test('interactive (pi.flow): a step this lab cannot show (a passkey) is refused with no redirect fallback and no tokens', async () => {
  mock.config.afterPassword = 'ASSERTION_REQUIRED';
  const a = mk(); const c = inter(); const s = await a.startLogin(c);
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'password', username: MOCK_LOGIN.username, password: PW }), (e) => e.code === 'login_unsupported' && /ASSERTION_REQUIRED/.test(e.message) && /no redirect fallback/.test(e.message));
  assert.deepEqual(a.status(c), { signedIn: false });
});
test('interactive (pi.flow): an authorization server that will not open a flow says why, and no sign-in is left behind', async () => {
  const a = createAuth({ resolveBase: () => mock.base, fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uri mismatch' }), { status: 400 }) });
  await assert.rejects(a.startLogin(inter()), (e) => e.code === 'pi_flow_unavailable' && /HTTP 400/.test(e.message) && /redirect_uri mismatch/.test(e.message) && e.message.includes(PI_FLOW_REDIRECT_URI));
  assert.equal(a._logins.size, 0);
  const down = createAuth({ resolveBase: () => 'http://127.0.0.1:1', fetchImpl: fetch });
  await assert.rejects(down.startLogin(inter()), (e) => e.code === 'pi_flow_unavailable' && /unreachable/.test(e.message));
});
test('interactive (pi.flow): the password and the code never appear in an error, even when the server echoes them', async () => {
  const PASS = 'p4ss-echoed-by-server'; const OTP = '98765432';
  const fetchImpl = async (u, o) => {
    if (String(u).includes('/flows/')) return new Response(JSON.stringify({ code: 'UNEXPECTED', message: `cannot use ${PASS} or ${OTP}` }), { status: 500 });
    return fetch(u, o);
  };
  const a = createAuth({ resolveBase: () => mock.base, fetchImpl }); const c = inter(); const s = await a.startLogin(c);
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'password', username: 'u', password: PASS }), (e) => e.code === 'pi_flow_failed' && !e.message.includes(PASS) && e.message.includes('[redacted]'));
  const s2 = await a.startLogin(c);
  await assert.rejects(a.loginStep(c, { loginId: s2.loginId, action: 'otp', otp: OTP }), (e) => !e.message.includes(OTP));
});
test('interactive (pi.flow): a server that sets no session cookie gets none back, and one that rotates it gets the newest one every time', async () => {
  const seen = [];
  const mkFetch = (setCookie) => async (u, o = {}) => {
    if (String(u).includes('/as/authorize')) return new Response(JSON.stringify({ id: 'flow-abc123XYZ-789', status: 'USERNAME_PASSWORD_REQUIRED' }), { status: 200, headers: { 'content-type': 'application/hal+json', ...(setCookie ? { 'set-cookie': 'ST=first; Path=/; HttpOnly' } : {}) } });
    seen.push({ cookie: o.headers?.Cookie, url: String(u) });
    return new Response(JSON.stringify({ details: [{ code: 'INVALID_CREDENTIALS' }] }), { status: 400, headers: setCookie ? { 'set-cookie': `ST=n${seen.length}; Path=/` } : {} });
  };
  for (const withCookie of [false, true]) {
    seen.length = 0;
    const a = createAuth({ resolveBase: () => mock.base, fetchImpl: mkFetch(withCookie) }); const c = inter(); const s = await a.startLogin(c);
    for (let i = 0; i < 2; i++) await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'password', username: 'u', password: 'p' }), (e) => e.code === 'invalid_credentials');
    assert.deepEqual(seen.map((x) => x.cookie), withCookie ? ['ST=first', 'ST=n1'] : [undefined, undefined]);
    assert.ok(seen.every((x) => x.url === `http://127.0.0.1:${new URL(mock.base).port}/${ENV_ID}/flows/flow-abc123XYZ-789`), 'the PingOne flow URL is <auth host>/<env>/flows/<id>');
  }
});
test('interactive: the token endpoint refusing a public client explains that the app must be public', async () => {
  const fetchImpl = async (u, o) => (String(u).endsWith('/as/token') ? new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Request denied: Unsupported authentication method' }), { status: 401 }) : fetch(u, o));
  const a = createAuth({ resolveBase: () => mock.base, fetchImpl });
  await assert.rejects(signIn(a, inter()), (e) => e.code === 'token_request_failed' && /invalid_client/.test(e.message) && /public client/.test(e.message));
  assert.deepEqual(a.status(inter()), { signedIn: false });
});
test('interactive (pi.flow): wrong iss, wrong nonce, a forged signature and a foreign audience in the id_token are all refused', async () => {
  const c = inter();
  mock.config.issOverride = 'https://evil.example/as';
  await assert.rejects(signIn(mk(), c), (e) => e.code === 'iss_mismatch'); mock.config.issOverride = null;
  mock.config.nonceOverride = 'other';
  await assert.rejects(signIn(mk(), c), (e) => e.code === 'nonce_mismatch'); mock.config.nonceOverride = null;
  mock.config.forgeIdToken = true;
  const a = mk();
  await assert.rejects(signIn(a, c), (e) => e.code === 'bad_id_token' && /signature/.test(e.message)); mock.config.forgeIdToken = false;
  mock.config.audOverride = 'some-other-client';
  await assert.rejects(signIn(a, c), (e) => e.code === 'aud_mismatch');
  assert.deepEqual(a.status(c), { signedIn: false });
});
test('interactive: an expired access token is refreshed (and rotated) before use; no refresh = login_required', async () => {
  mock.config.expiresIn = 30;
  const a = mk(); const c = inter();
  await signIn(a, c);
  const before = mock.refreshes.size;
  const t = await a.accessToken(c);
  assert.match(t, /^mock-at-/); assert.equal(mock.refreshes.size, before, 'old refresh token consumed, new one issued');
  mock.refreshes.clear(); // the AS forgets the refresh token
  await assert.rejects(a.accessToken(c), (e) => e.code === 'login_required');
});
test('mock AS self-test: a flow step needs the session cookie, a redirect-style authorize is refused, and a wrong PKCE code_verifier is refused at the token endpoint', async () => {
  const q = new URLSearchParams({ response_type: 'code', client_id: 'admin-app', redirect_uri: PI_FLOW_REDIRECT_URI, scope: 'openid', nonce: 'n', code_challenge: pkceChallenge('v'), code_challenge_method: 'S256' });
  assert.equal((await fetch(`${mock.base}/${ENV_ID}/as/authorize?${q}`, { redirect: 'manual' })).status, 400, 'no response_mode=pi.flow');
  q.set('response_mode', 'pi.flow');
  const open = await fetch(`${mock.base}/${ENV_ID}/as/authorize?${q}`); const flow = await open.json();
  const step = (headers) => fetch(`${mock.base}/${ENV_ID}/flows/${flow.id}`, { method: 'POST', headers: { 'content-type': 'application/vnd.pingidentity.usernamePassword.check+json', ...headers }, body: JSON.stringify({ username: MOCK_LOGIN.username, password: PW }) });
  assert.equal((await step({})).status, 401, 'no cookie');
  const cookie = open.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await step({ cookie })).status, 200);
  assert.equal((await step({ cookie })).status, 401, 'the cookie rotates on every step, so the old one is dead');
  // a second flow, for an account with no second factor, to get a real code and try a wrong verifier on it
  const open2 = await fetch(`${mock.base}/${ENV_ID}/as/authorize?${q}`); const flow2 = await open2.json();
  const done = await fetch(`${mock.base}/${ENV_ID}/flows/${flow2.id}`, { method: 'POST', headers: { 'content-type': 'application/vnd.pingidentity.usernamePassword.check+json', cookie: open2.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ username: 'mock.nomfa', password: PW }) });
  assert.equal((await done.json()).status, 'COMPLETED');
  const resume = await fetch(`${mock.base}/${ENV_ID}/as/resume?flowId=${flow2.id}`, { redirect: 'manual', headers: { cookie: done.headers.getSetCookie()[0].split(';')[0] } });
  const code = new URL(resume.headers.get('location')).searchParams.get('code');
  const wrong = await fetch(`${mock.base}/${ENV_ID}/as/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: PI_FLOW_REDIRECT_URI, client_id: 'admin-app', code_verifier: 'wrong-verifier' }) });
  assert.equal(wrong.status, 400);
});
test('a token endpoint error that echoes what it was sent (the code and the PKCE verifier) is scrubbed from the thrown message', async () => {
  let sent;
  const fetchImpl = async (u, o) => {
    if (!String(u).endsWith('/as/token')) return fetch(u, o);
    sent = new URLSearchParams(o.body);
    return new Response(JSON.stringify({ error: 'server_error', error_description: `bad code ${sent.get('code')} with verifier ${sent.get('code_verifier')}` }), { status: 500 });
  };
  const a = createAuth({ resolveBase: () => mock.base, fetchImpl });
  await assert.rejects(signIn(a, inter()), (e) => e.code === 'token_request_failed' && !e.message.includes(sent.get('code')) && !e.message.includes(sent.get('code_verifier')) && e.message.includes('[redacted]'));
  assert.deepEqual(a.status(inter()), { signedIn: false });
});
