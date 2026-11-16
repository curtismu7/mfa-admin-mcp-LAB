// The id_token check at the end of the PingOne native flow: a genuine ES256 id_token (raw r||s signature, as JWS defines it) verifies,
// and the DER form of an EC signature, an unsupported algorithm, "none" and a foreign issuer are refused. Also: connections saved with
// the removed PingFederate settings (idp, idpBaseUrl, pfClientId) load without them, and their hosts get no network permit.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { createAuth } from '../src/auth.js';
import { createStore } from '../src/store.js';
import { liveHosts } from '../src/urls.js';
import { ENV_ID, tmpDir } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
after(() => { assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const AS = `https://auth.pingone.com/${ENV_ID}`;
const conn = { id: 'c1', kind: 'pingone', auth: 'interactive', region: 'com', envId: ENV_ID, clientId: 'app-1' };

// A stub PingOne: authorize (opens a native flow), one flow step, resume, token and JWKS, signing id_tokens with a P-256 key made with
// createECDH (the repo-scan test explains why the EC key-pair generator is avoided).
function stubPingOne({ alg = 'ES256', encoding = 'ieee-p1363', iss = `${AS}/as` } = {}) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const pub = ecdh.getPublicKey(); const x = pub.subarray(1, 33).toString('base64url'); const y = pub.subarray(33).toString('base64url');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: ecdh.getPrivateKey().toString('base64url'), x, y }, format: 'jwk' });
  const requests = []; let nonce;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    requests.push(`${init.method || 'GET'} ${u.split('?')[0]}`);
    if (u.startsWith(`${AS}/as/authorize?`)) { nonce = new URL(u).searchParams.get('nonce'); return Response.json({ id: 'flow-123456', status: 'USERNAME_PASSWORD_REQUIRED' }); }
    if (u === `${AS}/flows/flow-123456`) return Response.json({ status: 'COMPLETED' });
    if (u.startsWith(`${AS}/as/resume?`)) return Response.json({ authorizeResponse: { code: 'the-code' } });
    if (u === `${AS}/as/jwks`) return Response.json({ keys: [{ kty: 'EC', crv: 'P-256', x, y, kid: 'k1', alg: 'ES256', use: 'sig' }] });
    if (u === `${AS}/as/token`) {
      const claims = { iss, aud: 'app-1', sub: 'admin-user', exp: Math.floor(Date.now() / 1000) + 600, nonce };
      const signed = `${Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const sig = alg === 'none' ? '' : crypto.sign('sha256', Buffer.from(signed), { key, dsaEncoding: encoding }).toString('base64url');
      return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: `${signed}.${sig}` });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, requests };
}

async function signIn(opts) {
  const stub = stubPingOne(opts);
  const a = createAuth({ resolveBase: () => null, fetchImpl: stub.fetchImpl });
  const s = await a.startLogin(conn);
  const out = { a, stub };
  try { out.value = await a.loginStep(conn, { loginId: s.loginId, action: 'password', username: 'admin.user', password: 'right' }); } catch (e) { out.error = e; }
  return out;
}

test('auth: a native flow that ends in a genuine ES256 id_token (raw r||s signature) verifies, using PingOne endpoints only', async () => {
  const { a, value, error, stub } = await signIn();
  assert.equal(error, undefined);
  assert.equal(value.step, 'done'); assert.equal(value.as, 'admin-user');
  assert.equal(a.status(conn).signedIn, true);
  assert.deepEqual(stub.requests, [`GET ${AS}/as/authorize`, `POST ${AS}/flows/flow-123456`, `GET ${AS}/as/resume`, `POST ${AS}/as/token`, `GET ${AS}/as/jwks`]);
});

test('auth: the DER form of an EC signature, an unsupported algorithm, "none" and a foreign issuer are all refused', async () => {
  const refused = async (opts) => { const r = await signIn(opts); assert.equal(r.value, undefined); assert.equal(r.a.status(conn).signedIn, false); return r.error; };
  assert.match((await refused({ encoding: 'der' })).message, /signature does not verify/);
  assert.match((await refused({ alg: 'HS256' })).message, /not supported/);
  assert.equal((await refused({ alg: 'none' })).code, 'bad_id_token'); // an empty signature segment is not even a JWT
  assert.equal((await refused({ iss: 'https://pingfederate.example.com/as' })).code, 'iss_mismatch');
});

test('store and urls: PingFederate settings saved by an older build are ignored, dropped on the next write, and get no network permit', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  const old = { id: 'old-1', kind: 'pingone', label: 'old', createdAt: '2026-11-15T00:00:00.000Z', allowWrites: false, offline: false, region: 'com', envId: ENV_ID, auth: 'interactive', endpointStyle: 'mcp-host', clientId: 'app-1', idp: 'pingone', idpBaseUrl: 'https://pingfederate.example.com', pfClientId: 'pf-client' };
  fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify({ [old.id]: old }));
  const rec = store.get('old-1');
  for (const k of ['idp', 'idpBaseUrl', 'pfClientId']) assert.equal(k in rec, false, k);
  assert.equal(liveHosts({ ...old }).includes('pingfederate.example.com'), false); // even a record that still carries the field
  assert.deepEqual(liveHosts(rec), ['auth.pingone.com', 'mcp.pingone.com']);
  store.update('old-1', { allowWrites: true, idpBaseUrl: 'https://pingfederate.example.com', pfClientId: 'x' }); // the PF fields are not settings any more
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'connections.json'), 'utf8'))['old-1'];
  assert.equal(disk.allowWrites, true);
  for (const k of ['idp', 'idpBaseUrl', 'pfClientId']) assert.equal(k in disk, false, k);
  const made = store.create({ kind: 'pingone', label: 'new', region: 'com', envId: ENV_ID, clientId: 'app-1', idp: 'pf', idpBaseUrl: 'https://pingfederate.example.com' });
  for (const k of ['idp', 'idpBaseUrl', 'pfClientId']) assert.equal(k in made, false, k);
});
