import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import { createAuth, pkceChallenge } from '../src/auth.js';
import { createMock } from '../src/mock.js';
import { ENV_ID } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
const mock = createMock();
const REDIRECT = 'http://localhost:5299/api/oauth/callback';
before(() => mock.start());
after(async () => { await mock.stop(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });
beforeEach(() => { mock.config.expiresIn = 3600; mock.config.issOverride = null; mock.config.nonceOverride = null; mock.config.forgeIdToken = false; mock.config.audOverride = null; mock.tokens.clear(); mock.refreshes.clear(); });

const worker = (o = {}) => ({ id: 'w1', kind: 'pingone', auth: 'worker', region: 'com', envId: ENV_ID, clientId: 'admin-app', clientSecret: 'sekrit-worker', tokenAuthMethod: 'basic', ...o });
const inter = (o = {}) => ({ id: 'i1', kind: 'pingone', auth: 'interactive', region: 'com', envId: ENV_ID, clientId: 'admin-app', redirectUri: REDIRECT, ...o });
const mk = (extra = {}) => createAuth({ resolveBase: () => mock.base, ...extra });
async function authorize(url) { const r = await fetch(url, { redirect: 'manual' }); assert.equal(r.status, 302); return new URL(r.headers.get('location')); }

test('PKCE S256 challenge is the base64url sha256 of the verifier', () => {
  assert.equal(pkceChallenge('abc'), crypto.createHash('sha256').update('abc').digest('base64url'));
});
test('worker: mints with Basic or body secret, caches, re-mints inside the expiry margin', async () => {
  for (const method of ['basic', 'post']) {
    mock.tokens.clear();
    const a = mk(); const c = worker({ tokenAuthMethod: method });
    const t1 = await a.accessToken(c); assert.equal(await a.accessToken(c), t1); assert.equal(mock.tokens.size, 1);
  }
  mock.tokens.clear(); mock.config.expiresIn = 30; // inside the 60 s margin: every call re-mints
  const a = mk(); const c = worker();
  assert.notEqual(await a.accessToken(c), await a.accessToken(c));
});
test('worker: a wrong secret fails without echoing it', async () => {
  mock.clients.set('strict-app', { secret: 'right', role: 'admin' });
  const c = worker({ clientId: 'strict-app', clientSecret: 'wrong-secret-value' });
  await assert.rejects(mk().accessToken(c), (e) => e.code === 'token_request_failed' && !e.message.includes('wrong-secret-value'));
  mock.clients.delete('strict-app');
});
test('worker: renew after a rejection mints a new token', async () => {
  const a = mk(); const c = worker(); const t = await a.accessToken(c);
  mock.revoke(t); assert.equal(await a.renew(c), true); assert.notEqual(await a.accessToken(c), t);
});
test('interactive: full code+PKCE flow, authorize carries S256/state/nonce, status shows sub only, logout clears', async () => {
  const a = mk(); const c = inter();
  const { authorizeUrl } = a.startLogin(c);
  const u = new URL(authorizeUrl);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('state') && u.searchParams.get('nonce') && u.searchParams.get('code_challenge'));
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  await assert.rejects(a.accessToken(c), (e) => e.code === 'login_required');
  const cb = await authorize(authorizeUrl);
  const done = await a.completeLogin({ q: Object.fromEntries(cb.searchParams), at: REDIRECT, getConn: () => c });
  assert.equal(done.sub, 'mock-admin-user');
  assert.deepEqual({ ...a.status(c), expiresAt: 0 }, { signedIn: true, as: 'mock-admin-user', expiresAt: 0 });
  assert.match(await a.accessToken(c), /^mock-at-/);
  a.logout(c); assert.deepEqual(a.status(c), { signedIn: false });
});
test('interactive: state is single use (replay refused) and unknown state refused', async () => {
  const a = mk(); const c = inter();
  const cb = await authorize(a.startLogin(c).authorizeUrl); const q = Object.fromEntries(cb.searchParams);
  await a.completeLogin({ q, at: REDIRECT, getConn: () => c });
  await assert.rejects(a.completeLogin({ q, at: REDIRECT, getConn: () => c }), (e) => e.code === 'bad_state');
  await assert.rejects(a.completeLogin({ q: { ...q, state: 'forged' }, at: REDIRECT, getConn: () => c }), (e) => e.code === 'bad_state');
});
test('interactive: state expires after the TTL', async () => {
  let t = 1_000_000; const a = mk({ now: () => t, stateTtlMs: 1000 }); const c = inter();
  const cb = await authorize(a.startLogin(c).authorizeUrl); t += 2000;
  await assert.rejects(a.completeLogin({ q: Object.fromEntries(cb.searchParams), at: REDIRECT, getConn: () => c }), (e) => e.code === 'state_expired');
});
test('interactive: wrong iss (callback param or id_token) is refused', async () => {
  const a = mk(); const c = inter();
  const cb = await authorize(a.startLogin(c).authorizeUrl); const q = Object.fromEntries(cb.searchParams);
  await assert.rejects(a.completeLogin({ q: { ...q, iss: 'https://evil.example/as' }, at: REDIRECT, getConn: () => c }), (e) => e.code === 'iss_mismatch');
  mock.config.issOverride = 'https://evil.example/as';
  const cb2 = await authorize(a.startLogin(c).authorizeUrl); const q2 = Object.fromEntries(cb2.searchParams); delete q2.iss;
  await assert.rejects(a.completeLogin({ q: q2, at: REDIRECT, getConn: () => c }), (e) => e.code === 'iss_mismatch');
});
test('interactive: nonce mismatch, wrong redirect URI, error param, tampered code all refused', async () => {
  const a = mk(); const c = inter();
  mock.config.nonceOverride = 'other';
  let q = Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams);
  await assert.rejects(a.completeLogin({ q, at: REDIRECT, getConn: () => c }), (e) => e.code === 'nonce_mismatch');
  mock.config.nonceOverride = null;
  q = Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams);
  await assert.rejects(a.completeLogin({ q, at: 'http://localhost:5299/callback', getConn: () => c }), (e) => e.code === 'redirect_mismatch');
  q = Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams);
  await assert.rejects(a.completeLogin({ q: { ...q, code: 'tampered' }, at: REDIRECT, getConn: () => c }), (e) => e.code === 'token_request_failed');
  const st = new URL(a.startLogin(c).authorizeUrl).searchParams.get('state');
  await assert.rejects(a.completeLogin({ q: { state: st, error: 'access_denied' }, at: REDIRECT, getConn: () => c }), (e) => e.code === 'authorization_denied');
});
test('interactive: an expired access token is refreshed (and rotated) before use; no refresh = login_required', async () => {
  mock.config.expiresIn = 30;
  const a = mk(); const c = inter();
  await a.completeLogin({ q: Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams), at: REDIRECT, getConn: () => c });
  const before = mock.refreshes.size;
  const t = await a.accessToken(c);
  assert.match(t, /^mock-at-/); assert.equal(mock.refreshes.size, before, 'old refresh token consumed, new one issued');
  mock.refreshes.clear(); // the AS forgets the refresh token
  await assert.rejects(a.accessToken(c), (e) => e.code === 'login_required');
});
test('interactive: an id_token signed by a key the jwks does not publish is refused (valid iss, aud and nonce)', async () => {
  const a = mk(); const c = inter();
  mock.config.forgeIdToken = true;
  const q = Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams);
  await assert.rejects(a.completeLogin({ q, at: REDIRECT, getConn: () => c }), (e) => e.code === 'bad_id_token' && /signature/.test(e.message));
  assert.deepEqual(a.status(c), { signedIn: false });
});
test('interactive: an otherwise valid id_token issued to another client is refused (aud)', async () => {
  const a = mk(); const c = inter();
  mock.config.audOverride = 'some-other-client';
  const q = Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams);
  await assert.rejects(a.completeLogin({ q, at: REDIRECT, getConn: () => c }), (e) => e.code === 'aud_mismatch');
  assert.deepEqual(a.status(c), { signedIn: false });
});
test('mock AS self-test: a wrong PKCE code_verifier is refused at the token endpoint', async () => {
  const a = mk(); const c = inter();
  const q = Object.fromEntries((await authorize(a.startLogin(c).authorizeUrl)).searchParams);
  const r = await fetch(`${mock.base}/${ENV_ID}/as/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: REDIRECT, client_id: 'admin-app', code_verifier: 'wrong-verifier' }) });
  assert.equal(r.status, 400);
});
test('worker: a token endpoint error that echoes the secret is scrubbed from the thrown message', async () => {
  const SECRET = 'echoed-worker-secret-4455';
  const stub = http.createServer((_q, r) => { r.writeHead(500, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ error: 'server_error', error_description: `bad secret ${SECRET} for client` })); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  try {
    const a = createAuth({ resolveBase: () => `http://127.0.0.1:${stub.address().port}` });
    await assert.rejects(a.accessToken(worker({ clientSecret: SECRET })), (e) => e.code === 'token_request_failed' && !e.message.includes(SECRET) && e.message.includes('[redacted]'));
  } finally { stub.close(); }
});
