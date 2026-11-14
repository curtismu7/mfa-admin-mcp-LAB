// /suggest: fills a tool argument from the connection's own read tool. Only known fields,
// only read lookups, gated like any call.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { startApp, tmpDir, workerConn, ENV_ID } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();

// A stub MCP server that exposes ListIndexTool (OpenSearch-style) and listUsers (PingOne-style).
const replies = {
  ListIndexTool: { content: [{ type: 'text', text: JSON.stringify({ indices: [{ index: 'accounts-2026' }, { index: 'transactions' }] }) }] },
  listUsers: { content: [{ type: 'text', text: JSON.stringify({ _embedded: { users: [{ id: 'u-1', username: 'alice' }, { id: 'u-2', username: 'bob' }] } }) }] },
};
const calls = [];
async function stubFetch(url, init = {}) {
  const body = init.body ? JSON.parse(String(init.body)) : null;
  if (body?.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } });
  if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body?.method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [
      { name: 'ListIndexTool', description: 'list indices', inputSchema: { type: 'object', properties: { index: { type: 'string', default: '' } } }, annotations: { readOnlyHint: true } },
      { name: 'IndexMappingTool', description: 'mapping', inputSchema: { type: 'object', properties: { index: { type: 'string' } }, required: ['index'] }, annotations: { readOnlyHint: true } },
      { name: 'listUsers', description: 'users', inputSchema: { type: 'object', properties: { environmentId: { type: 'string' }, limit: { type: 'integer' } } }, annotations: { readOnlyHint: true } },
    ] } });
  }
  if (body?.method === 'tools/call') {
    calls.push({ tool: body.params.name, args: body.params.arguments });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: replies[body.params.name] });
  }
  return new Response('nope', { status: 404 });
}

let s;
before(async () => {
  s = await startApp({ env: {}, fetchImpl: stubFetch, dir: tmpDir() });
  // a custom (live) connection to the stub; the mock AS mints nothing, custom carries no token
  const base = s.mock.base;
  const r = await s.call('POST', '/api/connections', { kind: 'custom', url: `${base}/mcp/${ENV_ID}` });
  assert.equal(r.status, 201, r.text);
  s.connId = r.json.id;
});
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound beyond the stub'); guard.restore(); });

test('suggest: index field fills from ListIndexTool; user field from listUsers with the environment id; unknown field refused', async () => {
  const r1 = await s.call('POST', `/api/connections/${s.connId}/suggest`, { field: 'index' });
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual(r1.json.values, ['accounts-2026', 'transactions']);
  assert.equal(r1.json.via, 'ListIndexTool');
  assert.equal(calls.at(-1).args.index, '', 'the empty pattern lists all indices');

  const r2 = await s.call('POST', `/api/connections/${s.connId}/suggest`, { field: 'userId' });
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual([...r2.json.values].sort(), ['alice', 'bob', 'u-1', 'u-2']);

  const r3 = await s.call('POST', `/api/connections/${s.connId}/suggest`, { field: 'banana' });
  assert.equal(r3.status, 400);
});
