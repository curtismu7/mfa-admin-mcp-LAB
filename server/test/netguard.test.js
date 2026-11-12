import assert from 'node:assert/strict';
import test from 'node:test';
import { installNetguard } from './netguard.js';
import { createMock } from '../src/mock.js';

test('netguard self-test: blocks and records a non-loopback fetch and socket, allows loopback', async () => {
  const g = installNetguard();
  try {
    await assert.rejects(fetch('https://example.invalid/x'), /netguard/);
    await assert.rejects(fetch('https://auth.pingone.com/x'), /netguard/);
    assert.deepEqual(g.attempts.map((a) => a.host), ['example.invalid', 'auth.pingone.com']);
    const net = await import('node:net');
    assert.throws(() => net.connect({ host: '203.0.113.9', port: 80 }), /netguard/);
    assert.equal(g.attempts.at(-1).via, 'socket');
    g.attempts.length = 0;
    const m = createMock(); await m.start();
    try { assert.equal((await fetch(`${m.base}/nothing`)).status, 404); } finally { await m.stop(); }
    assert.equal(g.attempts.length, 0, 'loopback traffic is not an attempt');
  } finally { g.restore(); }
});
