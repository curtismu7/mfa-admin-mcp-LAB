import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { assertBindAllowed } from '../src/security.js';
import { ENV_ID, startApp, tmpDir, workerConn } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
let s;
before(async () => { s = await startApp(); });
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const add = async (o) => { const r = await s.call('POST', '/api/connections', workerConn(o)); assert.equal(r.status, 201, r.text); return r.json; };
const writes = (id, on = true) => s.call('POST', `/api/connections/${id}/settings`, { allowWrites: on });

test('health is demo-health/1 exactly, public, no-store', async () => {
  const r = await s.call('GET', '/api/health');
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(r.json).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
  assert.equal(r.json.schema, 'demo-health/1'); assert.ok(['ready', 'needs-setup', 'broken', 'unknown'].includes(r.json.state));
  assert.deepEqual(Object.keys(r.json.demo).sort(), ['id', 'name', 'version']);
  assert.equal((await s.call('POST', '/api/health', {})).status, 405);
});
test('connections: region is an allowlist (opt-in for others) and a non-loopback redirectUri is refused at create', async () => {
  assert.equal((await s.call('POST', '/api/connections', workerConn({ region: 'com.xyz' }))).status, 400);
  assert.equal((await s.call('POST', '/api/connections', workerConn({ region: 'com.xyz', regionOther: true }))).status, 201);
  assert.equal((await s.call('POST', '/api/connections', workerConn({ region: 'eu' }))).status, 201);
  const inter = (redirectUri) => ({ ...workerConn(), auth: 'interactive', redirectUri });
  assert.equal((await s.call('POST', '/api/connections', inter('http://evil.com/api/oauth/callback'))).status, 400);
  assert.equal((await s.call('POST', '/api/connections', inter('http://localhost:5201/api/oauth/callback'))).status, 201);
});
test('connections: validation, secrets write-only, file mode 600 in a 700 dir', async () => {
  assert.equal((await s.call('POST', '/api/connections', { kind: 'pingone', envId: 'nope', clientId: 'x', clientSecret: 'y' })).status, 400);
  assert.equal((await s.call('POST', '/api/connections', workerConn({ clientSecret: '' }))).status, 400);
  assert.equal((await s.call('POST', '/api/connections', { kind: 'custom', url: 'http://u:p@127.0.0.1/mcp' })).status, 400);
  const c = await add({ clientSecret: 'SENTINEL-WORKER-SECRET-1' });
  assert.equal(c.clientSecret, 'set'); assert.equal(c.allowWrites, false);
  const list = await s.call('GET', '/api/connections');
  assert.ok(!list.text.includes('SENTINEL-WORKER-SECRET-1'));
  assert.equal(fs.statSync(path.join(s.dir, 'connections.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  const cu = await s.call('POST', '/api/connections', { kind: 'custom', url: `${s.mock.base}/mcp/${ENV_ID}?k=SENTINEL-QUERY`, authHeader: 'Authorization', token: 'SENTINEL-CUSTOM-TOKEN' });
  assert.equal(cu.json.token, 'set'); assert.ok(!cu.text.includes('SENTINEL-CUSTOM-TOKEN') && !cu.text.includes('SENTINEL-QUERY'));
});
test('tools list: classification and area grouping; viewer vs admin roles; SSE mode', async () => {
  const admin = await add({ clientId: 'admin-app' }); const viewer = await add({ clientId: 'viewer-app' });
  const a = (await s.call('GET', `/api/connections/${admin.id}/tools`)).json;
  const v = (await s.call('GET', `/api/connections/${viewer.id}/tools`)).json;
  assert.ok(v.count < a.count); assert.equal(v.byClass.write + v.byClass.destructive, 0);
  assert.ok(a.byClass.destructive >= 3 && a.byClass.write > 5);
  assert.ok(a.areas.user.includes('deleteUser') && a.areas.application.includes('listApplications'));
  assert.equal(a.tools.find((t) => t.name === 'syncTenantWidgets').class, 'write');
  s.mock.config.sse = true;
  assert.equal((await s.call('GET', `/api/connections/${admin.id}/tools`)).json.count, a.count);
  s.mock.config.sse = false;
});
test('health card: count, fixture label, short-list hint only for a short list', async () => {
  const admin = await add({ clientId: 'admin-app' }); const viewer = await add({ clientId: 'viewer-app' });
  const ra = (await s.call('POST', `/api/connections/${admin.id}/test`)).json; const rv = (await s.call('POST', `/api/connections/${viewer.id}/test`)).json;
  assert.equal(ra.ok, true); assert.equal(ra.fixture, 'illustrative sample, not a recording');
  assert.match(rv.hint, /missing admin roles/); assert.match(rv.hint, /not verified/); assert.match(rv.expectedNote, /UNVERIFIED/);
  s.mock.clients.set('strict', { secret: 'right', role: 'admin' });
  const bad = await add({ clientId: 'strict', clientSecret: 'SENTINEL-BAD-SECRET' });
  const rb = (await s.call('POST', `/api/connections/${bad.id}/test`)).json;
  assert.equal(rb.ok, false); assert.ok(!JSON.stringify(rb).includes('SENTINEL-BAD-SECRET'));
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
  const v = await add({ clientId: 'viewer-app' }); await writes(v.id);
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
test('interactive login over HTTP: start is same-origin only, callback lands once, logout clears', async () => {
  const port = new URL(s.origin).port;
  const redirectUri = `http://localhost:${port}/api/oauth/callback`;
  const c = await add({ auth: 'interactive', clientSecret: undefined, redirectUri });
  const bad = await s.call('POST', `/api/connections/${c.id}/login/start`, {}, { origin: 'http://evil.example' });
  assert.equal(bad.status, 403);
  const wrong = await add({ auth: 'interactive', clientSecret: undefined, redirectUri: 'http://localhost:1/api/oauth/callback' });
  assert.equal((await s.call('POST', `/api/connections/${wrong.id}/login/start`, {})).json.error, 'redirect_uri_invalid');
  assert.equal((await s.call('GET', `/api/connections/${c.id}/tools`)).json.error, 'login_required');
  const start = await s.call('POST', `/api/connections/${c.id}/login/start`, {});
  const authz = await fetch(start.json.authorizeUrl, { redirect: 'manual' });
  const back = new URL(authz.headers.get('location'));
  const cbUrl = `http://localhost:${port}${back.pathname}${back.search}`;
  const cb = await fetch(cbUrl, { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /login=ok/);
  const view = (await s.call('GET', '/api/connections')).json.connections.find((x) => x.id === c.id);
  assert.equal(view.auth_status.signedIn, true); assert.equal(view.auth_status.as, 'mock-admin-user'); assert.ok(view.auth_status.expiresAt);
  assert.equal((await s.call('GET', `/api/connections/${c.id}/tools`)).status, 200);
  const replay = await fetch(cbUrl, { redirect: 'manual' });
  assert.match(replay.headers.get('location'), /login=error&reason=bad_state/);
  await s.call('POST', `/api/connections/${c.id}/logout`, {});
  assert.equal((await s.call('GET', `/api/connections/${c.id}/tools`)).json.error, 'login_required');
});
test('secrets never appear in responses, console output, the audit log or errors (sentinels)', async () => {
  const SEC = 'SENTINEL-ZZ-WORKER-SECRET-9'; const TOK = 'SENTINEL-ZZ-CUSTOM-TOKEN-9';
  const seen = []; const origWrite = process.stdout.write; const errWrite = process.stderr.write;
  process.stdout.write = (c, ...r) => { seen.push(String(c)); return origWrite.call(process.stdout, c, ...r); };
  process.stderr.write = (c, ...r) => { seen.push(String(c)); return errWrite.call(process.stderr, c, ...r); };
  const out = [];
  try {
    const c = await add({ clientSecret: SEC }); await writes(c.id);
    const cu = (await s.call('POST', '/api/connections', { kind: 'custom', url: `${s.mock.base}/mcp/${ENV_ID}`, token: TOK })).json; // 401 upstream: an error path
    out.push(JSON.stringify(c), JSON.stringify(cu));
    for (const r of [
      await s.call('GET', '/api/connections'), await s.call('GET', `/api/connections/${c.id}/tools`), await s.call('POST', `/api/connections/${c.id}/test`),
      await s.call('GET', `/api/connections/${cu.id}/tools`), await s.call('POST', `/api/connections/${cu.id}/test`),
      await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createApplication', arguments: { environmentId: ENV_ID, name: SEC } }),
      await s.call('POST', `/api/connections/nope/call`, {}), await s.call('POST', `/api/connections/${c.id}/call`, { tool: 123 }),
    ]) out.push(r.text);
    const h = (await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createApplication', arguments: { environmentId: ENV_ID, name: SEC, clientSecret: 'x' } })).json;
    const done = await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createApplication', arguments: { environmentId: ENV_ID, name: SEC }, confirm: true, argsHash: (await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createApplication', arguments: { environmentId: ENV_ID, name: SEC } })).json.argsHash });
    assert.equal(done.status, 200); out.push(done.text, JSON.stringify(h));
    out.push((await s.call('GET', '/api/audit')).text, fs.readFileSync(path.join(s.dir, 'audit.jsonl'), 'utf8'), fs.readFileSync(path.join(s.dir, 'connections.json'), 'utf8').replaceAll(SEC, '').replaceAll(TOK, ''));
  } finally { process.stdout.write = origWrite; process.stderr.write = errWrite; }
  const all = [...out, ...seen].join('\n');
  for (const needle of [SEC, TOK, ...s.mock.tokens.keys(), ...s.mock.refreshes.keys()]) assert.ok(!all.includes(needle), `leaked ${needle.slice(0, 18)}`);
  assert.ok(all.includes('[redacted]'), 'the echoed secret in the tool result was replaced');
  assert.equal(fs.statSync(path.join(s.dir, 'audit.jsonl')).mode & 0o777, 0o600);
});
test('guards: bad Host refused, cross-origin and missing-origin writes refused, non-loopback bind refused', async () => {
  const badStatus = await new Promise((resolve, reject) => { const q = http.request(`${s.origin}/api/connections`, { headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }); q.on('error', reject); q.end(); });
  assert.equal(badStatus, 403);
  assert.equal((await s.call('POST', '/api/connections', workerConn(), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.call('POST', '/api/connections', workerConn(), { origin: null })).status, 403);
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /refusing to bind/);
  assert.equal(assertBindAllowed('0.0.0.0', { P1MCP_BIND: '0.0.0.0' }), '0.0.0.0');
});

test('mock role switch changes the tool list and the auth status carries an expiry but no token', async () => {
  const c = await add({ clientId: 'viewer-demo' });
  const n = async () => (await s.call('GET', `/api/connections/${c.id}/tools`)).json.count;
  const viewer = await n();
  const r = await s.call('POST', `/api/connections/${c.id}/role`, { role: 'admin' });
  assert.equal(r.status, 200); assert.equal(r.json.clientId, 'admin-demo');
  assert.ok(await n() > viewer);
  const v = (await s.call('GET', '/api/connections')).json.connections.find((x) => x.id === c.id);
  assert.equal(v.auth_status.token, 'set'); assert.ok(v.auth_status.expiresAt > Date.now());
  assert.ok(!/mock-at-/.test(JSON.stringify(v)));
  assert.equal((await s.call('POST', `/api/connections/${c.id}/role`, { role: 'root' })).status, 400);
});

test('GET /api/health turns needs-setup into ready as soon as a connection exists (no 60 s wait)', async () => {
  const h = await startApp();
  try {
    assert.equal((await h.call('GET', '/api/health')).json.state, 'needs-setup');
    const c = (await h.call('POST', '/api/connections', workerConn())).json;
    assert.equal((await h.call('GET', '/api/health')).json.state, 'ready');
    await h.call('DELETE', `/api/connections/${c.id}`);
    assert.equal((await h.call('GET', '/api/health')).json.state, 'needs-setup');
  } finally { await h.close(); }
});

test('presets: banking/opensearch create custom connections; pingone preset needs a local file and never echoes the secret', async () => {
  const dir = tmpDir(); const file = path.join(dir, 'worker.env');
  const t = await startApp({ env: { P1MCP_WORKER_ENV_FILE: file, P1MCP_BANKING_URL: 'http://127.0.0.1:1/mcp' } });
  try {
    const b = await t.call('POST', '/api/presets/banking');
    assert.equal(b.status, 201); assert.equal(b.json.kind, 'custom'); assert.match(b.json.url, /127\.0\.0\.1:1\/mcp/);
    assert.equal((await t.call('POST', '/api/presets/opensearch')).json.url, 'http://localhost:9900/mcp');
    assert.equal((await t.call('POST', '/api/presets/nope')).status, 404);
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) { const r = await t.call('POST', `/api/presets/${id}`); assert.equal(r.status, 404, id); assert.equal(r.json.error, 'unknown_preset', id); }
    const missing = await t.call('POST', '/api/presets/pingone');
    assert.equal(missing.status, 409); assert.match(missing.json.message, /worker\.env/);
    fs.writeFileSync(file, `PINGONE_ENV_ID=${ENV_ID}\nPINGONE_CLIENT_ID=cid\nPINGONE_CLIENT_SECRET=SENTINEL-SECRET-123\n`);
    const ok = await t.call('POST', '/api/presets/pingone');
    assert.equal(ok.status, 201); assert.equal(ok.json.envId, ENV_ID);
    assert.ok(!ok.text.includes('SENTINEL-SECRET-123'), 'secret never returned');
    assert.ok(!(await t.call('GET', '/api/connections')).text.includes('SENTINEL-SECRET-123'));
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
    assert.equal((await t.call('POST', '/api/presets/banking')).json.url, 'http://localhost:9901/mcp');
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
