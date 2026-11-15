// POST /api/reset: run state goes back to the start; saved connections are kept.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { addSignedIn, ENV_ID, signIn, startApp } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
let s;
before(async () => { s = await startApp(); });
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

test('Reset clears the audit, the tokens (so the sign-in), writes and the mock tenant, and keeps the connection', async () => {
  const c = await addSignedIn(s);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/test`)).json.ok, true);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/settings`, { allowWrites: true })).json.allowWrites, true);
  const args = { environmentId: ENV_ID, username: 'reset.me' };
  const first = await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: args });
  assert.equal(first.status, 409);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/call`, { tool: 'createUser', arguments: args, confirm: true, argsHash: first.json.argsHash })).status, 200);
  assert.ok(s.mock.tenant.users.some((u) => u.username === 'reset.me'));
  assert.equal((await s.call('GET', '/api/connections')).json.connections[0].auth_status.signedIn, true);
  assert.ok((await s.call('GET', '/api/audit')).json.entries.length >= 1);

  const r = await s.call('POST', '/api/reset', {});
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.writesTurnedOff, 1); assert.deepEqual(r.json.kept, ['connections']);

  assert.deepEqual((await s.call('GET', '/api/audit')).json.entries, []);
  const list = (await s.call('GET', '/api/connections')).json.connections;
  assert.equal(list.length, 1, 'the connection is kept'); assert.equal(list[0].allowWrites, false); assert.deepEqual(list[0].auth_status, { signedIn: false });
  assert.ok(!s.mock.tenant.users.some((u) => u.username === 'reset.me'), 'the fake tenant is back to its starting records');
  assert.equal(s.mock.config.calls.length, 0);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/test`)).status, 401, 'the tokens are gone: the kept connection needs a new sign-in');
  await signIn(s, c.id);
  assert.equal((await s.call('POST', `/api/connections/${c.id}/test`)).json.ok, true, 'the kept connection works again after signing in');
});

test('Reset is a same-origin POST like every write, and a second Reset changes nothing', async () => {
  assert.equal((await s.call('POST', '/api/reset', {}, { origin: 'http://evil.example' })).status, 403);
  const again = await s.call('POST', '/api/reset', {});
  assert.equal(again.status, 200); assert.equal(again.json.writesTurnedOff, 0);
});
