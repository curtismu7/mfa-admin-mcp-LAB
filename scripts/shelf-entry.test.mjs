import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { shelfProblems } from './lib/shelf-registry-rules.mjs';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const entry = JSON.parse(read('../docs/shelf-entry.json'));

test('docs/shelf-entry.json passes the shelf registry rules (copied into scripts/lib/shelf-registry-rules.mjs)', () => {
  assert.deepEqual(shelfProblems(entry.demos), []);
});

test('the entry matches this app: id, catalog id D3 (also in the content pack and the README), port 5201, /api/health, a relative compose file', () => {
  const [d] = entry.demos;
  assert.equal(d.id, 'pingone-mcp-inspector');
  assert.equal(d.catalogId, 'D3');
  assert.equal(d.kind, 'Tester');
  assert.equal(d.composeFile, 'pingone-mcp-inspector-LAB/docker-compose.yml');
  assert.ok(!path.isAbsolute(d.composeFile), 'composeFile must be relative or a placeholder');
  assert.ok(!/\/Users\//.test(JSON.stringify(entry)), 'no absolute home path');
  assert.equal(d.url, 'http://localhost:5201');
  assert.equal(d.healthPath, '/api/health');
  assert.equal(JSON.parse(read('../content-pack.json')).demo.catalog, 'D3');
  assert.match(read('../README.md'), /^Catalog: D3$/m);
  const pkg = JSON.parse(read('../package.json'));
  assert.ok(pkg.scripts.start && pkg.scripts.doctor);
  assert.match(read('../docker-compose.yml'), /127\.0\.0\.1:\$\{HOST_PORT:-5201\}:5201/);
});

test('the copied rules reject a bad entry', () => {
  const bad = [{ ...entry.demos[0], url: 'http://evil.example:5201', healthPath: '//x', composeFile: '../x;y.yml', surprise: 1 }];
  assert.ok(shelfProblems(bad).length >= 4);
});
