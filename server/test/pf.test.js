// PingFederate sign-in: it never invents a host, it needs a base URL on a live connection, the mock answers PingFederate's endpoint
// names so the flow can be shown, and an ES256 id_token (raw r||s signature, as JWS defines it) verifies.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { createAuth } from '../src/auth.js';
import { createStore } from '../src/store.js';
import { asBase, liveHosts } from '../src/urls.js';
import { ENV_ID, startApp, tmpDir, workerConn } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
after(() => { assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const PF = 'https://pingfederate.example.com';
const REDIRECT = 'http://localhost:5299/api/oauth/callback';
const pfConn = (o = {}) => ({ id: 'p1', kind: 'pingone', auth: 'interactive', region: 'com', envId: ENV_ID, clientId: 'pf-client', redirectUri: REDIRECT, idp: 'pf', idpBaseUrl: PF, ...o });

test('urls: PingFederate has no default host; the base URL is required unless the connection is the offline mock', () => {
  assert.equal(asBase({ region: 'com', envId: ENV_ID, idp: 'pf', idpBaseUrl: `${PF}/` }), `${PF}/as`);
  assert.equal(asBase({ region: 'com', envId: ENV_ID, idp: 'pf', offlineBase: 'http://127.0.0.1:9' }), `http://127.0.0.1:9/${ENV_ID}/as`);
  assert.throws(() => asBase({ region: 'com', envId: ENV_ID, idp: 'pf' }), (e) => e.code === 'pf_not_configured' && !/pingfederate\.com/.test(e.message));
  assert.equal(asBase({ region: 'com', envId: ENV_ID, idp: 'pingone' }), `https://auth.pingone.com/${ENV_ID}/as`);
  // an old saved PF connection without a base has no authorization host to permit, and must not take the whole list down
  assert.deepEqual(liveHosts({ kind: 'pingone', region: 'com', envId: ENV_ID, endpointStyle: 'api', idp: 'pf' }), ['api.pingone.com']);
  assert.deepEqual(liveHosts({ kind: 'pingone', region: 'com', envId: ENV_ID, endpointStyle: 'api', idp: 'pf', idpBaseUrl: PF }), ['pingfederate.example.com', 'api.pingone.com']);
});

test('store: a live PingFederate connection must name its server; the offline mock need not; a bad base is refused', () => {
  const store = createStore({ dir: tmpDir() });
  const body = (o) => ({ kind: 'pingone', region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'c', redirectUri: REDIRECT, idp: 'pf', ...o });
  assert.throws(() => store.create(body({ offline: false })), /PingFederate needs its base URL/);
  assert.throws(() => store.create(body({ offline: false, idpBaseUrl: 'http://pingfederate.example.com' })), /https/);
  assert.equal(store.create(body({ offline: false, idpBaseUrl: PF })).idpBaseUrl, PF);
  assert.equal(store.create(body({ offline: true })).idp, 'pf');
});

test('auth: PingFederate sign-in with no base URL is refused before any state exists', () => {
  const a = createAuth({ resolveBase: () => null });
  assert.throws(() => a.startLogin(pfConn({ idpBaseUrl: undefined }), { idp: 'pf' }), (e) => e.code === 'pf_not_configured');
  assert.equal(a._pending.size, 0);
  assert.match(a.startLogin(pfConn(), { idp: 'pf' }).authorizeUrl, new RegExp(`^${PF}/as/authorization\\.oauth2\\?`));
});

// A stub PingFederate: token and JWKS endpoints only, signing id_tokens with a P-256 key made with createECDH (the repo-scan test
// explains why the EC key-pair generator is avoided).
function stubPf({ alg = 'ES256', encoding = 'ieee-p1363', iss = `${PF}/as`, nonce } = {}) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const pub = ecdh.getPublicKey(); const x = pub.subarray(1, 33).toString('base64url'); const y = pub.subarray(33).toString('base64url');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: ecdh.getPrivateKey().toString('base64url'), x, y }, format: 'jwk' });
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(String(url));
    if (String(url) === `${PF}/pf/JWKS`) return Response.json({ keys: [{ kty: 'EC', crv: 'P-256', x, y, kid: 'k1', alg: 'ES256', use: 'sig' }] });
    if (String(url) === `${PF}/as/token.oauth2`) {
      const claims = { iss, aud: 'pf-client', sub: 'pf-user', exp: Math.floor(Date.now() / 1000) + 600, nonce: nonce() };
      const signed = `${Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const sig = alg === 'none' ? '' : crypto.sign('sha256', Buffer.from(signed), { key, dsaEncoding: encoding }).toString('base64url');
      return Response.json({ access_token: 'pf-at', refresh_token: 'pf-rt', expires_in: 3600, id_token: `${signed}.${sig}` });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, requests };
}

async function signIn(opts) {
  let nonce; const stub = stubPf({ ...opts, nonce: () => nonce });
  const a = createAuth({ resolveBase: () => null, fetchImpl: stub.fetchImpl });
  const c = pfConn();
  const { authorizeUrl, state } = a.startLogin(c, { idp: 'pf' });
  nonce = new URL(authorizeUrl).searchParams.get('nonce');
  const out = { a, c, stub };
  try { out.value = await a.completeLogin({ q: { code: 'abc', state }, at: REDIRECT, getConn: () => c }); } catch (e) { out.error = e; }
  return out;
}

test('auth: a genuine ES256 id_token (raw r||s signature) from PingFederate verifies, using PF endpoints only', async () => {
  const { a, c, value, error, stub } = await signIn();
  assert.equal(error, undefined);
  assert.equal(value.sub, 'pf-user');
  assert.equal(a.status(c).signedIn, true);
  assert.deepEqual(stub.requests, [`${PF}/as/token.oauth2`, `${PF}/pf/JWKS`]);
});

test('auth: the DER form of an EC signature, an unsupported algorithm, "none" and a foreign issuer are all refused', async () => {
  const refused = async (opts) => { const r = await signIn(opts); assert.equal(r.value, undefined); assert.equal(r.a.status(r.c).signedIn, false); return r.error; };
  assert.match((await refused({ encoding: 'der' })).message, /signature does not verify/);
  assert.match((await refused({ alg: 'HS256' })).message, /not supported/);
  assert.equal((await refused({ alg: 'none' })).code, 'bad_id_token'); // an empty signature segment is not even a JWT
  assert.equal((await refused({ iss: 'https://evil.example/as' })).code, 'iss_mismatch');
});

test('over HTTP: PingFederate sign-in against the mock (its endpoint names) and the refusal on a live connection with no base URL', async () => {
  const s = await startApp();
  try {
    const port = new URL(s.origin).port;
    const redirectUri = `http://localhost:${port}/api/oauth/callback`;
    const mk = async (o) => (await s.call('POST', '/api/connections', { ...workerConn(), auth: 'interactive', clientSecret: undefined, redirectUri, ...o })).json;
    const mock = await mk({ idp: 'pf' });
    const start = await s.call('POST', `/api/connections/${mock.id}/login/start`, { idp: 'pf' });
    assert.equal(start.status, 200, start.text);
    assert.match(start.json.authorizeUrl, /\/as\/authorization\.oauth2\?/);
    const back = new URL((await fetch(start.json.authorizeUrl, { redirect: 'manual' })).headers.get('location'));
    const cb = await fetch(`http://localhost:${port}${back.pathname}${back.search}`, { redirect: 'manual' });
    assert.match(cb.headers.get('location'), /login=ok/);
    assert.equal((await s.call('GET', '/api/connections')).json.connections.find((x) => x.id === mock.id).auth_status.signedIn, true);

    const live = await mk({ offline: false, idp: 'pingone' });
    const refused = await s.call('POST', `/api/connections/${live.id}/login/start`, { idp: 'pf' });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'pf_not_configured');
    assert.ok(!refused.text.includes('pingfederate.'), 'no invented host');
    assert.match((await s.call('POST', `/api/connections/${live.id}/login/start`, { idp: 'pingone' })).json.authorizeUrl, /^https:\/\/auth\.pingone\.com\//);
  } finally { await s.close(); }
});
