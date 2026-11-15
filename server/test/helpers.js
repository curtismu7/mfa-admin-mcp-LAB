import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { startHttpServer } from '../src/index.js';
import { createMock, MOCK_LOGIN } from '../src/mock.js';
import { createStore } from '../src/store.js';

export const ENV_ID = '11111111-2222-4333-8444-555555555555'; // a placeholder, not a tenant
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pingone-mcp-lab-test-'));

export async function startApp({ env = {}, dir = tmpDir(), mock, now, fetchImpl } = {}) {
  const theMock = mock || createMock();
  if (!theMock.base) await theMock.start();
  // Live is on by default (no env opt-in since 2026-11-13): most tests drive saved Live connections against loopback stubs. mode.test.js refuses it via a non-loopback bind.
  const app = createApp({ env: { ...env, MFAADM_DATA_DIR: dir }, store: createStore({ dir }), mock: theMock, now, ...(fetchImpl ? { fetchImpl } : {}) });
  const srv = await startHttpServer({ port: 0, host: '127.0.0.1', app });
  const origin = `http://127.0.0.1:${srv.port}`;
  async function call(method, p, body, { headers = {}, origin: o = origin, redirect = 'follow' } = {}) {
    const h = { ...headers };
    if (o && method !== 'GET') h.Origin = o;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${origin}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return { ...srv, origin, dir, call, app, mock: theMock, close: async () => { await srv.close(); if (!mock) await theMock.stop(); } };
}

// An offline PingOne connection (the in-process mock): a user sign-in through pi.flow, a public client, no secret. The tools it sees
// depend on the mock account that signs in, not on the client id.
export const mockConn = (o = {}) => ({ kind: 'pingone', offline: true, region: 'com', envId: ENV_ID, auth: 'interactive', clientId: 'mock-native-app', ...o });

// Signs a saved connection in through the app's own login routes (pi.flow against the mock): password, a device choice when asked,
// then the one-time code. user: 'mock.admin' (every tool) or 'mock.viewer' (read tools only).
export async function signIn(s, id, user = MOCK_LOGIN.username) {
  const start = await s.call('POST', `/api/connections/${id}/login/start`, {});
  assert.equal(start.status, 200, start.text);
  const step = (b) => s.call('POST', `/api/connections/${id}/login/step`, { loginId: start.json.loginId, ...b });
  let r = await step({ action: 'password', username: user, password: MOCK_LOGIN.password });
  if (r.json?.step === 'device') r = await step({ action: 'device', deviceId: r.json.devices[0].id });
  if (r.json?.step === 'otp') r = await step({ action: 'otp', otp: MOCK_LOGIN.otp });
  assert.equal(r.json?.step, 'done', r.text);
  return r.json;
}

// Creates an offline PingOne connection and signs it in as `user`. Returns the saved connection as the API shows it.
export async function addSignedIn(s, { user = MOCK_LOGIN.username, ...o } = {}) {
  const r = await s.call('POST', '/api/connections', mockConn(o));
  assert.equal(r.status, 201, r.text);
  await signIn(s, r.json.id, user);
  return r.json;
}

// An access token from a bare mock (no app), signed in through the same pi.flow steps, for tests that talk to the mock directly.
export async function mockToken(base, user = MOCK_LOGIN.username) {
  const a = createAuth({ resolveBase: () => base });
  const c = { id: 'direct', kind: 'pingone', auth: 'interactive', region: 'com', envId: ENV_ID, clientId: 'mock-native-app' };
  const start = await a.startLogin(c);
  let r = await a.loginStep(c, { loginId: start.loginId, action: 'password', username: user, password: MOCK_LOGIN.password });
  if (r.step === 'device') r = await a.loginStep(c, { loginId: start.loginId, action: 'device', deviceId: r.devices[0].id });
  if (r.step === 'otp') r = await a.loginStep(c, { loginId: start.loginId, action: 'otp', otp: MOCK_LOGIN.otp });
  return a.accessToken(c);
}
