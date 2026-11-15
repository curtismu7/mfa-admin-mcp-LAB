import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { assertBindAllowed } from '../src/security.js';
import { MOCK_LOGIN } from '../src/mock.js';
import { addSignedIn, ENV_ID, mockConn, signIn, startApp } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
let s;
before(async () => { s = await startApp(); });
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const add = (o) => addSignedIn(s, o); // an offline PingOne connection, signed in through the mock pi.flow (mock.admin unless o.user says)
const create = async (o) => { const r = await s.call('POST', '/api/connections', mockConn(o)); assert.equal(r.status, 201, r.text); return r.json; };
const writes = (id, on = true) => s.call('POST', `/api/connections/${id}/settings`, { allowWrites: on });

test('health is demo-health/1 exactly, public, no-store', async () => {
  const r = await s.call('GET', '/api/health');
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(r.json).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
  assert.equal(r.json.schema, 'demo-health/1'); assert.ok(['ready', 'needs-setup', 'broken', 'unknown'].includes(r.json.state));
  assert.deepEqual(Object.keys(r.json.demo).sort(), ['id', 'name', 'version']);
  assert.equal((await s.call('POST', '/api/health', {})).status, 405);
});
test('connections: region is an allowlist (opt-in for others) and a non-loopback redirectUri is refused at create (none at all is fine)', async () => {
  assert.equal((await s.call('POST', '/api/connections', mockConn({ region: 'com.xyz' }))).status, 400);
  assert.equal((await s.call('POST', '/api/connections', mockConn({ region: 'com.xyz', regionOther: true }))).status, 201);
  assert.equal((await s.call('POST', '/api/connections', mockConn({ region: 'eu' }))).status, 201);
  const inter = (redirectUri) => mockConn({ redirectUri });
  assert.equal((await s.call('POST', '/api/connections', inter('http://evil.com/api/oauth/callback'))).status, 400);
  assert.equal((await s.call('POST', '/api/connections', inter('http://localhost:7815/api/oauth/callback'))).status, 201);
  assert.equal((await s.call('POST', '/api/connections', inter(undefined))).status, 201);
});
test('login hint: set at create or later through settings, trimmed, cleared by an empty value, validated, and echoed by login/start', async () => {
  const c = await add({ loginHint: '  admin.user  ' });
  assert.equal(c.loginHint, 'admin.user');
  const start = await s.call('POST', `/api/connections/${c.id}/login/start`, {});
  assert.equal(start.json.usernameHint, 'admin.user');
  const set = (v) => s.call('POST', `/api/connections/${c.id}/settings`, { loginHint: v });
  assert.equal((await set('other@example.invalid')).json.loginHint, 'other@example.invalid');
  assert.equal((await set('')).json.loginHint, undefined, 'an empty value clears it');
  for (const bad of ['x'.repeat(257), 'a\nb', 'a\u0000b']) { const r = await set(bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.json.error, 'bad_request'); }
  assert.equal((await s.call('POST', '/api/connections', mockConn({ loginHint: 'a\nb' }))).status, 400);
  const w = (await s.call('POST', '/api/connections', { kind: 'custom', label: 'plain', url: 'http://127.0.0.1:9/mcp' })).json; // a custom server has no sign-in, so a hint is not stored
  assert.equal((await s.call('POST', `/api/connections/${w.id}/settings`, { loginHint: 'x' })).json.loginHint, undefined);
});
test('connections: validation, secrets write-only, file mode 600 in a 700 dir', async () => {
  assert.equal((await s.call('POST', '/api/connections', { kind: 'pingone', envId: 'nope', clientId: 'x' })).status, 400);
  assert.equal((await s.call('POST', '/api/connections', mockConn({ clientId: '' }))).status, 400);
  assert.equal((await s.call('POST', '/api/connections', { kind: 'custom', url: 'http://u:p@127.0.0.1/mcp' })).status, 400);
  const c = await create();
  assert.equal(c.auth, 'interactive'); assert.equal(c.allowWrites, false); assert.equal('clientSecret' in c, false, 'a PingOne connection holds no secret');
  assert.equal(fs.statSync(path.join(s.dir, 'connections.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  const cu = await s.call('POST', '/api/connections', { kind: 'custom', url: `${s.mock.base}/mcp/${ENV_ID}?k=SENTINEL-QUERY`, authHeader: 'Authorization', token: 'SENTINEL-CUSTOM-TOKEN' });
  assert.equal(cu.json.token, 'set'); assert.ok(!cu.text.includes('SENTINEL-CUSTOM-TOKEN') && !cu.text.includes('SENTINEL-QUERY'));
});
test('a PingOne connection with a worker (client_credentials) or a client secret is refused at create, says why, echoes nothing and stores nothing', async () => {
  const SEC = 'SENTINEL-REFUSED-WORKER-SECRET-3';
  const before = s.app.locals.store.list().length;
  for (const body of [mockConn({ auth: 'worker' }), mockConn({ clientSecret: SEC }), mockConn({ auth: 'worker', clientSecret: SEC, tokenAuthMethod: 'post' }), mockConn({ offline: false, auth: 'worker', clientSecret: SEC })]) {
    const r = await s.call('POST', '/api/connections', body);
    assert.equal(r.status, 400, r.text); assert.equal(r.json.error, 'bad_request');
    assert.match(r.json.message, /takes a user sign-in/); assert.match(r.json.message, /not a worker/);
    assert.ok(!r.text.includes(SEC));
  }
  assert.equal(s.app.locals.store.list().length, before, 'nothing was saved');
  assert.ok(!fs.readFileSync(path.join(s.dir, 'connections.json'), 'utf8').includes(SEC));
});
test('a new PingOne connection is interactive and defaults to the documented mcp-host endpoint; api stays selectable', async () => {
  const d = await create({ auth: undefined });
  assert.equal(d.auth, 'interactive'); assert.equal(d.endpointStyle, 'mcp-host');
  assert.equal((await create({ endpointStyle: 'api' })).endpointStyle, 'api');
  assert.equal((await create({ endpointStyle: 'nonsense' })).endpointStyle, 'mcp-host');
});
test('test connection: returns the tools it counted (name and class, sorted) and the totals match them', async () => {
  const admin = await add({ clientId: 'admin-app' });
  const r = (await s.call('POST', `/api/connections/${admin.id}/test`)).json;
  assert.equal(r.ok, true);
  assert.equal(r.tools.length, r.toolCount);
  assert.deepEqual(r.tools.map((t) => t.name), [...r.tools.map((t) => t.name)].sort((a, b) => a.localeCompare(b)));
  for (const cls of ['read', 'write', 'destructive']) assert.equal(r.tools.filter((t) => t.class === cls).length, r.byClass[cls], cls);
  assert.deepEqual(Object.keys(r.tools[0]).sort(), ['class', 'classSource', 'name'], 'only what the dialog shows');
  assert.equal(r.tools.find((t) => t.name === 'deleteUser').class, 'destructive');
});
test('tools list: classification and area grouping; the role comes from the signed-in mock account (viewer: the 18 read tools; admin: all 33); SSE mode', async () => {
  const admin = await add(); const viewer = await add({ user: MOCK_LOGIN.viewer });
  const a = (await s.call('GET', `/api/connections/${admin.id}/tools`)).json;
  const v = (await s.call('GET', `/api/connections/${viewer.id}/tools`)).json;
  assert.equal(v.count, 18); assert.equal(v.byClass.read, 18); assert.equal(v.byClass.write + v.byClass.destructive, 0);
  assert.equal(a.count, 33); assert.equal(a.byClass.read, v.count, 'the viewer sees exactly the read tools the admin sees');
  assert.ok(a.byClass.destructive >= 3 && a.byClass.write > 5);
  assert.ok(a.areas.user.includes('deleteUser') && a.areas.application.includes('listApplications'));
  assert.equal(a.tools.find((t) => t.name === 'syncTenantWidgets').class, 'write');
  s.mock.config.sse = true;
  assert.equal((await s.call('GET', `/api/connections/${admin.id}/tools`)).json.count, a.count);
  s.mock.config.sse = false;
});
test('health card: count, fixture label, short-list hint only for a short list', async () => {
  const admin = await add(); const viewer = await add({ user: MOCK_LOGIN.viewer });
  const ra = (await s.call('POST', `/api/connections/${admin.id}/test`)).json; const rv = (await s.call('POST', `/api/connections/${viewer.id}/test`)).json;
  assert.equal(ra.ok, true); assert.equal(ra.fixture, 'illustrative sample, not a recording');
  assert.match(rv.hint, /missing admin roles/); assert.match(rv.hint, /not verified/); assert.match(rv.expectedNote, /UNVERIFIED/); assert.match(rv.expectedNote, /signed-in user/);
  assert.doesNotMatch(JSON.stringify([ra, rv]), /worker/i, 'no note talks about a worker');
  const unsigned = await create();
  const rb = await s.call('POST', `/api/connections/${unsigned.id}/test`);
  assert.equal(rb.status, 401); assert.equal(rb.json.error, 'login_required');
});
test('writes are blocked by default and audited; reads run', async () => {
  const c = await add();
  const r = await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: { environmentId: ENV_ID, username: 'x' } });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'writes_disabled');
  assert.equal(s.mock.config.calls.some((x) => x.name === 'createUser'), false, 'the server never saw it');
  const ok = await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'listUsers', arguments: { environmentId: ENV_ID } });
  assert.equal(ok.status, 200); assert.equal(ok.json.class, 'read'); assert.ok(ok.json.result.content);
  const audit = (await s.call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.tool === 'createUser' && e.outcome === 'blocked:writes_disabled'));
  assert.ok(audit.some((e) => e.tool === 'listUsers' && e.outcome === 'ok'));
});
test('confirm gate: needs confirm, exact argsHash, typed name for destructive', async () => {
  const c = await add(); await writes(c.id);
  const url = `/api/connections/${c.id}/call`;
  const args = { environmentId: ENV_ID, username: 'newbie' };
  const first = await s.call('POST', url, { tool: 'createUser', arguments: args });
  assert.equal(first.status, 409); assert.equal(first.json.error, 'confirm_required'); assert.deepEqual(first.json.arguments, args);
  const hash = first.json.argsHash;
  assert.equal((await s.call('POST', url, { tool: 'createUser', arguments: { ...args, username: 'changed' }, confirm: true, argsHash: hash })).json.error, 'args_hash_mismatch');
  assert.equal((await s.call('POST', url, { tool: 'createUser', arguments: args, confirm: true, argsHash: 'deadbeef' })).json.error, 'args_hash_mismatch');
  assert.equal((await s.call('POST', url, { tool: 'createUser', arguments: args, confirm: 'yes', argsHash: hash })).json.error, 'confirm_required');
  assert.equal(s.mock.config.calls.some((x) => x.name === 'createUser'), false);
  const done = await s.call('POST', url, { tool: 'createUser', arguments: args, confirm: true, argsHash: hash });
  assert.equal(done.status, 200); assert.equal(s.mock.config.calls.filter((x) => x.name === 'createUser').length, 1);
  // a hash is bound to the connection: another connection cannot reuse it
  const other = await add(); await writes(other.id);
  assert.equal((await s.call('POST', `/api/connections/${other.id}/call`, { tool: 'createUser', arguments: args, confirm: true, argsHash: hash })).json.error, 'args_hash_mismatch');
  // destructive
  const dArgs = { environmentId: ENV_ID, userId: 'u2' };
  const d1 = await s.call('POST', url, { tool: 'deleteUser', arguments: dArgs });
  assert.equal(d1.json.requiresTypedName, true);
  assert.equal((await s.call('POST', url, { tool: 'deleteUser', arguments: dArgs, confirm: true, argsHash: d1.json.argsHash })).json.error, 'typed_name_required');
  assert.equal((await s.call('POST', url, { tool: 'deleteUser', arguments: dArgs, confirm: true, argsHash: d1.json.argsHash, typedName: 'deleteuser' })).json.error, 'typed_name_required');
  assert.equal(s.mock.tenant.users.some((u) => u.id === 'u2'), true);
  const d2 = await s.call('POST', url, { tool: 'deleteUser', arguments: dArgs, confirm: true, argsHash: d1.json.argsHash, typedName: 'deleteUser' });
  assert.equal(d2.status, 200); assert.equal(s.mock.tenant.users.some((u) => u.id === 'u2'), false);
});
test('a tool the identity cannot see is refused; wrong-case params warn', async () => {
  const v = await add({ user: MOCK_LOGIN.viewer }); await writes(v.id);
  assert.equal((await s.call('POST', `/api/connections/${v.id}/call`, { tool: 'deleteUser', arguments: {} })).json.error, 'tool_not_listed');
  const r = await s.call('POST', `/api/connections/${v.id}/call`, { tool: 'listUsers', arguments: { environment_id: ENV_ID } });
  assert.ok(r.json.warnings.some((w) => w.kind === 'snake_case' && /environmentId/.test(w.message)));
});
test('raw console: free methods pass, others refused, tools/call goes through the gate', async () => {
  const c = await add(); const url = `/api/connections/${c.id}/rpc`;
  assert.ok((await s.call('POST', url, { method: 'tools/list' })).json.result.tools.length > 10);
  assert.deepEqual((await s.call('POST', url, { method: 'resources/list' })).json.result, { resources: [] });
  assert.equal((await s.call('POST', url, { method: 'sampling/createMessage' })).status, 403);
  assert.equal((await s.call('POST', url, { method: 'tools/call', params: { name: 'createUser', arguments: {} } })).json.error, 'writes_disabled');
  assert.equal((await s.call('POST', url, { method: 'tools/call', params: { name: 'listUsers', arguments: { environmentId: ENV_ID } } })).status, 200);
});
test('401 from the server mid-session: the token is renewed and the call retried', async () => {
  const c = await add(); const url = `/api/connections/${c.id}/call`;
  await s.call('POST', url, { tool: 'listUsers', arguments: {} });
  s.mock.tokens.clear();
  assert.equal((await s.call('POST', url, { tool: 'listUsers', arguments: {} })).status, 200);
});
test('interactive login over HTTP (pi.flow): start is same-origin only, the steps run once each, bad input is refused, logout clears', async () => {
  const c = await create();
  assert.ok(!c.redirectUri, 'no redirect URI is needed');
  const bad = await s.call('POST', `/api/connections/${c.id}/login/start`, {}, { origin: 'http://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal((await s.call('GET', `/api/connections/${c.id}/tools`)).json.error, 'login_required');
  const custom = (await s.call('POST', '/api/connections', { kind: 'custom', url: `${s.mock.base}/mcp/${ENV_ID}` })).json;
  assert.equal((await s.call('POST', `/api/connections/${custom.id}/login/start`, {})).json.error, 'not_interactive');
  const start = await s.call('POST', `/api/connections/${c.id}/login/start`, {});
  assert.equal(start.status, 200, start.text);
  assert.equal(start.json.step, 'password'); assert.ok(start.json.loginId);
  assert.equal(start.json.authorizeUrl, undefined, 'no redirect URL is handed to the browser');
  assert.deepEqual(Object.keys(start.json.mockLogin).sort(), ['otp', 'password', 'username', 'viewer'], 'the mock connection says which mock accounts to use');
  assert.equal(start.json.mockLogin.viewer, 'mock.viewer');
  const step = (b, id = c.id) => s.call('POST', `/api/connections/${id}/login/step`, { loginId: start.json.loginId, ...b });
  for (const malformed of [{}, { action: 'nope' }, { action: 'password', username: 'u' }, { action: 'password', username: 'u', password: 'x'.repeat(2000) }, { action: 'otp', otp: '12' }, { action: 'otp', otp: 123456 }, { action: 'device', deviceId: '../x' }]) {
    const r = await step(malformed); assert.equal(r.status, 400, JSON.stringify(malformed)); assert.equal(r.json.error, 'bad_request');
  }
  assert.equal((await s.call('POST', `/api/connections/${c.id}/login/step`, { action: 'otp', otp: '123456', loginId: 'forged' })).json.error, 'login_expired');
  const wrong = await step({ action: 'password', username: start.json.mockLogin.username, password: 'wrong' });
  assert.equal(wrong.status, 401); assert.equal(wrong.json.error, 'invalid_credentials'); assert.ok(!wrong.text.includes('wrong'));
  assert.equal((await step({ action: 'password', username: start.json.mockLogin.username, password: start.json.mockLogin.password })).json.step, 'otp');
  assert.equal((await step({ action: 'otp', otp: '000000' })).json.error, 'invalid_otp');
  assert.equal((await step({ action: 'otp', otp: start.json.mockLogin.otp })).json.step, 'done');
  const view = (await s.call('GET', '/api/connections')).json.connections.find((x) => x.id === c.id);
  assert.equal(view.auth_status.signedIn, true); assert.equal(view.auth_status.as, 'mock-admin-user'); assert.ok(view.auth_status.expiresAt);
  assert.equal((await s.call('GET', `/api/connections/${c.id}/tools`)).status, 200);
  assert.equal((await step({ action: 'otp', otp: start.json.mockLogin.otp })).json.error, 'login_expired', 'a finished sign-in cannot be replayed');
  await s.call('POST', `/api/connections/${c.id}/logout`, {});
  assert.equal((await s.call('GET', `/api/connections/${c.id}/tools`)).json.error, 'login_required');
});
test('secrets never appear in responses, console output, the audit log or errors (sentinels)', async () => {
  const SEC = 'SENTINEL-ZZ-REFUSED-SECRET-9'; const TOK = 'SENTINEL-ZZ-CUSTOM-TOKEN-9';
  const seen = []; const origWrite = process.stdout.write; const errWrite = process.stderr.write;
  process.stdout.write = (c, ...r) => { seen.push(String(c)); return origWrite.call(process.stdout, c, ...r); };
  process.stderr.write = (c, ...r) => { seen.push(String(c)); return errWrite.call(process.stderr, c, ...r); };
  const out = [];
  try {
    out.push((await s.call('POST', '/api/connections', mockConn({ clientSecret: SEC }))).text); // refused, without the secret
    const c = await add(); await writes(c.id);
    const AT = [...s.mock.tokens.keys()].at(-1); // the access token just issued to c: the tool result below echoes it back
    const cu = (await s.call('POST', '/api/connections', { kind: 'custom', url: `${s.mock.base}/mcp/${ENV_ID}`, token: TOK })).json; // 401 upstream: an error path
    out.push(JSON.stringify(c), JSON.stringify(cu));
    for (const r of [
      await s.call('GET', '/api/connections'), await s.call('GET', `/api/connections/${c.id}/tools`), await s.call('POST', `/api/connections/${c.id}/test`),
      await s.call('GET', `/api/connections/${cu.id}/tools`), await s.call('POST', `/api/connections/${cu.id}/test`),
      await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: { environmentId: ENV_ID, username: AT } }),
      await s.call('POST', `/api/connections/nope/call`, {}), await s.call('POST', `/api/connections/${c.id}/call`, { tool: 123 }),
    ]) out.push(r.text);
    const h = (await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: { environmentId: ENV_ID, username: AT, clientSecret: 'x' } })).json;
    const done = await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: { environmentId: ENV_ID, username: AT }, confirm: true, argsHash: (await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: { environmentId: ENV_ID, username: AT } })).json.argsHash });
    assert.equal(done.status, 200); out.push(done.text, JSON.stringify(h));
    out.push((await s.call('GET', '/api/audit')).text, fs.readFileSync(path.join(s.dir, 'audit.jsonl'), 'utf8'), fs.readFileSync(path.join(s.dir, 'connections.json'), 'utf8').replaceAll(SEC, '').replaceAll(TOK, ''));
  } finally { process.stdout.write = origWrite; process.stderr.write = errWrite; }
  const all = [...out, ...seen].join('\n');
  for (const needle of [SEC, TOK, ...s.mock.tokens.keys(), ...s.mock.refreshes.keys()]) assert.ok(!all.includes(needle), `leaked ${needle.slice(0, 18)}`);
  assert.ok(all.includes('[redacted]'), 'the echoed token in the tool result was replaced');
  assert.equal(fs.statSync(path.join(s.dir, 'audit.jsonl')).mode & 0o777, 0o600);
});
test('guards: bad Host refused, cross-origin and missing-origin writes refused, non-loopback bind refused', async () => {
  const badStatus = await new Promise((resolve, reject) => { const q = http.request(`${s.origin}/api/connections`, { headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }); q.on('error', reject); q.end(); });
  assert.equal(badStatus, 403);
  assert.equal((await s.call('POST', '/api/connections', mockConn(), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.call('POST', '/api/connections', mockConn(), { origin: null })).status, 403);
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /refusing to bind/);
  assert.equal(assertBindAllowed('0.0.0.0', { MFAADM_BIND: '0.0.0.0' }), '0.0.0.0');
});

test('the role is the signed-in account: signing out and in again as another mock account changes the list; the status carries an expiry but no token; the role route is gone', async () => {
  const c = await add({ user: MOCK_LOGIN.viewer });
  const n = async () => (await s.call('GET', `/api/connections/${c.id}/tools`)).json.count;
  assert.equal(await n(), 18);
  const v = (await s.call('GET', '/api/connections')).json.connections.find((x) => x.id === c.id);
  assert.equal(v.auth_status.signedIn, true); assert.equal(v.auth_status.as, 'mock-viewer-user'); assert.ok(v.auth_status.expiresAt > Date.now());
  assert.ok(!/mock-(at|rt)-/.test(JSON.stringify(v)));
  await s.call('POST', `/api/connections/${c.id}/logout`, {});
  await signIn(s, c.id, MOCK_LOGIN.username);
  assert.equal(await n(), 33);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/role`, { role: 'admin' })).status, 404, 'there is no role switch: the role is whoever signed in');
});

test('a worker connection saved by an older build does not crash the app: it is listed without its secret and every call is refused with a clear message', async () => {
  const file = path.join(s.dir, 'connections.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  all['legacy-worker-1'] = { id: 'legacy-worker-1', kind: 'pingone', label: 'old worker', createdAt: '2026-11-01T00:00:00.000Z', allowWrites: false, offline: true, region: 'com', envId: ENV_ID, auth: 'worker', endpointStyle: 'api', idp: 'pingone', clientId: 'old-worker', clientSecret: 'SENTINEL-LEGACY-SECRET-5', tokenAuthMethod: 'basic' };
  fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
  const list = await s.call('GET', '/api/connections');
  assert.equal(list.status, 200);
  const v = list.json.connections.find((x) => x.id === 'legacy-worker-1');
  assert.equal(v.legacyWorker, true); assert.deepEqual(v.auth_status, { signedIn: false }); assert.equal('clientSecret' in v, false);
  const texts = [list.text];
  for (const [m, p, b] of [['GET', 'tools'], ['POST', 'test'], ['POST', 'scan'], ['POST', 'call', { tool: 'listUsers', arguments: {} }], ['POST', 'rpc', { method: 'tools/list' }], ['POST', 'login/start']]) {
    const r = await s.call(m, `/api/connections/legacy-worker-1/${p}`, m === 'GET' ? undefined : (b ?? {}));
    assert.equal(r.status, 409, `${p}: ${r.text}`); assert.equal(r.json.error, 'worker_unsupported', p); assert.match(r.json.message, /user sign-in/, p);
    texts.push(r.text);
  }
  assert.ok(!texts.join('\n').includes('SENTINEL-LEGACY-SECRET-5'), 'the old secret is never returned');
  assert.equal((await s.call('POST', '/api/connections/legacy-worker-1/settings', { allowWrites: false })).status, 200, 'local routes still work');
  assert.equal((await s.call('DELETE', '/api/connections/legacy-worker-1')).status, 200, 'and it can be deleted');
});

test('the sign-in names the MCP server as the resource (RFC 8707) on the authorize and the code redemption', async () => {
  s.mock.config.resources.length = 0;
  await add();
  assert.deepEqual(s.mock.config.resources, [{ at: 'authorize', resource: `${s.mock.base}/mcp/${ENV_ID}` }, { at: 'authorization_code', resource: `${s.mock.base}/mcp/${ENV_ID}` }]);
});

test('GET /api/health turns needs-setup into ready as soon as a connection exists (no 60 s wait)', async () => {
  const h = await startApp();
  try {
    assert.equal((await h.call('GET', '/api/health')).json.state, 'needs-setup');
    const c = (await h.call('POST', '/api/connections', mockConn())).json;
    assert.equal((await h.call('GET', '/api/health')).json.state, 'ready');
    await h.call('DELETE', `/api/connections/${c.id}`);
    assert.equal((await h.call('GET', '/api/health')).json.state, 'needs-setup');
  } finally { await h.close(); }
});

test('presets: banking/opensearch create custom connections; there is no PingOne preset (a PingOne connection is a user sign-in)', async () => {
  const t = await startApp({ env: { MFAADM_BANKING_URL: 'http://127.0.0.1:1/mcp' } });
  try {
    const b = await t.call('POST', '/api/presets/banking');
    assert.equal(b.status, 201); assert.equal(b.json.kind, 'custom'); assert.match(b.json.url, /127\.0\.0\.1:1\/mcp/);
    assert.equal((await t.call('POST', '/api/presets/opensearch')).json.url, 'http://localhost:9900/mcp');
    assert.equal((await t.call('POST', '/api/presets/nope')).status, 404);
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) { const r = await t.call('POST', `/api/presets/${id}`); assert.equal(r.status, 404, id); assert.equal(r.json.error, 'unknown_preset', id); }
    const gone = await t.call('POST', '/api/presets/pingone');
    assert.equal(gone.status, 404); assert.equal(gone.json.error, 'unknown_preset');
  } finally { await t.close(); }
});
test('preset defaults: neutral labels, and no port the rulebook reserves for other tools', async () => {
  const t = await startApp({ env: {} });
  try {
    for (const id of ['banking', 'opensearch']) {
      const r = (await t.call('POST', `/api/presets/${id}`)).json;
      assert.doesNotMatch(r.label, /AI-DEMO/i, id);
      assert.doesNotMatch(r.url, /:(8080|5173|3000|3900|4000|4400|4510|460[01]|18080|19080|19090)\//, `${id} default port`);
    }
    const b = (await t.call('POST', '/api/presets/banking')).json;
    assert.equal(b.url, 'http://localhost:8081/mcp');
    assert.equal(b.token, 'set', 'the banking preset carries a token (the family banking MCP is bearer-token only)');
  } finally { await t.close(); }
});
test('a typed server URL must be https (http only on loopback), carry no credentials and not be a literal private address', async () => {
  const post = (url) => s.call('POST', '/api/connections', { kind: 'custom', url });
  assert.equal((await post('http://mcp.example/mcp')).status, 400);
  assert.equal((await post('http://203.0.113.9/mcp')).status, 400);
  for (const u of ['https://10.0.0.5/mcp', 'https://192.168.1.2/mcp', 'https://172.16.0.1/mcp', 'https://169.254.169.254/latest', 'https://0.0.0.0/mcp', 'https://[fd00::1]/mcp', 'https://[fe80::1]/mcp']) assert.equal((await post(u)).status, 400, u);
  // IPv6 literals that carry an IPv4 address are judged by that address (the URL parser turns [::ffff:10.0.0.1] into [::ffff:a00:1]).
  for (const u of ['https://[::ffff:a9fe:a9fe]/mcp', 'https://[::ffff:10.0.0.1]/mcp', 'https://[::ffff:c0a8:102]/mcp', 'https://[64:ff9b::a00:1]/mcp', 'https://[::ffff:0:a00:1]/mcp', 'https://[::a00:1]/mcp', 'https://[2002:a00:1::]/mcp', 'https://[2001::1]/mcp', 'https://[fec0::1]/mcp', 'https://100.64.0.1/mcp', 'https://100.127.255.254/mcp', 'https://192.0.0.9/mcp', 'https://198.18.0.1/mcp', 'https://198.19.255.254/mcp']) assert.equal((await post(u)).status, 400, u);
  // ...and the public addresses next to those ranges, mapped or not, are still allowed.
  for (const u of ['https://[::ffff:808:808]/mcp', 'https://[64:ff9b::808:808]/mcp', 'https://100.128.0.1/mcp', 'https://192.0.1.1/mcp', 'https://198.20.0.1/mcp', 'https://[2606:4700::1]/mcp']) assert.equal((await post(u)).status, 201, u);
  assert.equal((await post('https://mcp.example/mcp')).status, 201);
  assert.equal((await post('http://localhost:9900/mcp')).status, 201);
  assert.equal((await post('http://127.0.0.1:9900/mcp')).status, 201);
  assert.equal((await post('http://[::1]:9900/mcp')).status, 201);
});
