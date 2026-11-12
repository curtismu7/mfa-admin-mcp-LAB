// The docs must stay true: every test security.md names exists, every relative link resolves, README commands are real
// npm scripts, and the shelf entry is well-formed and loopback-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const testSources = Object.fromEntries(fs.readdirSync(path.join(root, 'server/test')).filter((f) => f.endsWith('.test.js')).map((f) => [f, read(`server/test/${f}`)]));

test('every `file :: test title` in docs/security.md names a test that exists', () => {
  const refs = [...read('docs/security.md').matchAll(/`([a-zA-Z]+\.test\.js) :: ([^`]+)`/g)];
  assert.ok(refs.length >= 15, `found ${refs.length} references`);
  for (const [, file, title] of refs) assert.ok(testSources[file]?.includes(title), `${file} has no test titled "${title}"`);
});
test('the "..." continuation titles in security.md also exist in auth.test.js', () => {
  for (const [, title] of read('docs/security.md').matchAll(/`\.\.\. ([^`]+)`/g)) assert.ok(testSources['auth.test.js'].includes(title), title);
});
test('relative markdown links in README and docs resolve', () => {
  for (const f of ['README.md', 'CHANGELOG.md', ...fs.readdirSync(path.join(root, 'docs')).filter((x) => x.endsWith('.md')).map((x) => `docs/${x}`)]) {
    for (const [, target] of read(f).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      assert.ok(fs.existsSync(path.join(root, path.dirname(f), target)), `${f}: broken link ${target}`);
    }
  }
});
test('every `npm run <script>` the README names exists in package.json', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const [, name] of read('README.md').matchAll(/npm run ([a-z0-9:-]+)/g)) assert.ok(scripts[name], `README names npm run ${name}`);
});
test('docs/shelf-entry.json is well-formed, loopback-only, and matches the compose port', () => {
  const { demos } = JSON.parse(read('docs/shelf-entry.json'));
  assert.equal(demos.length, 1);
  const [d] = demos;
  assert.match(d.id, /^[a-z0-9-]{2,41}$/);
  assert.equal(d.id, 'pingone-mcp-inspector');
  assert.match(d.url, /^http:\/\/localhost:5201$/);
  assert.equal(d.healthPath, '/api/health');
  assert.match(d.composeFile, /\/docker-compose\.yml$/);
  assert.ok(!d.composeFile.startsWith('/'), 'a portable (relative) compose file');
  assert.ok(d.name.length <= 300 && d.description.length <= 300);
});
test('classification.md, live-checks.md and architecture.md exist and the live checklist has its three required parts', () => {
  const lc = read('docs/live-checks.md');
  for (const h of ['## Stop if', '## Evidence template']) assert.ok(lc.includes(h), h);
  assert.match(lc, /one gated write/i);
  for (const f of ['docs/classification.md', 'docs/architecture.md', 'docs/security.md', 'docs/references.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
});
