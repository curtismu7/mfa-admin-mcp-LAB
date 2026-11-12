// Repo-level pins for the -LAB standard: files, README standard, CSS standard, CI, Node 26, no SE build, no bare MODE, no EC keygen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WEB_JSX = ['App.jsx', 'components/Banner.jsx', 'components/CallView.jsx', 'components/ConfirmDialog.jsx', 'components/HealthCard.jsx', 'components/ScanPanel.jsx', 'pages/Audit.jsx', 'pages/Connections.jsx', 'pages/Diagram.jsx', 'pages/McpFirst.jsx', 'pages/Raw.jsx', 'pages/Stories.jsx', 'pages/Tool.jsx', 'pages/Tools.jsx', 'present/Present.jsx', 'story/StoryPanel.jsx'];
const SKIP = new Set(['node_modules', 'dist', '.git', 'package-lock.json', '.data']);
const walk = (dir, fn) => {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, fn); else fn(p, name);
  }
};

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.nvmrc', '.env.example', '.gitignore', '.github/workflows/ci.yml', 'docs/talk-track.md', 'docs/security.md', 'docs/content-pack.schema.json', 'docs/shelf-entry.json', 'content-pack.json', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'scripts/smoke.mjs', 'web/src/styles/standalone-ui.css', 'web/src/app.css']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('package.json has the standard scripts and requires Node 26; the Dockerfile uses a Node 26 base', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const s of ['start', 'dev', 'test', 'build', 'doctor', 'reset', 'prepare', 'smoke']) assert.ok(pkg.scripts[s], s);
  assert.equal(pkg.engines.node, '>=26');
  assert.ok((read('Dockerfile').match(/^FROM node:26-alpine/gm) || []).length === 2);
  assert.match(pkg.scripts.test, /node --test scripts\/\*\.test\.mjs/, 'the scripts tests run by glob, never a directory');
  assert.match(JSON.parse(read('server/package.json')).scripts.test, /test\/\*\.test\.js/, 'the server tests run by glob');
});

test('README follows the README standard: title ends in LAB, plain Tier, Repo and Catalog lines, the port text, the twelve sections in order; no internal names', () => {
  const r = read('README.md');
  assert.match(r.split('\n')[0], /^# .* LAB$/);
  assert.match(r, /^Tier: Tester$/m);
  assert.match(r, /^Repo: https:\/\/github\.com\/curtismu7\/pingone-mcp-inspector-LAB$/m);
  assert.match(r, /^Catalog: D3$/m);
  const at = (h) => r.indexOf(`\n## ${h}`);
  const order = ['What is simulated', 'Run from a clone', 'Settings file', 'Ports, and what to do if the port is taken', 'Mock and live modes', 'Health, doctor and reset', 'Docker (optional)', 'Tests', 'Troubleshooting', 'Ownership'].map(at);
  assert.ok(order.every((i) => i > 0), order.join());
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections are in order');
  assert.match(r, /lsof -iTCP:5201 -sTCP:LISTEN -n -P/);
  assert.match(r, /PORT=<other port> npm start/);
  assert.match(r, /util\.parseEnv/);
  assert.doesNotMatch(r, /Rule 17 gap/, 'the diagram is loaded from diagram-studio/1 data, so the gap note is gone');
  assert.match(r, /GET \/api\/diagrams\/:name/);
  assert.ok(!/ping-devops|cmuir/i.test(r));
  assert.ok(!/TEST_COUNTS_PLACEHOLDER/.test(r), 'the test counts are filled in');
});

test('rule 17: the diagram is diagram-studio/1 data in server/diagrams, validated and served by name, copied into the image, and the page builds no nodes or edges itself', () => {
  const dir = path.join(root, 'server', 'diagrams');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['interactive.json', 'worker.json']);
  for (const f of files) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).schema, 'diagram-studio/1', f);
  assert.match(read('Dockerfile'), /^COPY server\/diagrams server\/diagrams$/m, 'the image carries the diagram files');
  assert.match(read('server/src/app.js'), /createDiagrams\(/);
  const page = read('web/src/pages/Diagram.jsx');
  assert.match(page, /get\(`\/api\/diagrams\/\$\{encodeURIComponent\(scenario\)\}`\)/, 'the page fetches the diagram by name');
  assert.doesNotMatch(page, /\b(START|EDGES|SCENARIOS)\b/, 'no hand-built node, edge or scenario tables');
  assert.doesNotMatch(page, /position:\s*\{\s*x:\s*-?\d/, 'no literal box positions');
  assert.doesNotMatch(page, /Your browser|PingOne admin API/, 'no box text in the component');
  assert.ok(!/Rule 17 gap/.test(read('CLAUDE.md') + read('README.md') + read('CHANGELOG.md').split('## ')[1]), 'no gap note is left in the current docs');
});

test('app CSS follows the CSS standard: tokens only, no dark-mode media query, no forced priority, no italics, breakpoints 600 and 900 only, no purple, shared stylesheet first', () => {
  const css = read('web/src/app.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(css), 'no colour literal');
  assert.ok(!/prefers-color-scheme/.test(css)); assert.ok(!/!important/.test(css)); assert.ok(!/font-style:\s*italic/.test(css));
  const widths = [...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => m[1]);
  assert.ok(widths.every((w) => w === '600' || w === '900'), widths.join());
  assert.ok(!/purple|violet|magenta|indigo/i.test(css));
  assert.ok(!fs.existsSync(path.join(root, 'web/src/styles.css')), 'the old stylesheet with its own palette is gone');
  const main = read('web/src/main.jsx');
  assert.ok(main.indexOf('standalone-ui.css') >= 0 && main.indexOf('standalone-ui.css') < main.indexOf('app.css'), 'the shared stylesheet loads before the app stylesheet');
  assert.ok(!/<em>|<i>/.test(WEB_JSX.map((f) => read(`web/src/${f}`)).join('\n')), 'no <em> or <i>: emphasis is weight');
  assert.ok(!/\sstyle=\{\{[^}]*(color|background)/.test(WEB_JSX.map((f) => read(`web/src/${f}`)).join('\n')), 'no inline colours');
});

test('the CI workflow is GitHub-hosted, Node 26 only, and carries the forbidden-strings and gitleaks jobs', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.ok(!/self-hosted/.test(ci));
  const versions = [...ci.matchAll(/node-version: (\S+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 3 && versions.every((v) => v === '26'), versions.join());
  assert.match(ci, /forbidden-strings:/);
  assert.match(ci, /gitleaks/);
  assert.match(ci, /actions\/checkout@v5/);
  assert.match(ci, /PORT=5230 npm run doctor/);
});

test('the repo ships no k8s manifests, no deploy scripts, no hosted mode and no bare MODE', () => {
  for (const d of ['k8s', 'deploy', 'server/src/workspaces.js']) assert.ok(!fs.existsSync(path.join(root, d)), d);
  const hits = [];
  walk(root, (p, name) => {
    if (/\.test\.m?jsx?$/.test(name) || !(/\.(m?jsx?|json|ya?ml|html|css)$/.test(name) || name === 'Dockerfile')) return;
    if (/process\.env\.MODE\b|env\.MODE\b|se-mock|SE_HOST|__IMAGE__|VITE_BASE_PATH/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
  });
  assert.deepEqual(hits, []);
});

test('no EC key generation through generateKeyPair(Sync) anywhere (SIGABRT on Node 20 CI); RSA is fine', () => {
  const hits = [];
  walk(root, (p, name) => {
    if (!/\.(m?jsx?)$/.test(name) || name === 'repo.test.mjs') return;
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/generateKeyPair(Sync)?\(\s*['"]([a-z0-9-]+)['"]/g)) if (m[2] !== 'rsa') hits.push(`${path.relative(root, p)}: ${m[2]}`);
  });
  assert.deepEqual(hits, []);
});

test('Live stays an opt-in: the page opens in Mock, and the only mode key is PINGONE_MCP_INSPECTOR_MODE', () => {
  const app = read('web/src/App.jsx');
  assert.match(app, /useState\("mock"\)/);
  const cfg = read('server/src/config.js');
  assert.match(cfg, /PINGONE_MCP_INSPECTOR_MODE/);
  assert.doesNotMatch(read('server/src/settings.js'), /['"]MODE['"]/);
  assert.match(read('server/src/index.js'), /applySharedSettings\(\)/);
  assert.doesNotMatch(read('server/src/index.js') + read('scripts/doctor.mjs'), /loadEnvFile/, 'no per-app .env is loaded; the shared settings file is read through util.parseEnv');
});

test('no shipped text names a real customer, company, tenant or personal path, and uses no retired wording', () => {
  const retired = new RegExp(`\\b${['do', 'or'].join('')}s?\\b`, 'i');
  const hits = [];
  walk(root, (p, name) => {
    if (/(repo|docs|content-pack|shelf-entry)\.test\.mjs$/.test(p) || /\.(png|jpg|ico)$/.test(name)) return;
    // The two lab-proxy names are the one allowed use of "ping-devops": the proxy's public name (the Origin check and its tests name it)
    // and this app's own Host name (the compose default for LAB_ALLOWED_HOSTS). Anything else with that word is still a hit.
    const t = fs.readFileSync(p, 'utf8').replace(/(?:pingone-mcp-inspector\.)?local\.ping-devops\.com/gi, 'LAB-HOST');
    for (const w of ['united airlines', 'mileageplus', 'datapower', 'optum', 'unitedhealth', 'uhg', 'personal-agent', 'ping-devops', 'amazonaws.com', '/users/cmuir', 'cmuir_pingcorp']) if (t.toLowerCase().includes(w)) hits.push(`${path.relative(root, p)}: ${w}`);
    if (/\.(md|json)$/.test(name) && retired.test(t)) hits.push(`${path.relative(root, p)}: retired wording`);
  });
  assert.deepEqual(hits, []);
});
