import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { startHttpServer } from '../src/index.js';
import { createMock } from '../src/mock.js';
import { createStore } from '../src/store.js';

export const ENV_ID = '11111111-2222-4333-8444-555555555555'; // a placeholder, not a tenant
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pingone-mcp-lab-test-'));

export async function startApp({ env = {}, dir = tmpDir(), mock, now, fetchImpl } = {}) {
  const theMock = mock || createMock();
  if (!theMock.base) await theMock.start();
  // The owner's Live opt-in is on by default here: most tests drive saved Live connections against loopback stubs. mode.test.js turns it off.
  const app = createApp({ env: { PINGONE_MCP_INSPECTOR_MODE: 'live', ...env, P1MCP_DATA_DIR: dir }, store: createStore({ dir }), mock: theMock, now, ...(fetchImpl ? { fetchImpl } : {}) });
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

export const workerConn = (o = {}) => ({ kind: 'pingone', offline: true, region: 'com', envId: ENV_ID, auth: 'worker', clientId: 'admin-app', clientSecret: 'worker-secret-value', ...o });
