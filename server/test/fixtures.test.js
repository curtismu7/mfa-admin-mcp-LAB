// Recorded fixtures: a real response captured from a Live connection is stored, listed, replayed
// by the mock demo for the same tool name, then deleted. Secrets in a recorded result are scrubbed
// before the fixture is written (listing, replay and the file on disk all carry no secret).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { ENV_ID, startApp, tmpDir } from './helpers.js';

const SECRET = 'supersecret-value-1';
const s = await startApp({ dir: tmpDir() });
const live = (await s.call('POST', '/api/connections', { kind: 'custom', label: 'recording source', url: 'http://127.0.0.1:9/mcp', token: SECRET })).json;

test('record, list, replay by the mock, delete', async () => {
  const recorded = await s.call('POST', '/api/fixtures', { tool: 'get_customer', result: { content: [{ type: 'text', text: JSON.stringify({ name: 'Jane', token: SECRET }) }] }, connectionId: live.id });
  assert.equal(recorded.status, 201, recorded.text);
  assert.equal(recorded.json.ok, true);
  assert.ok(recorded.json.source.includes('recording source'));

  const list = await s.call('GET', '/api/fixtures');
  assert.equal(list.json.count, 1);
  assert.equal(list.json.fixtures.get_customer.source.includes('recording source'), true);
  assert.ok(!list.text.includes(SECRET), 'secrets are scrubbed from the listing');

  // the mock replays the real result for the same tool name, labelled as a recording
  const mockConn = (await s.call('POST', '/api/connections', { kind: 'pingone', offline: true, label: 'mock', region: 'com', envId: ENV_ID, endpointStyle: 'api', auth: 'worker', clientId: 'admin-demo', clientSecret: 'x' })).json;
  const replay = await s.call('POST', `/api/connections/${mockConn.id}/call`, { tool: 'get_customer', arguments: {} });
  assert.equal(replay.status, 200, replay.text);
  const text = replay.json.result?.content?.[0]?.text;
  assert.equal(JSON.parse(text).name, 'Jane', 'the recorded payload is replayed verbatim');
  assert.ok(replay.json.result?._meta?.recordedFrom?.includes('recording source'), 'the replay says it is a recording');
  assert.ok(!replay.text.includes(SECRET), 'no secret in the replay either');

  const del = await s.call('DELETE', '/api/fixtures/get_customer');
  assert.equal(del.json.ok, true);
  assert.equal((await s.call('GET', '/api/fixtures')).json.count, 0);
  const again = await s.call('POST', `/api/connections/${mockConn.id}/call`, { tool: 'get_customer', arguments: {} });
  assert.equal(JSON.parse(again.json.result?.content?.[0]?.text || '{}').name, undefined, 'without the fixture the mock answers with its own sample again');
});

test('recording is refused without a tool or result, and the file on disk holds no secret', async () => {
  assert.equal((await s.call('POST', '/api/fixtures', { result: { a: 1 } })).status, 400);
  assert.equal((await s.call('POST', '/api/fixtures', { tool: 'x' })).status, 400);
  const onDisk = fs.readFileSync(path.join(s.dir, 'fixtures.json'), 'utf8');
  assert.ok(!onDisk.includes(SECRET), 'the fixture file is scrubbed');
});

after(async () => { await s.close(); });
