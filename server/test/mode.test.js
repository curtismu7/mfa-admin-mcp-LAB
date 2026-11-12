// Mock / Live: Live is refused unless every guard passes (owner opt-in, loopback bind). Mock never needs the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { MODE_KEY, liveGuards, liveRefusal, modeFrom } from '../src/config.js';
import { SETTINGS_KEYS, applySharedSettings, readSharedSettings } from '../src/settings.js';
import { ENV_ID, startApp, tmpDir, workerConn } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
let s;
before(async () => { s = await startApp({ env: { [MODE_KEY]: 'mock' } }); });
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const liveBody = { kind: 'custom', label: 'x', url: 'http://127.0.0.1:9/mcp' };

test('GET /api/info: Mock is the mode, Live is refused and says which guard failed', async () => {
  const r = await s.call('GET', '/api/info');
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'mock'); assert.deepEqual(r.json.modes, ['mock', 'live']);
  assert.equal(r.json.live.available, false); assert.deepEqual(r.json.live.failed, ['owner-opt-in']);
  assert.ok(r.json.live.needs.length === 1 && r.json.live.needs[0].includes(MODE_KEY));
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('with Live refused: a saved Live connection cannot be created, from the form or a preset, and nothing is stored', async () => {
  for (const body of [liveBody, workerConn({ offline: false }), { ...workerConn({ offline: false }), auth: 'interactive', redirectUri: `${s.origin.replace('127.0.0.1', 'localhost')}/api/oauth/callback` }]) {
    const r = await s.call('POST', '/api/connections', body);
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error, 'live_refused'); assert.deepEqual(r.json.failed, ['owner-opt-in']);
  }
  for (const id of ['banking', 'opensearch', 'pingone']) assert.equal((await s.call('POST', `/api/presets/${id}`)).status, 403, id);
  for (const id of ['nope', '__proto__', 'constructor', 'toString']) { const r = await s.call('POST', `/api/presets/${id}`); assert.equal(r.status, 404, id); assert.equal(r.json.error, 'unknown_preset', id); }
  assert.equal(s.app.locals.store.list().length, 0);
});

test('with Live refused: a Live connection already in the file is refused on every route before any request is made', async () => {
  const c = s.app.locals.store.create({ kind: 'custom', url: `${s.mock.base}/mcp/${ENV_ID}`, label: 'saved earlier' });
  const calls = [['GET', 'tools'], ['POST', 'test'], ['POST', 'scan'], ['POST', 'call', { tool: 'listUsers' }], ['POST', 'rpc', { method: 'tools/list' }], ['POST', 'login/start']];
  for (const [m, p, b] of calls) {
    const r = await s.call(m, `/api/connections/${c.id}/${p}`, m === 'GET' ? undefined : (b ?? {}));
    assert.equal(r.status, 403, `${p}: ${r.text}`); assert.equal(r.json.error, 'live_refused', p);
  }
  assert.equal(s.mock.config.calls.length, 0, 'the stub saw no call');
  // Local-only routes stay available so an owner can always lock down and clean up: no request leaves the machine.
  assert.equal((await s.call('POST', `/api/connections/${c.id}/settings`, { allowWrites: false })).status, 200);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/logout`)).status, 200);
  assert.equal((await s.call('DELETE', `/api/connections/${c.id}`)).status, 200);
  assert.equal(s.app.locals.store.list().length, 0);
});

test('with Live refused: the Mock demo works in full (tools, call, scan, audit), with zero outbound attempts', async () => {
  const r = await s.call('POST', '/api/connections', workerConn({ offline: true, clientId: 'admin-demo' }));
  assert.equal(r.status, 201, r.text);
  const id = r.json.id;
  assert.equal((await s.call('POST', `/api/connections/${id}/test`)).json.ok, true);
  const tools = (await s.call('GET', `/api/connections/${id}/tools`)).json;
  assert.ok(tools.count > 10);
  assert.equal((await s.call('POST', `/api/connections/${id}/call`, { tool: 'listUsers', arguments: { environmentId: ENV_ID } })).status, 200);
  assert.equal((await s.call('POST', `/api/connections/${id}/scan`)).status, 200);
  assert.ok((await s.call('GET', '/api/audit')).json.entries.length >= 1);
  assert.deepEqual(guard.attempts, []);
});

test('the guards: Live needs the owner opt-in and a loopback bind (or the container opt-in)', () => {
  assert.deepEqual(liveGuards({}).map((g) => [g.id, g.ok]), [['owner-opt-in', false], ['loopback-bind', true]]);
  assert.equal(liveRefusal({ [MODE_KEY]: 'live' }), null);
  assert.deepEqual(liveRefusal({ [MODE_KEY]: 'live', P1MCP_BIND: '0.0.0.0', P1MCP_CONTAINER: '1' }), null, 'the container sets both and is published on loopback only');
  assert.deepEqual(liveRefusal({ [MODE_KEY]: 'live', P1MCP_BIND: '127.0.0.1' }), null, 'an explicit loopback bind is fine on a host');
  for (const bind of ['0.0.0.0', '::', '192.0.2.1']) assert.deepEqual(liveRefusal({ [MODE_KEY]: 'live', P1MCP_BIND: bind })?.failed, ['loopback-bind'], `a host run bound to ${bind} is refused for Live`);
  assert.deepEqual(liveRefusal({ [MODE_KEY]: 'live', P1MCP_BIND: '0.0.0.0', P1MCP_CONTAINER: '0' })?.failed, ['loopback-bind'], 'only the exact marker 1 counts');
  assert.deepEqual(liveRefusal({ [MODE_KEY]: 'live', P1MCP_CONTAINER: '1' }), null, 'the marker without a wide bind changes nothing');
  assert.deepEqual(liveRefusal({ [MODE_KEY]: 'mock' }).failed, ['owner-opt-in']);
  assert.deepEqual(liveRefusal({ MODE: 'live' }).failed, ['owner-opt-in'], 'a bare MODE is never read');
});

test('with Live refused: the OAuth callback of a saved Live connection is refused before any token request, and sends nothing', async () => {
  const port = new URL(s.origin).port;
  const redirectUri = `http://localhost:${port}/api/oauth/callback`;
  const c = s.app.locals.store.create({ kind: 'pingone', region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'live-app', redirectUri });
  const { state } = s.app.locals.auth.startLogin(c);
  const before = guard.attempts.length;
  const cb = await fetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=abc`, { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /login=error&reason=live_refused/);
  assert.equal(guard.attempts.length, before, 'no request to the authorization server was attempted');
  s.app.locals.store.remove(c.id);
});

test('modeFrom: mock by default, live only when asked, anything else is an error, a bare MODE is ignored', () => {
  assert.equal(modeFrom({}), 'mock'); assert.equal(modeFrom({ [MODE_KEY]: '' }), 'mock');
  assert.equal(modeFrom({ [MODE_KEY]: 'live' }), 'live');
  assert.throws(() => modeFrom({ [MODE_KEY]: 'hosted' }), /not a mode/);
  assert.equal(modeFrom({ MODE: 'live' }), 'mock');
});

test('the shared settings file: only the listed keys are taken, nothing else enters the environment, no file means defaults', () => {
  const dir = tmpDir(); const file = path.join(dir, '.env');
  fs.writeFileSync(file, `${MODE_KEY}=live\nPINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_REGION=eu\nPINGONE_CLIENT_SECRET=do-not-take\nMODE=live\nPORT=1\nOTHER_APP_KEY=x\n`, { mode: 0o600 });
  assert.deepEqual(SETTINGS_KEYS.sort(), ['PINGONE_ENVIRONMENT_ID', 'PINGONE_MCP_INSPECTOR_MODE', 'PINGONE_REGION']);
  assert.deepEqual(Object.keys(readSharedSettings(file)).sort(), SETTINGS_KEYS);
  const env = applySharedSettings({ PINGONE_REGION: 'asia' }, file);
  assert.equal(env.PINGONE_REGION, 'asia', 'the environment wins over the file');
  assert.equal(env[MODE_KEY], 'live');
  for (const k of ['PINGONE_CLIENT_SECRET', 'MODE', 'PORT', 'OTHER_APP_KEY']) assert.equal(env[k], undefined, k);
  assert.deepEqual(readSharedSettings(path.join(dir, 'missing')), {});
  assert.deepEqual(applySharedSettings({ STANDALONE_ENV: path.join(dir, 'missing') }), { STANDALONE_ENV: path.join(dir, 'missing') });
});

test('the shared settings file can supply the PingOne preset with an environment id and region, never a client id or secret', async () => {
  const dir = tmpDir(); const file = path.join(dir, 'worker.env');
  fs.writeFileSync(file, 'PINGONE_CLIENT_ID=worker-1\nPINGONE_CLIENT_SECRET=sentinel-secret-xyz\n', { mode: 0o600 });
  const t = await startApp({ env: { P1MCP_WORKER_ENV_FILE: file, PINGONE_ENVIRONMENT_ID: ENV_ID, PINGONE_REGION: 'eu' } });
  try {
    const r = await t.call('POST', '/api/presets/pingone');
    assert.equal(r.status, 201, r.text); assert.equal(r.json.envId, ENV_ID); assert.equal(r.json.region, 'eu'); assert.equal(r.json.clientSecret, 'set');
    assert.ok(!r.text.includes('sentinel-secret-xyz'));
  } finally { await t.close(); }
});

test('an unknown route and a malformed body answer JSON, never an HTML error page that echoes the path', async () => {
  // (A GET outside /api serves the built page when web/dist exists, so the unknown routes here are under /api, or not a GET.)
  const r = await s.call('GET', '/api/nothing/<script>');
  assert.equal(r.status, 404); assert.equal(r.json.error, 'not_found'); assert.ok(!r.text.includes('script'));
  const p = await s.call('POST', '/nothing/<script>', {});
  assert.equal(p.status, 404); assert.equal(p.json.error, 'not_found'); assert.ok(!p.text.includes('script'));
  const res = await fetch(`${s.origin}/api/connections`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.origin }, body: '{bad' });
  assert.equal(res.status, 400); assert.equal((await res.json()).error, 'bad_request');
});

test('a connection id is looked up as an own key: __proto__ and constructor are not connections', async () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const r = await s.call('GET', `/api/connections/${id}/tools`);
    assert.equal(r.status, 404, id); assert.equal(r.json.error, 'not_found');
  }
});

// Rule 19: the Mock/Real toggle.
test('POST /api/mode: a refused switch is a 409 with a reason; a bad body is a 400', async () => {
  const r = await s.call('POST', '/api/mode', { source: 'real' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'real_not_available');
  assert.match(r.json.message, /Live is refused/);
  const bad = await s.call('POST', '/api/mode', { source: 'live' });
  assert.equal(bad.status, 400);
  assert.equal((await s.call('POST', '/api/mode', {})).status, 400);
  const info = await s.call('GET', '/api/info');
  assert.equal(info.json.source, 'mock', 'a refused switch changes nothing');
  assert.equal(info.json.realAvailable, false);
  assert.match(info.json.realReason, /Live is refused/);
});
