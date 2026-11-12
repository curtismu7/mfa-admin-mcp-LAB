import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers.js';

// Regression: the header "Shelf" button reads GET /api/shelf. It must answer with no web build present
// (web/dist is not built in the test run).
test('GET /api/shelf returns SHELF_URL (trailing slash trimmed) without a web build; POST is not 200', async () => {
  const prev = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  const s = await startApp();
  try {
    const r = await s.call('GET', '/api/shelf');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { shelfUrl: 'https://shelf.example:8443' });
    const p = await s.call('POST', '/api/shelf', {});
    assert.notEqual(p.status, 200);
  } finally {
    if (prev === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = prev;
    await s.close();
  }
});
