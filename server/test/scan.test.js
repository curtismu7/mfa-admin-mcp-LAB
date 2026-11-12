// "Scan this server's tools": flags poisoned metadata on ANY connection (a custom server serving the hostile list),
// the PingOne mock comes out clean, and the scan reads only tools/list (never tools/call).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { startApp, workerConn } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
const hostile = JSON.parse(fs.readFileSync(new URL('./fixtures/hostile-tools.json', import.meta.url), 'utf8')).tools;
const methods = [];
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const m = JSON.parse(b || '{}'); methods.push(m.method);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: hostile } : {} }));
  });
});
let s;
before(async () => { await new Promise((r) => stub.listen(0, '127.0.0.1', r)); s = await startApp(); });
after(async () => { await s.close(); stub.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

test('a custom server serving the hostile list is flagged (high findings with rule ids), tools/list only', async () => {
  const c = (await s.call('POST', '/api/connections', { kind: 'custom', label: 'hostile stub', url: `http://127.0.0.1:${stub.address().port}/mcp` })).json;
  const r = await s.call('POST', `/api/connections/${c.id}/scan`, {});
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.summary.high >= 3, JSON.stringify(r.json.summary));
  const ids = new Set(r.json.findings.map((f) => f.ruleId));
  for (const id of ['MT-HI-001', 'MT-HI-002', 'MT-EX-001']) assert.ok(ids.has(id), `missing ${id}`);
  assert.equal(r.json.scanner.enforcement, 'none');
  assert.ok(r.json.limits.length >= 5);
  assert.ok(!methods.includes('tools/call'), 'scan never calls a tool');
});
test('the PingOne mock (viewer and admin) scans clean', async () => {
  for (const clientId of ['viewer-demo', 'admin-demo']) {
    const c = (await s.call('POST', '/api/connections', workerConn({ clientId }))).json;
    const r = await s.call('POST', `/api/connections/${c.id}/scan`, {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.summary.total, 0, `${clientId}: ${JSON.stringify(r.json.findings)}`);
    assert.ok(r.json.tools >= 8);
    assert.match(r.json.fixture, /not a recording/);
  }
});
test('scan is a same-origin POST like every write route', async () => {
  const c = (await s.call('POST', '/api/connections', workerConn())).json;
  const r = await s.call('POST', `/api/connections/${c.id}/scan`, {}, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});
