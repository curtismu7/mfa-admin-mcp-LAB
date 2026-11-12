// The repo must carry no tenant identifier: the only UUID allowed is the placeholder used by tests, and no private host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.data']);
const PLACEHOLDER = '11111111-2222-4333-8444-555555555555';
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (!/package-lock\.json$/.test(p)) yield p; } }

test('no UUID other than the placeholder, no private host, no key material', () => {
  const bad = [];
  const privateHost = new RegExp(['ping', 'devops'].join('-') + '\\.com', 'i');
  const allowedHosts = new RegExp('(?:pingone-mcp-inspector\\.)?local\\.' + ['ping', 'devops'].join('-') + '\\.com', 'gi');
  for (const f of walk(root)) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []) if (m !== PLACEHOLDER) bad.push(`${f}: uuid ${m}`);
    // The lab-proxy's public name and this app's own Host name are the two allowed uses (LAB_ALLOWED_HOSTS and its tests).
    if (privateHost.test(t.replace(allowedHosts, ''))) bad.push(`${f}: private host`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) bad.push(`${f}: private key`);
  }
  assert.deepEqual(bad, []);
});
