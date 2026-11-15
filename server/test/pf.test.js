// PingFederate sign-in (native flow, pi.flow): it never invents a host, it needs a base URL on a live connection, the mock answers
// PingFederate's endpoint names so the flow can be shown, and an ES256 id_token (raw r||s signature, as JWS defines it) verifies.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { createAuth, PI_FLOW_REDIRECT_URI } from '../src/auth.js';
import { createStore } from '../src/store.js';
import { asBase, liveHosts } from '../src/urls.js';
import { ENV_ID, mockConn, startApp, tmpDir } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
after(() => { assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const PF = 'https://pingfederate.example.com';
const pfConn = (o = {}) => ({ id: 'p1', kind: 'pingone', auth: 'interactive', region: 'com', envId: ENV_ID, clientId: 'pf-client', idp: 'pf', idpBaseUrl: PF, ...o });

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
  const body = (o) => ({ kind: 'pingone', region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'c', idp: 'pf', ...o });
  assert.throws(() => store.create(body({ offline: false })), /PingFederate needs its base URL/);
  assert.throws(() => store.create(body({ offline: false, idpBaseUrl: 'http://pingfederate.example.com' })), /https/);
  assert.equal(store.create(body({ offline: false, idpBaseUrl: PF })).idpBaseUrl, PF);
  assert.equal(store.create(body({ offline: true })).idp, 'pf');
});

test('auth: PingFederate sign-in with no base URL is refused before any state exists', async () => {
  const a = createAuth({ resolveBase: () => null });
  await assert.rejects(a.startLogin(pfConn({ idpBaseUrl: undefined }), { idp: 'pf' }), (e) => e.code === 'pf_not_configured');
  assert.equal(a._logins.size, 0);
});

// A stub PingFederate: authorize (opens a native flow), one flow step, token and JWKS endpoints, signing id_tokens with a P-256 key made
// with createECDH (the repo-scan test explains why the EC key-pair generator is avoided).
function stubPf({ alg = 'ES256', encoding = 'ieee-p1363', iss = `${PF}/as`, aud = 'pf-client' } = {}) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const pub = ecdh.getPublicKey(); const x = pub.subarray(1, 33).toString('base64url'); const y = pub.subarray(33).toString('base64url');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: ecdh.getPrivateKey().toString('base64url'), x, y }, format: 'jwk' });
  const requests = []; const headers = []; const tokenBodies = []; const authorizeQueries = []; let nonce;
  const fetchImpl = async (url, init = {}) => {
    requests.push(`${init.method || 'GET'} ${String(url).split('?')[0]}`);
    if (String(url).startsWith(`${PF}/as/authorization.oauth2?`)) { authorizeQueries.push(new URL(url).searchParams); nonce = new URL(url).searchParams.get('nonce'); return Response.json({ id: 'pfflow-123456', status: 'USERNAME_PASSWORD_REQUIRED' }); }
    if (String(url) === `${PF}/pf-ws/authn/flows/pfflow-123456`) {
      headers.push({ ...init.headers });
      const body = JSON.parse(init.body);
      if (body.password !== 'right') return Response.json({ details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }, { status: 400 });
      return Response.json({ status: 'COMPLETED', authorizeResponse: { code: 'pf-code' } });
    }
    if (String(url) === `${PF}/pf/JWKS`) return Response.json({ keys: [{ kty: 'EC', crv: 'P-256', x, y, kid: 'k1', alg: 'ES256', use: 'sig' }] });
    if (String(url) === `${PF}/as/token.oauth2`) {
      tokenBodies.push(new URLSearchParams(String(init.body)));
      const claims = { iss, aud, sub: 'pf-user', exp: Math.floor(Date.now() / 1000) + 600, nonce };
      const signed = `${Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const sig = alg === 'none' ? '' : crypto.sign('sha256', Buffer.from(signed), { key, dsaEncoding: encoding }).toString('base64url');
      return Response.json({ access_token: 'pf-at', refresh_token: 'pf-rt', expires_in: 3600, id_token: `${signed}.${sig}` });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, requests, headers, tokenBodies, authorizeQueries };
}

async function signIn(opts) {
  const stub = stubPf(opts);
  const a = createAuth({ resolveBase: () => null, fetchImpl: stub.fetchImpl });
  const c = pfConn();
  const s = await a.startLogin(c, { idp: 'pf' });
  const out = { a, c, stub, first: s };
  try { out.value = await a.loginStep(c, { loginId: s.loginId, action: 'password', username: 'pf.user', password: 'right' }); } catch (e) { out.error = e; }
  return out;
}

test('auth: a PingFederate native flow ends in a genuine ES256 id_token (raw r||s signature) that verifies, using PF endpoints only', async () => {
  const { a, c, value, error, stub } = await signIn();
  assert.equal(error, undefined);
  assert.equal(value.step, 'done'); assert.equal(value.as, 'pf-user');
  assert.equal(a.status(c).signedIn, true);
  assert.deepEqual(stub.requests, [`GET ${PF}/as/authorization.oauth2`, `POST ${PF}/pf-ws/authn/flows/pfflow-123456`, `POST ${PF}/as/token.oauth2`, `GET ${PF}/pf/JWKS`]);
});

test('auth: PingFederate steps carry its own content type and CSRF header, and a wrong password is a retry, not a failure of the flow', async () => {
  const stub = stubPf(); const a = createAuth({ resolveBase: () => null, fetchImpl: stub.fetchImpl }); const c = pfConn();
  const s = await a.startLogin(c, { idp: 'pf' });
  await assert.rejects(a.loginStep(c, { loginId: s.loginId, action: 'password', username: 'pf.user', password: 'wrong' }), (e) => e.code === 'invalid_credentials');
  assert.equal((await a.loginStep(c, { loginId: s.loginId, action: 'password', username: 'pf.user', password: 'right' })).step, 'done');
  assert.ok(stub.headers.every((h) => h['Content-Type'] === 'application/vnd.pingidentity.checkUsernamePassword+json' && h['X-XSRF-Header'] === 'PingFederate' && h.Accept === 'application/json'));
  assert.equal(new URL(stub.requests.find((r) => r.includes('authorization.oauth2')).split(' ')[1]).origin, PF);
});

test('auth: the DER form of an EC signature, an unsupported algorithm, "none" and a foreign issuer are all refused', async () => {
  const refused = async (opts) => { const r = await signIn(opts); assert.equal(r.value, undefined); assert.equal(r.a.status(r.c).signedIn, false); return r.error; };
  assert.match((await refused({ encoding: 'der' })).message, /signature does not verify/);
  assert.match((await refused({ alg: 'HS256' })).message, /not supported/);
  assert.equal((await refused({ alg: 'none' })).code, 'bad_id_token'); // an empty signature segment is not even a JWT
  assert.equal((await refused({ iss: 'https://evil.example/as' })).code, 'iss_mismatch');
});

test('over HTTP: PingFederate sign-in against the mock (its endpoint names, its MFA_COMPLETED step) and the refusal on a live connection with no base URL', async () => {
  const s = await startApp();
  try {
    const mk = async (o) => (await s.call('POST', '/api/connections', mockConn(o))).json;
    const mock = await mk({ idp: 'pf' });
    const start = await s.call('POST', `/api/connections/${mock.id}/login/start`, { idp: 'pf' });
    assert.equal(start.status, 200, start.text);
    assert.equal(start.json.step, 'password');
    const step = (b) => s.call('POST', `/api/connections/${mock.id}/login/step`, { loginId: start.json.loginId, ...b });
    const otp = await step({ action: 'password', username: start.json.mockLogin.username, password: start.json.mockLogin.password });
    assert.equal(otp.json.step, 'otp', otp.text);
    const done = await step({ action: 'otp', otp: start.json.mockLogin.otp });
    assert.equal(done.json.step, 'done', done.text);
    assert.deepEqual(s.mock.config.flowSteps.map((x) => `${x.kind}:${x.contentType.split('.').pop()}`), ['pf:checkUsernamePassword+json', 'pf:checkOtp+json', 'pf:continueAuthentication+json']);
    assert.equal((await s.call('GET', '/api/connections')).json.connections.find((x) => x.id === mock.id).auth_status.signedIn, true);
    assert.deepEqual(s.mock.config.resources, [], 'PingFederate sign-in is unchanged: no resource indicator');

    const live = await mk({ offline: false, idp: 'pingone' });
    const refused = await s.call('POST', `/api/connections/${live.id}/login/start`, { idp: 'pf' });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'pf_not_configured');
    assert.ok(!refused.text.includes('pingfederate.'), 'no invented host');
  } finally { await s.close(); }
});

test('urls: a PingOne-default connection with a PingFederate base also permits the PingFederate host (PF login beside P1 login)', () => {
  const c = { kind: 'pingone', region: 'com', envId: ENV_ID, endpointStyle: 'api', idp: 'pingone' };
  assert.deepEqual(liveHosts(c), ['auth.pingone.com', 'api.pingone.com']);
  assert.deepEqual(liveHosts({ ...c, idpBaseUrl: PF }), ['auth.pingone.com', 'pingfederate.example.com', 'api.pingone.com']);
});

test('store: a saved live PingOne connection takes a PingFederate base and client id later; empty removes them; a bad base is refused', () => {
  const store = createStore({ dir: tmpDir() });
  const live = store.create({ kind: 'pingone', region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'p1-client' });
  assert.equal(live.idp, 'pingone'); assert.equal(live.idpBaseUrl, undefined);
  assert.throws(() => store.update(live.id, { idpBaseUrl: 'http://pingfederate.example.com' }), (e) => e.code === 'bad_request' && /https/.test(e.message));
  assert.throws(() => store.update(live.id, { idpBaseUrl: 'https://user:pw@pingfederate.example.com' }), (e) => e.code === 'bad_request');
  assert.throws(() => store.update(live.id, { pfClientId: 'has space' }), (e) => e.code === 'bad_request');
  let r = store.update(live.id, { idpBaseUrl: ` ${PF} `, pfClientId: 'pf-client' });
  assert.deepEqual([r.idp, r.idpBaseUrl, r.pfClientId, r.clientId], ['pingone', PF, 'pf-client', 'p1-client']);
  r = store.update(live.id, { idpBaseUrl: '', pfClientId: '' });
  assert.equal(r.idpBaseUrl, undefined); assert.equal(r.pfClientId, undefined);
  const pfDefault = store.create({ kind: 'pingone', region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'c', idp: 'pf', idpBaseUrl: PF });
  assert.throws(() => store.update(pfDefault.id, { idpBaseUrl: '' }), (e) => e.code === 'bad_request' && /signs in at PingFederate by default/.test(e.message));
  const mock = store.create({ kind: 'pingone', offline: true, region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'm' });
  assert.equal(store.update(mock.id, { idpBaseUrl: PF }).idpBaseUrl, undefined, 'the offline mock simulates PingFederate and takes no base');
});

test('auth: PF login on a PingOne-default connection uses the PingFederate client id throughout, and a refresh goes back to PingFederate', async () => {
  const stub = stubPf({ aud: 'pf-only-client' });
  let t = Date.now();
  const a = createAuth({ resolveBase: () => null, fetchImpl: stub.fetchImpl, now: () => t });
  const c = pfConn({ idp: 'pingone', clientId: 'p1-client', pfClientId: 'pf-only-client' });
  const s = await a.startLogin(c, { idp: 'pf' });
  assert.equal((await a.loginStep(c, { loginId: s.loginId, action: 'password', username: 'pf.user', password: 'right' })).step, 'done');
  assert.equal(stub.authorizeQueries[0].get('client_id'), 'pf-only-client');
  assert.equal(stub.authorizeQueries[0].get('resource'), null, 'no RFC 8707 resource is sent to PingFederate');
  assert.deepEqual([stub.tokenBodies[0].get('grant_type'), stub.tokenBodies[0].get('client_id')], ['authorization_code', 'pf-only-client']);
  t += 3_600_000; // past expiry: the next token use refreshes
  assert.equal(await a.accessToken(c), 'pf-at');
  assert.deepEqual([stub.tokenBodies[1].get('grant_type'), stub.tokenBodies[1].get('client_id'), stub.tokenBodies[1].get('resource')], ['refresh_token', 'pf-only-client', null]);
  assert.ok(stub.requests.every((r) => r.includes(PF)), 'every call went to PingFederate, none to PingOne');
});

test('auth: a PingFederate issuer that is its plain base URL (no /as) is accepted; another host still is not', async () => {
  const plain = await signIn({ iss: PF });
  assert.equal(plain.error, undefined); assert.equal(plain.value.step, 'done');
  const foreign = await signIn({ iss: 'https://evil.example' });
  assert.equal(foreign.error.code, 'iss_mismatch');
});
