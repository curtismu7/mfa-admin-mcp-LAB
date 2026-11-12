#!/usr/bin/env node
// Reset a running app: POST /api/reset clears the audit history, every token and half-finished sign-in, turns writes off and puts the
// mock demo's fake tenant back. Saved connections and their secrets are kept. The UI Reset button also puts the diagram boxes back
// where they started; a script cannot move boxes in a browser tab.
//   node scripts/reset.mjs [base-url]      (default http://127.0.0.1:${PORT:-5201})
// Loopback only: refuses any other host. Needs the server already running; sends the same-origin header the server requires.
import { pathToFileURL } from 'node:url';
import { isLoopbackHost } from '../server/src/security.js';

export async function reset(base = `http://127.0.0.1:${process.env.PORT || 5201}`) {
  const u = new URL(base);
  if (!isLoopbackHost(u.hostname)) throw new Error(`refusing ${u.hostname}: loopback only`);
  const r = await fetch(new URL('/api/reset', u), { method: 'POST', headers: { 'content-type': 'application/json', origin: u.origin }, body: '{}' });
  if (!r.ok) throw new Error(`reset failed: HTTP ${r.status}`);
  return r.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reset(process.argv[2]).then(() => console.log('reset: ok'), (e) => { console.error(e.message); process.exit(1); });
}
