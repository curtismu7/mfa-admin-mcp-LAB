// Recorded tool lists: a Live server's tools/list is recorded (metadata only), the mock demo then lists
// those tools, classes them with the normal classifier and answers each with a labelled synthetic reply.
// A recorded fixture still wins over the synthetic reply. Also: the mock's own synthetic() fallback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createMock, MOCK_LOGIN, SYNTHETIC_NOTE } from '../src/mock.js';
import { addSignedIn, mockToken, startApp, tmpDir } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
const SECRET = 'recorded-tools-secret-7';
const TOOLS = [
  { name: 'list_accounts', description: 'List bank accounts.', inputSchema: { type: 'object', properties: { owner: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'delete_account', description: 'Delete an account.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'get_balance', description: `Balance. Uses ${SECRET} internally.`, inputSchema: { type: 'object', properties: {} } },
  { name: 'listUsers', description: 'A name the sample catalog already has.', inputSchema: { type: 'object', properties: {} } },
  { name: '../bad name', description: 'refused: not a tool name', inputSchema: { type: 'object' } },
  { name: 'huge_schema', description: 'refused: schema too big', inputSchema: { type: 'object', description: 'x'.repeat(30000) } },
];
const methods = [];
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const m = JSON.parse(b || '{}'); methods.push(m.method);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: TOOLS } : {} }));
  });
});
let s; let live; let admin; let viewer;
const text = (r) => JSON.parse(r.json?.result?.content?.[0]?.text || 'null');
const listed = async (c) => (await s.call('GET', `/api/connections/${c.id}/tools`)).json.tools;

before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  s = await startApp({ dir: tmpDir() });
  live = (await s.call('POST', '/api/connections', { kind: 'custom', label: 'banking stub', url: `http://127.0.0.1:${stub.address().port}/mcp`, token: SECRET })).json;
  admin = await addSignedIn(s, { label: 'mock admin' });
  viewer = await addSignedIn(s, { label: 'mock viewer', user: MOCK_LOGIN.viewer });
});
after(async () => { await s.close(); stub.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

test('recording a Live tool list keeps valid tools, skips bad names and huge schemas, scrubs secrets', async () => {
  const r = await s.call('POST', `/api/connections/${live.id}/record-tools`, {});
  assert.equal(r.status, 201, r.text);
  assert.deepEqual({ kept: r.json.kept, skipped: r.json.skipped, total: r.json.total }, { kept: 4, skipped: 2, total: 4 });
  assert.ok(!methods.includes('tools/call'), 'recording reads tools/list only');
  const list = await s.call('GET', '/api/recorded-tools');
  assert.deepEqual(list.json.tools.map((t) => t.name).sort(), ['delete_account', 'get_balance', 'listUsers', 'list_accounts']);
  assert.ok(list.json.tools[0].source.includes('banking stub'));
  const file = path.join(s.dir, 'recorded-tools.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), 'the file on disk holds no secret');
});

test('recording is refused on the mock demo connection itself', async () => {
  assert.equal((await s.call('POST', `/api/connections/${admin.id}/record-tools`, {})).status, 400);
});

test('the mock demo lists recorded tools with their own safety class; a viewer sees only the read ones', async () => {
  const tools = await listed(admin);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.list_accounts.class, 'read');
  assert.equal(by.delete_account.class, 'destructive', 'not forced to read: the gate still sees a delete');
  assert.equal(tools.filter((t) => t.name === 'listUsers').length, 1, 'a catalog name is not listed twice');
  assert.equal(by.listUsers.description, 'List users.', 'the catalog tool wins over a recorded one with the same name');
  const v = (await listed(viewer)).map((t) => t.name);
  assert.ok(v.includes('list_accounts') && !v.includes('delete_account'));
});

test('a recorded read tool answers with a labelled synthetic reply; a recorded delete is still gated', async () => {
  const r = await s.call('POST', `/api/connections/${admin.id}/call`, { tool: 'list_accounts', arguments: { owner: 'sample' } });
  assert.equal(r.status, 200, r.text);
  const body = text(r);
  assert.equal(body.synthetic, true);
  assert.equal(body.items[0].tool, 'list_accounts');
  assert.equal(body.items[0].note, SYNTHETIC_NOTE);
  assert.deepEqual(body.items[0].arguments, { owner: 'sample' });
  const single = text(await s.call('POST', `/api/connections/${admin.id}/call`, { tool: 'get_balance', arguments: {} }));
  assert.equal(single.synthetic, true); assert.equal(single.items, undefined, 'a non-list tool gets one record');
  const del = await s.call('POST', `/api/connections/${admin.id}/call`, { tool: 'delete_account', arguments: { id: 'a1' } });
  assert.notEqual(del.status, 200, 'writes are off, so the recorded delete is blocked like any other');
  assert.ok(!methods.includes('tools/call'), 'the Live server is never called by the mock demo');
});

test('a recorded fixture wins over the synthetic reply', async () => {
  await s.call('POST', '/api/fixtures', { tool: 'list_accounts', result: { content: [{ type: 'text', text: JSON.stringify({ accounts: [{ id: 'real-1' }] }) }] }, connectionId: live.id });
  const r = await s.call('POST', `/api/connections/${admin.id}/call`, { tool: 'list_accounts', arguments: {} });
  assert.equal(text(r).accounts[0].id, 'real-1');
  assert.ok(r.json.result._meta.recordedFrom.includes('banking stub'));
  await s.call('DELETE', '/api/fixtures/list_accounts');
});

test('forgetting the recorded tools removes them from the mock demo', async () => {
  const r = await s.call('DELETE', '/api/recorded-tools');
  assert.deepEqual(r.json, { ok: true, removed: 4 });
  assert.ok(!(await listed(admin)).some((t) => t.name === 'list_accounts'));
  assert.equal((await s.call('POST', `/api/connections/${admin.id}/call`, { tool: 'list_accounts', arguments: {} })).status, 404);
});

test('the mock answers a catalog tool it has no data for with the synthetic record, not a bare ok', async () => {
  const m = createMock();
  await m.start();
  try {
    const post = (p, body, headers) => fetch(`${m.base}${p}`, { method: 'POST', headers, body }).then((x) => x.json());
    const tok = await mockToken(m.base);
    const r = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncTenantWidgets', arguments: { environmentId: 'e' } } }), { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
    const out = JSON.parse(r.result.content[0].text);
    assert.deepEqual(out, { tool: 'syncTenantWidgets', synthetic: true, note: SYNTHETIC_NOTE, arguments: { environmentId: 'e' } });
  } finally { await m.stop(); }
});
