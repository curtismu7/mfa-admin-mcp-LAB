#!/usr/bin/env node
// Verifies a RUNNING instance (host-run or container) by content, mock demo only: health contract, the page, the offline
// demo flow through the API, the write gate, the scan, and the interactive redirect base. Contacts only the base URL you give
// (must be loopback) and, with --container, `docker exec`s into that container to fetch the stub authorization endpoint,
// which listens on the container's own loopback and is not reachable from the host.
//   node scripts/verify-running.mjs http://localhost:5241 [--container <name>]
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const base = process.argv[2];
const container = process.argv.includes('--container') ? process.argv[process.argv.indexOf('--container') + 1] : null;
if (!base || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) { console.error('usage: verify-running.mjs http://localhost:<port> [--container name]'); process.exit(2); }
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
check(h.status === 200 && h.json?.schema === 'demo-health/1' && ['ready', 'needs-setup'].includes(h.json.state) && h.json.demo?.id === 'pingone-mcp-inspector', `health contract demo-health/1 (state ${h.json?.state})`);
const page = await call('GET', '/');
check(page.status === 200 && /<div id="root"/.test(page.text) && /<title>[^<]*PingOne MCP Inspector/.test(page.text), 'the page is the built app (root div and title)');
const bad = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: Number(hostPort), path: '/api/connections', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('error', () => resolve(null)); r.end(); });
check(bad === 403, 'a non-loopback Host header is refused');

const w = (await call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'verify worker', region: 'com', envId: ENV, endpointStyle: 'api', auth: 'worker', clientId: 'viewer-demo', clientSecret: 'demo-secret' })).json;
const viewer = (await call('GET', `/api/connections/${w.id}/tools`)).json;
check(viewer.count === 8 && viewer.byClass.write === 0, `viewer role lists ${viewer.count} tools, all read`);
check(!JSON.stringify(w).includes('demo-secret'), 'the connection view never returns the client secret');
const role = await call('POST', `/api/connections/${w.id}/role`, { role: 'admin' });
const admin = (await call('GET', `/api/connections/${w.id}/tools`)).json;
check(role.status === 200 && admin.count === 21 && admin.byClass.write > 0 && admin.byClass.destructive > 0, `admin role lists ${admin.count} tools including write and destructive`);
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

// Interactive: the redirect URI must be http://localhost:<published port>/api/oauth/callback.
const redirectUri = `http://localhost:${hostPort}/api/oauth/callback`;
const i = (await call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'verify interactive', region: 'com', envId: ENV, endpointStyle: 'api', auth: 'interactive', clientId: 'admin-demo', redirectUri })).json;
const wrongPort = (await call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'wrong port', region: 'com', envId: ENV, endpointStyle: 'api', auth: 'interactive', clientId: 'admin-demo', redirectUri: `http://localhost:${Number(hostPort) + 1}/api/oauth/callback` })).json;
const refused = await call('POST', `/api/connections/${wrongPort.id}/login/start`, {});
check(refused.status === 400 && refused.json.error === 'redirect_uri_invalid', `a redirect URI on another port than the published one (${Number(hostPort) + 1}) is refused`);
const start = await call('POST', `/api/connections/${i.id}/login/start`, {});
check(start.status === 200 && /code_challenge_method=S256/.test(start.json.authorizeUrl) && /state=/.test(start.json.authorizeUrl) && /nonce=/.test(start.json.authorizeUrl), `login/start accepts ${redirectUri} and builds an S256 + state + nonce authorize URL`);
if (container) {
  const loc = execFileSync('docker', ['exec', container, 'node', '-e', 'fetch(process.argv[1],{redirect:"manual"}).then(r=>console.log(r.headers.get("location")))', start.json.authorizeUrl]).toString().trim();
  check(loc.startsWith(redirectUri), 'the stub authorization server redirects back to the published-port redirect URI');
  const cb = await fetch(loc, { redirect: 'manual' });
  check(cb.status === 302 && /login=ok/.test(cb.headers.get('location') || ''), 'the callback on the published port completes the sign-in');
  const view = (await call('GET', '/api/connections')).json.connections.find((c) => c.id === i.id);
  check(view.auth_status?.signedIn === true && JSON.stringify(view).includes('mock-admin-user') && !/mock-at-|mock-rt-/.test(JSON.stringify(view)), 'signed in as <sub>, no token value in the view');
  const replay = await fetch(loc, { redirect: 'manual' });
  check(replay.status === 302 && /login=error/.test(replay.headers.get('location') || ''), 'replaying the callback (single-use state) fails');
} else console.log('SKIP  callback leg (needs --container: the stub authorization server is inside the container)');
for (const id of [w.id, i.id, wrongPort.id]) await call('DELETE', `/api/connections/${id}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
