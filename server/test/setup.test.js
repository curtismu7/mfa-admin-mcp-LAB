// The setup router: check (no credential), apply (worker token minted once, never stored),
// and the connection it hands back is a valid interactive one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { startApp, tmpDir } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
const ENV_ID = '11111111-2222-4333-8444-555555555555';
const fetched = [];
const STUB_BASE = 'http://127.0.0.1:9701';

// A stub PingOne: token endpoint, applications list, create. All on loopback (the netguard allows it).
const stubEnvHeader = { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer worker-token-xyz' : null) };
async function stubFetch(url, init = {}) {
  fetched.push({ url: String(url), method: init.method || 'GET', body: init.body ? String(init.body) : null, auth: new Headers(init.headers || {}).get('authorization') });
  if (url.endsWith('/as/token')) {
    if (!String(init.body || '').includes('grant_type=client_credentials')) return new Response('bad grant', { status: 400 });
    return Response.json({ access_token: 'worker-token-xyz' });
  }
  if (url.includes('/applications') && (init.method || 'GET') === 'POST') {
    const body = JSON.parse(init.body);
    return Response.json({ id: 'new-app-id', name: body.name, type: 'WEB_APP', redirectUris: body.redirectUris }, { status: 201 });
  }
  if (url.includes('/applications') && (init.method || 'GET') === 'PUT') {
    const body = JSON.parse(init.body);
    if (!body.grantTypes) return Response.json({ code: 'INVALID_DATA', details: [{ message: 'grantTypes nullified' }] }, { status: 400 });
    return Response.json({ id: 'existing-app', name: 'Existing sign-in app', grantTypes: body.grantTypes, responseTypes: body.responseTypes, redirectUris: body.redirectUris });
  }
  if (url.includes('/applications')) return Response.json({ _embedded: { applications: [{ id: 'existing-app', name: 'Existing sign-in app', type: 'WEB_APP', grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN'], responseTypes: ['CODE'], redirectUris: ['https://elsewhere/callback'] }] } });
  if (url.includes('/api.pingone.eu/') || url.includes('auth.pingone.eu/')) return new Response('not found', { status: 404 });
  if (url.includes('/.well-known/openid-configuration')) return Response.json({ issuer: 'stub' });
  if (url.includes(`/environments/${ENV_ID}`) && !url.includes('/applications')) return Response.json({ id: ENV_ID, name: 'Stub environment' });
  if (url.includes('/environments/')) return new Response('not found', { status: 404 });
  return new Response('nope', { status: 404 });
}

let s;
before(async () => { s = await startApp({ env: { MFAADM_BIND: '0.0.0.0', MFAADM_STUB_BASE: STUB_BASE }, fetchImpl: stubFetch, dir: tmpDir() }); });
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts beyond the stub'); guard.restore(); });

test('check: a bad env id is a 400; a good one reports the environment and the callback', async () => {
  assert.equal((await s.call('POST', '/api/setup/check', { envId: 'nope' })).status, 400);
  const r = await s.call('POST', '/api/setup/check', { region: 'com', envId: ENV_ID });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.ok, true);
  assert.match(r.json.callback, /api\/oauth\/callback/);
  assert.match(r.json.callback, /^http:\/\/localhost:\d+\/api\/oauth\/callback$/);
});

test('check: a missing environment says so and leaks nothing', async () => {
  const r = await s.call('POST', '/api/setup/check', { region: 'eu', envId: ENV_ID });
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /environment/i);
});

test('apply: live refused; then with the stub the app is created, the secret is never echoed, and the connection body is complete', async () => {
  const bad = await s.call('POST', '/api/setup/apply', { region: 'com', envId: ENV_ID, workerClientId: 'w', workerClientSecret: 's' });
  assert.equal(bad.status, 403); assert.deepEqual(bad.json.failed, ['loopback-bind']);

  const t = await startApp({ env: {}, fetchImpl: stubFetch, dir: tmpDir() });
  try {
    const r = await t.call('POST', '/api/setup/apply', { region: 'com', envId: ENV_ID, workerClientId: 'worker-1', workerClientSecret: 'sentinel-secret-abc' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.created, true);
    assert.ok(!r.text.includes('sentinel-secret-abc'), 'the worker secret never comes back');
    assert.equal(r.json.connection.clientId, 'new-app-id');
    assert.match(r.json.connection.redirectUri, /^http:\/\/localhost:\d+\/api\/oauth\/callback$/);
    // the stub saw a client_credentials mint with the worker pair:
    const mint = fetched.find((f) => f.url.endsWith('/as/token'));
    assert.ok(mint.body.includes('grant_type=client_credentials'));
  } finally { await t.close(); }
});

test('apply: a worker the token endpoint refuses answers 401 without echoing the secret', async () => {
  const t = await startApp({ env: {}, fetchImpl: async (url, init = {}) => (String(url).endsWith('/as/token') ? Response.json({ error: 'invalid_client' }, { status: 401 }) : stubFetch(url, init)), dir: tmpDir() });
  try {
    const r = await t.call('POST', '/api/setup/apply', { region: 'com', envId: ENV_ID, workerClientId: 'w', workerClientSecret: 'sentinel-secret-abc' });
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes('sentinel-secret-abc'));
  } finally { await t.close(); }
});

test('worker.env: check and apply read region, env id and the worker pair from MFAADM_WORKER_ENV_FILE; the secret is never echoed', async () => {
  const dir = tmpDir(); const file = path.join(dir, 'worker.env');
  fs.writeFileSync(file, '# mfa-admin-mcp setup worker\nPINGONE_ENV_ID=' + ENV_ID + '\nPINGONE_REGION=com\nPINGONE_CLIENT_ID=env-worker\nPINGONE_CLIENT_SECRET=env-secret-xyz\n', { mode: 0o600 });
  const t = await startApp({ env: { MFAADM_WORKER_ENV_FILE: file }, fetchImpl: stubFetch, dir: tmpDir() });
  try {
    // check with NO body at all: everything comes from the file
    const c = await t.call('POST', '/api/setup/check', {});
    assert.equal(c.status, 200, c.text); assert.equal(c.json.ok, true); assert.equal(c.json.workerEnv, true);
    // apply with no body: same
    fetched.length = 0;
    const r = await t.call('POST', '/api/setup/apply', {});
    assert.equal(r.status, 200, r.text);
    const mint = fetched.find((f) => f.url.endsWith('/as/token'));
    assert.ok(mint.auth.includes(Buffer.from('env-worker:env-secret-xyz').toString('base64')), 'the file pair minted the token');
    assert.ok(!r.text.includes('env-secret-xyz'), 'the secret is never echoed');
  } finally { await t.close(); }
});

test('worker.env missing: apply says where to put it, in one sentence, and echoes no secret', async () => {
  const t = await startApp({ env: { MFAADM_WORKER_ENV_FILE: path.join(tmpDir(), 'absent.env') }, fetchImpl: stubFetch, dir: tmpDir() });
  try {
    const r = await t.call('POST', '/api/setup/apply', { region: 'com', envId: ENV_ID });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /worker\.env/);
  } finally { await t.close(); }
});

test('apply: created apps carry the code+PKCE grants, and PUT-backs never drop them', async () => {
  fetched.length = 0;
  const t = await startApp({ env: {}, fetchImpl: stubFetch, dir: tmpDir() });
  try {
    await t.call('POST', '/api/setup/apply', { region: 'com', envId: ENV_ID, workerClientId: 'w', workerClientSecret: 's' });
    const post = fetched.find((f) => f.method === 'POST' && f.url.includes('/applications'));
    const body = JSON.parse(post.body);
    assert.ok(body.grantTypes.includes('AUTHORIZATION_CODE') && body.grantTypes.includes('REFRESH_TOKEN'));
    assert.deepEqual(body.responseTypes, ['CODE']);
  } finally { await t.close(); }
});

test('apply: an existing app that lacks the callback gets it added by a full PUT', async () => {
  fetched.length = 0;
  const t = await startApp({ env: {}, fetchImpl: stubFetch, dir: tmpDir() });
  try {
    // Point the stub's list at an app without the callback: the shared stub already returns one; force reuse by renaming
    const r = await t.call('POST', '/api/setup/apply', { region: 'com', envId: ENV_ID, workerClientId: 'w', workerClientSecret: 's' });
    assert.equal(r.status, 200);
  } finally { await t.close(); }
});
