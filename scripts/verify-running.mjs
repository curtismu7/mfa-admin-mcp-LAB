#!/usr/bin/env node
// Verifies a RUNNING instance (host-run or container) by content, mock demo only: health contract, the page, the offline
// demo flow through the API, the write gate, the scan, and the interactive native-flow sign-in. Contacts only the base URL you give
// (must be loopback).
//   node scripts/verify-running.mjs http://localhost:5241
import http from 'node:http';

const base = process.argv[2];
if (!base || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) { console.error('usage: verify-running.mjs http://localhost:<port>'); process.exit(2); }
const hostPort = new URL(base).port;
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
async function call(method, p, body) {
  const res = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { ...(method !== 'GET' ? { Origin: base } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const ENV = '11111111-2222-4333-8444-555555555555'; // placeholder, not a tenant

const h = await call('GET', '/api/health');
check(h.status === 200 && h.json?.schema === 'demo-health/1' && ['ready', 'needs-setup'].includes(h.json.state) && h.json.demo?.id === 'mfa-admin-mcp', `health contract demo-health/1 (state ${h.json?.state})`);
const page = await call('GET', '/');
check(page.status === 200 && /<div id="root"/.test(page.text) && /<title>[^<]*PingOne MCP Inspector/.test(page.text), 'the page is the built app (root div and title)');
const bad = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: Number(hostPort), path: '/api/connections', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('error', () => resolve(null)); r.end(); });
check(bad === 403, 'a non-loopback Host header is refused');

// The mock demo is a user sign-in (pi.flow): the tools it lists follow the mock account that signs in, not the client id.
const refused = await call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'verify worker', region: 'com', envId: ENV, auth: 'worker', clientId: 'x', clientSecret: 'demo-secret' });
check(refused.status === 400 && /user sign-in/.test(refused.json?.message) && !refused.text.includes('demo-secret'), 'a worker (client_credentials) PingOne connection is refused, without echoing the secret');
const w = (await call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'verify sign-in', region: 'com', envId: ENV, clientId: 'mock-native-app' })).json;
const signInAs = async (id, username) => {
  const s = (await call('POST', `/api/connections/${id}/login/start`, {})).json;
  await call('POST', `/api/connections/${id}/login/step`, { loginId: s.loginId, action: 'password', username, password: s.mockLogin.password });
  return (await call('POST', `/api/connections/${id}/login/step`, { loginId: s.loginId, action: 'otp', otp: s.mockLogin.otp })).json;
};
await signInAs(w.id, 'mock.viewer');
const viewer = (await call('GET', `/api/connections/${w.id}/tools`)).json;
check(viewer.count === 18 && viewer.byClass.write === 0, `mock.viewer lists ${viewer.count} tools, all read`);
await call('POST', `/api/connections/${w.id}/logout`, {});
await signInAs(w.id, 'mock.admin');
const admin = (await call('GET', `/api/connections/${w.id}/tools`)).json;
check(admin.count === 33 && admin.byClass.write > 0 && admin.byClass.destructive > 0, `mock.admin lists ${admin.count} tools including write and destructive`);
const scan = (await call('POST', `/api/connections/${w.id}/scan`, {})).json;
check(scan.summary?.total === 0, 'scan of the mock is clean');
const read = await call('POST', `/api/connections/${w.id}/call`, { tool: 'listUsers', arguments: { environmentId: ENV } });
check(read.status === 200 && /sample\.user/.test(read.text), 'a read call runs');
const args = { environmentId: ENV, username: 'verify.user' };
const blocked = await call('POST', `/api/connections/${w.id}/call`, { tool: 'createUser', arguments: args });
check(blocked.status === 403 && blocked.json.error === 'writes_disabled', 'a write is blocked while writes are off');
await call('POST', `/api/connections/${w.id}/settings`, { allowWrites: true });
const need = await call('POST', `/api/connections/${w.id}/call`, { tool: 'createUser', arguments: args });
check(need.status === 409 && need.json.error === 'confirm_required' && /^[0-9a-f]{64}$/.test(need.json.argsHash), 'with writes on, the write needs the confirm gate (argsHash shown)');
const wrong = await call('POST', `/api/connections/${w.id}/call`, { tool: 'createUser', arguments: { ...args, username: 'changed' }, confirm: true, argsHash: need.json.argsHash });
check(wrong.status === 409 && wrong.json.error === 'args_hash_mismatch', 'changed arguments invalidate the hash');
const ok = await call('POST', `/api/connections/${w.id}/call`, { tool: 'createUser', arguments: args, confirm: true, argsHash: need.json.argsHash });
check(ok.status === 200 && /verify\.user/.test(ok.text), 'the confirmed write runs (against the in-memory fake tenant)');
const del = await call('POST', `/api/connections/${w.id}/call`, { tool: 'deleteUser', arguments: { environmentId: ENV, userId: 'u2' }, confirm: true, argsHash: (await call('POST', `/api/connections/${w.id}/call`, { tool: 'deleteUser', arguments: { environmentId: ENV, userId: 'u2' } })).json.argsHash });
check(del.status === 409 && del.json.error === 'typed_name_required', 'a destructive call also needs the tool name typed');
const audit = (await call('GET', '/api/audit')).json.entries.map((e) => e.outcome);
check(['blocked:writes_disabled', 'blocked:confirm_required', 'blocked:args_hash_mismatch', 'ok', 'blocked:typed_name_required'].every((o) => audit.includes(o)), 'the audit log recorded the blocked and the allowed calls');

// Interactive: the sign-in is a native flow (pi.flow). The page shows the form and this server drives the steps at the (mock) authorization
// server, so there is no callback, no redirect URI and nothing to register: the run works the same on any published port.
const i = (await call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'verify interactive', region: 'com', envId: ENV, auth: 'interactive', clientId: 'mock-native-app' })).json;
const start = await call('POST', `/api/connections/${i.id}/login/start`, {});
check(start.status === 200 && start.json.step === 'password' && start.json.loginId && start.json.authorizeUrl === undefined, 'login/start opens a native flow and asks for the password (no redirect URL is handed out)');
const m = start.json.mockLogin ?? {};
const step = (b) => call('POST', `/api/connections/${i.id}/login/step`, { loginId: start.json.loginId, ...b });
const badPw = await step({ action: 'password', username: m.username, password: 'not-the-password' });
check(badPw.status === 401 && badPw.json.error === 'invalid_credentials', 'a wrong password is refused and can be retried');
const second = await step({ action: 'password', username: m.username, password: m.password });
check(second.status === 200 && second.json.step === 'otp', 'the right password moves the flow on to the one-time code');
const done = await step({ action: 'otp', otp: m.otp });
check(done.status === 200 && done.json.step === 'done', 'the code completes the sign-in');
const view = (await call('GET', '/api/connections')).json.connections.find((c) => c.id === i.id);
check(view.auth_status?.signedIn === true && JSON.stringify(view).includes('mock-admin-user') && !/mock-at-|mock-rt-/.test(JSON.stringify(view)), 'signed in as <sub>, no token value in the view');
const replay = await step({ action: 'otp', otp: m.otp });
check(replay.status === 410 && replay.json.error === 'login_expired', 'replaying a finished sign-in fails');
for (const id of [w.id, i.id]) await call('DELETE', `/api/connections/${id}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
