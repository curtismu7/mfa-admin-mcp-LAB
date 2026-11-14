// Behind the family lab-proxy: LAB_ALLOWED_HOSTS (the proxy's Host name for this app) and same-origin writes carried by
// X-Forwarded-Host / X-Forwarded-Proto. Loopback always works; unset = loopback only; MFAADM_ALLOWED_HOSTS is unchanged.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { allPassed, runChecks } from '../src/doctor.js';
import { allowedHostNames, browserOrigin, labAllowedHosts, safeReturnTo } from '../src/security.js';
import { startApp, workerConn } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
test.after(() => { assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const PROXY_HOST = 'mfa-admin-mcp.local.ping-devops.com';
const PROXY_ORIGIN = 'https://local.ping-devops.com:8443';
const FWD = { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https' };

// A request with an exact Host header (fetch cannot set it).
const call = (port, method, url, { host, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b, headers: r.headers }));
  });
  req.on('error', reject); req.end(payload);
});

test('LAB_ALLOWED_HOSTS: the lab-proxy name is served on any port, other names stay 403', async () => {
  const s = await startApp({ env: { LAB_ALLOWED_HOSTS: `${PROXY_HOST}, Other.Example` } });
  try {
    for (const host of [`${PROXY_HOST}:7815`, PROXY_HOST, 'MFA-Admin-Mcp.Local.Ping-Devops.com:8443', 'other.example', 'OTHER.example:8443', `127.0.0.1:${s.port}`]) {
      assert.equal((await call(s.port, 'GET', '/api/info', { host })).status, 200, host);
    }
    for (const host of ['evil.example.com', `${PROXY_HOST}.evil.com`, 'xmfa-admin-mcp.local.ping-devops.com', 'local.ping-devops.com:8443', 'evil-local.ping-devops.com']) {
      assert.equal((await call(s.port, 'GET', '/api/info', { host })).status, 403, host);
    }
  } finally { await s.close(); }
});

test('a bad LAB_ALLOWED_HOSTS throws before anything starts and fails the doctor; MFAADM_ALLOWED_HOSTS still works; unset = loopback only', async () => {
  // createApp validates first, before the store, the mock and the health timer exist
  assert.throws(() => createApp({ env: { LAB_ALLOWED_HOSTS: 'not a host name' } }), /LAB_ALLOWED_HOSTS: not a host name: not a host name/);
  assert.throws(() => createApp({ env: { LAB_ALLOWED_HOSTS: 'a.example,-bad-' } }), /LAB_ALLOWED_HOSTS: not a host name: -bad-/);
  assert.throws(() => labAllowedHosts({ LAB_ALLOWED_HOSTS: 'a/b' }), /not a host name: a\/b/);
  assert.equal(allPassed(runChecks({ env: { LAB_ALLOWED_HOSTS: 'not a host name' } })), false);
  assert.equal(allPassed(runChecks({ env: { LAB_ALLOWED_HOSTS: PROXY_HOST } })), true);
  assert.deepEqual(allowedHostNames({ MFAADM_ALLOWED_HOSTS: 'Old.Example' }), ['old.example']);
  const both = await startApp({ env: { MFAADM_ALLOWED_HOSTS: 'old.example', LAB_ALLOWED_HOSTS: PROXY_HOST } });
  try {
    for (const host of ['old.example:7815', PROXY_HOST]) assert.equal((await call(both.port, 'GET', '/api/info', { host })).status, 200, host);
    assert.equal((await call(both.port, 'GET', '/api/info', { host: 'new.example' })).status, 403);
  } finally { await both.close(); }
  const plain = await startApp();
  try {
    assert.equal((await call(plain.port, 'GET', '/api/info', { host: `${PROXY_HOST}:7815` })).status, 403);
    assert.equal((await call(plain.port, 'GET', '/api/info', { host: `127.0.0.1:${plain.port}` })).status, 200);
  } finally { await plain.close(); }
});

test('behind the lab-proxy: a write is accepted only with the proxy\'s forwarded origin AND an allowed Host', async () => {
  const s = await startApp({ env: { LAB_ALLOWED_HOSTS: PROXY_HOST } });
  try {
    const proxyHost = `${PROXY_HOST}:7815`;
    const via = (headers, host = proxyHost) => call(s.port, 'POST', '/api/reset', { host, headers, body: {} });
    // what the browser and the proxy really send for a same-origin POST
    assert.equal((await via({ ...FWD, origin: PROXY_ORIGIN, 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await via({ ...FWD, origin: PROXY_ORIGIN })).status, 200);
    assert.equal((await via({ 'x-forwarded-host': 'local.ping-devops.com:8443', origin: PROXY_ORIGIN })).status, 200, 'proto defaults to https');
    assert.equal((await via({ ...FWD, origin: PROXY_ORIGIN }, PROXY_HOST.toUpperCase())).status, 200, 'Host without a port, any case');
    // refused: a foreign origin, a mismatched forwarded host, a wrong scheme, a cross-site fetch, no forwarded host at all
    for (const headers of [
      { ...FWD, origin: 'https://evil.example.com' },
      { ...FWD, origin: 'https://local.ping-devops.com:9999' },
      { ...FWD, origin: 'http://local.ping-devops.com:8443' },
      { ...FWD, origin: PROXY_ORIGIN, 'sec-fetch-site': 'cross-site' },
      { origin: PROXY_ORIGIN },
      { 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https', origin: PROXY_ORIGIN },
      { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'ftp', origin: 'ftp://local.ping-devops.com:8443' },
    ]) assert.equal((await via(headers)).status, 403, JSON.stringify(headers));
    // the forwarded headers are not believed on a loopback Host: a page that did not come through the proxy cannot use them
    assert.equal((await via({ ...FWD, origin: PROXY_ORIGIN }, `127.0.0.1:${s.port}`)).status, 403);
    assert.equal((await via({ origin: `http://127.0.0.1:${s.port}` }, `127.0.0.1:${s.port}`)).status, 200, 'loopback origin still works');
  } finally { await s.close(); }
  // a name from MFAADM_ALLOWED_HOSTS alone does not unlock forwarded origins; without any setting the Host check refuses first
  for (const [env, re] of [[{ MFAADM_ALLOWED_HOSTS: PROXY_HOST }, /cross_origin/], [{}, /bad_host/]]) {
    const x = await startApp({ env });
    try {
      const r = await call(x.port, 'POST', '/api/reset', { host: `${PROXY_HOST}:7815`, body: {}, headers: { ...FWD, origin: PROXY_ORIGIN } });
      assert.equal(r.status, 403);
      assert.match(r.body, re);
    } finally { await x.close(); }
  }
});

test('browserOrigin believes X-Forwarded-* only for a LAB_ALLOWED_HOSTS Host; safeReturnTo keeps plain same-origin paths only', () => {
  const req = (headers) => ({ headers });
  const lab = new Set([PROXY_HOST]);
  const proxied = { host: `${PROXY_HOST}:7815`, ...FWD };
  assert.equal(browserOrigin(req(proxied), lab), PROXY_ORIGIN);
  assert.equal(browserOrigin(req({ host: '127.0.0.1:7815', ...FWD }), lab), 'http://127.0.0.1:7815', 'a loopback Host cannot borrow forwarded headers');
  assert.equal(browserOrigin(req(proxied), new Set()), `http://${PROXY_HOST}:7815`, 'no LAB_ALLOWED_HOSTS: forwarded headers are ignored');
  assert.equal(browserOrigin(req({ ...proxied, 'x-forwarded-proto': 'ftp' }), lab), `http://${PROXY_HOST}:7815`);
  for (const ok of ['/', '/mfa-admin-mcp/', '/mfa-admin-mcp', '/a/b/']) assert.equal(safeReturnTo(ok), ok);
  for (const bad of [undefined, '', 'mfa', '//evil.example', 'https://evil.example', '/\\evil', '/a/../b', '/./a', '/a?x', '/a#x', '/a b', '/%2e%2e/', `/${'a'.repeat(300)}`, 5, {}]) assert.equal(safeReturnTo(bad), '/', String(bad));
});

test('behind the lab-proxy: the OAuth callback is judged by the browser\'s URL and returns to the page the sign-in started from', async () => {
  const s = await startApp({ env: { LAB_ALLOWED_HOSTS: PROXY_HOST } });
  try {
    const c = (await s.call('POST', '/api/connections', { ...workerConn(), auth: 'interactive', clientSecret: undefined, redirectUri: `${PROXY_ORIGIN}/api/oauth/callback` })).json;
    const host = `${PROXY_HOST}:7815`;
    // what the browser does: start sign-in from a page, follow the authorization server's redirect back to the proxy's /api/oauth/callback
    const signIn = async (returnTo, fwd = FWD) => {
      const start = await call(s.port, 'POST', `/api/connections/${c.id}/login/start`, { host, headers: { ...FWD, origin: PROXY_ORIGIN }, body: { returnTo } });
      assert.equal(start.status, 200, start.body);
      const authz = await fetch(JSON.parse(start.body).authorizeUrl, { redirect: 'manual' });
      const back = new URL(authz.headers.get('location'));
      return call(s.port, 'GET', `${back.pathname}${back.search}`, { host, headers: fwd });
    };
    const ok = await signIn('/mfa-admin-mcp/');
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, `/mfa-admin-mcp/?login=ok&connection=${encodeURIComponent(c.id)}`, 'not "/", which the proxy sends to the shelf');
    for (const hostile of ['//evil.example', 'https://evil.example/', '/\\evil', '/a/../b', '/a?x=1']) assert.match((await signIn(hostile)).headers.location, /^\/\?login=ok/, hostile);
    assert.equal((await signIn(undefined)).headers.location.slice(0, 10), '/?login=ok', 'no returnTo: the old behaviour');
    const wrong = await signIn('/mfa-admin-mcp/', { 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' });
    assert.equal(wrong.headers.location, '/mfa-admin-mcp/?login=error&reason=redirect_mismatch', 'a callback that did not arrive on the registered URL still fails, and still returns to the app');
  } finally { await s.close(); }
});
