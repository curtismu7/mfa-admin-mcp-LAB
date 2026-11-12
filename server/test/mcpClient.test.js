import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { createMcpClient, MAX_BYTES } from '../src/mcpClient.js';
import { createMock } from '../src/mock.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
after(() => { assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });
const mock = createMock();
before(() => mock.start());
after(() => mock.stop());

const tok = async () => { const r = await fetch(`${mock.base}/e/as/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=admin-app&client_secret=s' }); return (await r.json()).access_token; };

test('JSON and a single SSE frame both parse', async () => {
  const t = await tok();
  const c = createMcpClient({ url: `${mock.base}/mcp/e`, getAuth: async () => ['Authorization', `Bearer ${t}`] });
  mock.config.sse = false; const a = await c.listTools();
  mock.config.sse = true; const b = await c.listTools();
  mock.config.sse = false;
  assert.ok(a.length > 10); assert.deepEqual(a, b);
});
test('role-gated lists: viewer sees read tools only, admin sees all', async () => {
  const get = async (id) => { const r = await fetch(`${mock.base}/e/as/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${id}&client_secret=s` }); const t = (await r.json()).access_token; return createMcpClient({ url: `${mock.base}/mcp/e`, getAuth: async () => ['Authorization', `Bearer ${t}`] }).listTools(); };
  const v = await get('viewer-app'); const a = await get('admin-app');
  assert.ok(v.length < a.length);
  assert.ok(v.every((t) => /^(list|get|search|describe)/.test(t.name)));
  assert.ok(a.some((t) => t.name === 'deleteUser') && !v.some((t) => t.name === 'deleteUser'));
});
test('401 triggers refreshAuth once then retries; without a fix it surfaces', async () => {
  let t = await tok(); let refreshed = 0;
  const c = createMcpClient({ url: `${mock.base}/mcp/e`, getAuth: async () => ['Authorization', `Bearer ${t}`], refreshAuth: async () => { refreshed++; t = await tok(); return true; } });
  mock.revoke(t);
  assert.ok((await c.listTools()).length > 0); assert.equal(refreshed, 1);
  mock.revoke(t); mock.revoke('nope');
  const bad = createMcpClient({ url: `${mock.base}/mcp/e`, getAuth: async () => ['Authorization', 'Bearer nope'], refreshAuth: async () => false });
  await assert.rejects(bad.listTools(), (e) => e.httpStatus === 401);
  let n = 0;
  const loop = createMcpClient({ url: `${mock.base}/mcp/e`, getAuth: async () => ['Authorization', 'Bearer nope'], refreshAuth: async () => { n++; return true; } });
  await assert.rejects(loop.listTools(), (e) => e.httpStatus === 401);
  assert.equal(n, 1, 'retries only once');
});
test('redirects are refused, oversize and malformed replies fail, timeouts are reported', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: 'https://example.invalid/' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(`{"x":"${'a'.repeat(MAX_BYTES + 10)}"}`); }
    if (req.url === '/junk') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: not json\n\n'); }
    if (req.url === '/hang') return; // never answers
    if (req.url === '/drip') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hi\n'); return; } // headers, then silence
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(createMcpClient({ url: `${base}/redir` }).listTools(), (e) => e.code === 'mcp_http_error' && /redirects/.test(e.message));
    await assert.rejects(createMcpClient({ url: `${base}/big` }).listTools(), (e) => e.code === 'mcp_reply_too_large');
    await assert.rejects(createMcpClient({ url: `${base}/junk` }).listTools(), (e) => e.code === 'mcp_bad_reply');
    await assert.rejects(createMcpClient({ url: `${base}/hang`, timeoutMs: 150 }).listTools(), (e) => e.code === 'mcp_timeout');
    await assert.rejects(createMcpClient({ url: `${base}/drip`, timeoutMs: 300 }).listTools(), (e) => e.code === 'mcp_timeout' && /body/.test(e.message));
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  assert.deepEqual(guard.attempts, [], 'a refused redirect is never followed');
});

test('handshake: initialize first, then protocol-version and session id on every later call (spec-strict server)', async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body); const h = init.headers; seen.push({ method: body.method, pv: h['mcp-protocol-version'], sid: h['mcp-session-id'] });
    const json = (o, extra = {}) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json', ...extra } });
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, { 'mcp-session-id': 'sess-1' });
    if (!h['mcp-protocol-version']) return new Response('{"error":"mcp-protocol-version header is required"}', { status: 400 });
    if (!body.id) return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 't' }] } });
  };
  const c = createMcpClient({ url: 'http://stub.invalid/mcp', handshake: true, fetchImpl });
  assert.deepEqual(await c.listTools(), [{ name: 't' }]);
  await c.listTools();
  assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'], 'handshake runs once');
  assert.ok(seen.slice(1).every((s) => s.pv === '2025-03-26' && s.sid === 'sess-1'));
  assert.equal(seen[0].pv, undefined);
});
