#!/usr/bin/env node
// The minimum end-to-end check against a RUNNING app (npm start, or the Docker container): health, the mode, the mock demo end to end
// (add, test, list tools, scan, one read call, delete), and Reset. It uses the mock demo only and removes the connection it made, so
// it never reaches a real server even if Live is set up on this machine. Prints one line per check, exits 1 on a failure. Loopback only.
//   node scripts/smoke.mjs [base-url]      (default http://127.0.0.1:${PORT:-5201})
import { isLoopbackHost } from '../server/src/security.js';

const base = new URL(process.argv[2] || `http://127.0.0.1:${process.env.PORT || 5201}`);
if (!isLoopbackHost(base.hostname)) { console.error(`refusing ${base.hostname}: loopback only`); process.exit(1); }
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed += 1; };
const send = async (method, p, body) => {
  const r = await fetch(new URL(p, base), { method, headers: { 'content-type': 'application/json', origin: base.origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const PLACEHOLDER_ENV = '11111111-2222-4333-8444-555555555555'; // a placeholder, not a tenant
let madeId = null;

try {
  const h = await send('GET', '/api/health');
  check(h.status === 200 && h.json.schema === 'demo-health/1' && h.json.state !== 'broken', 'GET /api/health is demo-health/1 and not broken');
  const i = await send('GET', '/api/info');
  check(i.status === 200 && i.json.mode === 'mock' && typeof i.json.live?.available === 'boolean', `GET /api/info: the page opens in Mock (Live is ${i.json.live?.available ? 'allowed by the owner' : 'refused'})`);
  const made = await send('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'smoke', region: 'com', envId: PLACEHOLDER_ENV, auth: 'worker', clientId: 'viewer-demo', clientSecret: 'demo-secret', endpointStyle: 'api' });
  madeId = made.json?.id ?? null;
  check(made.status === 201 && madeId, 'POST /api/connections: the mock demo is added');
  const t = await send('POST', `/api/connections/${madeId}/test`);
  check(t.status === 200 && t.json.ok === true && t.json.toolCount > 0, `POST .../test: the mock lists ${t.json.toolCount} tools`);
  const sc = await send('POST', `/api/connections/${madeId}/scan`);
  check(sc.status === 200 && sc.json.summary?.total === 0, 'POST .../scan: the mock catalog scans clean');
  const call = await send('POST', `/api/connections/${madeId}/call`, { tool: 'listUsers', arguments: { environmentId: PLACEHOLDER_ENV } });
  check(call.status === 200 && call.json.class === 'read', 'POST .../call: a read tool runs');
  const w = await send('POST', `/api/connections/${madeId}/call`, { tool: 'createApplication', arguments: { environmentId: PLACEHOLDER_ENV, name: 'x' } });
  check(w.status === 404 || w.status === 403, 'POST .../call: a write is refused (the viewer role does not see it)');
  const z = await send('POST', '/api/reset', {});
  check(z.status === 200 && z.json.ok === true, 'POST /api/reset: ok');
} catch (e) { check(false, `the app did not answer at ${base.origin}: ${e.message}`); }
if (madeId) {
  try { const d = await send('DELETE', `/api/connections/${madeId}`); check(d.status === 200, 'DELETE: the smoke connection is removed'); }
  catch (e) { check(false, `could not remove the smoke connection: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
