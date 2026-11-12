import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createApp } from '../src/app.js';
import { DIAGRAM_DIR, DIAGRAM_NAMES, createDiagrams } from '../src/diagrams.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { runChecks } from '../src/doctor.js';
import { startApp, tmpDir } from './helpers.js';
import { installNetguard } from './netguard.js';

const guard = installNetguard();
let s;
before(async () => { s = await startApp(); });
after(async () => { await s.close(); assert.deepEqual(guard.attempts, [], 'zero outbound attempts'); guard.restore(); });

const read = (n) => JSON.parse(fs.readFileSync(path.join(DIAGRAM_DIR, `${n}.json`), 'utf8'));
// A copy of the real diagram directory in a temp dir, with one file changed by `edit`.
function brokenDir(name, edit) {
  const dir = tmpDir();
  for (const n of DIAGRAM_NAMES) fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(read(n)));
  const doc = read(name); edit(doc);
  fs.writeFileSync(path.join(dir, `${name}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return dir;
}

test('the two diagrams are valid diagram-studio/1 data under the studio validator copy, and the files carry the schema name', () => {
  assert.deepEqual([...DIAGRAM_NAMES], ['worker', 'interactive']);
  for (const n of DIAGRAM_NAMES) {
    const d = read(n);
    assert.equal(d.schema, 'diagram-studio/1');
    assert.equal(d.id, n);
    assert.deepEqual(validateDiagram(d), [], n);
  }
});

test('the data keeps the original picture: five boxes, one layout, 5 arrows and steps for the worker, 7 for the interactive sign-in, two dashed redirect arrows', () => {
  const w = read('worker'), i = read('interactive');
  assert.deepEqual(w.nodes.map((n) => [n.id, n.x, n.y]), [['browser', 0, 150], ['app', 300, 150], ['token', 300, -60], ['mcp', 600, 150], ['api', 900, 150]]);
  assert.deepEqual(i.nodes, w.nodes, 'both models share one layout');
  assert.equal(w.edges.length, 5); assert.equal(w.steps.length, 5);
  assert.equal(i.edges.length, 7); assert.equal(i.steps.length, 7);
  assert.deepEqual(i.edges.filter((e) => e.dashed).map((e) => e.label), ['sign in (redirect)', 'back with a code']);
  assert.equal(w.edges.filter((e) => e.dashed).length, 0);
  for (const d of [w, i]) assert.deepEqual(d.steps.map((st) => st.edges), d.edges.map((_, k) => [k]), 'each step walks one arrow, in order');
});

test('GET /api/diagrams lists names and titles; GET /api/diagrams/:name returns exactly the validated file', async () => {
  const list = await s.call('GET', '/api/diagrams');
  assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.json, { diagrams: DIAGRAM_NAMES.map((n) => ({ name: n, title: read(n).title })) });
  for (const n of DIAGRAM_NAMES) {
    const r = await s.call('GET', `/api/diagrams/${n}`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /json/);
    assert.equal(r.headers.get('cache-control'), 'no-store', `${n} detail route must not be cached`);
    assert.deepEqual(r.json, read(n));
    assert.deepEqual(validateDiagram(r.json), []);
  }
});

test('an unknown name is a JSON 404 that does not echo the input; prototype-key names are refused the same way', async () => {
  const bad = ['nope', 'WORKER', 'worker.json', 'worker%20', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', '..%2Fapp', '%2e%2e%2f%2e%2e%2fpackage', 'worker%00', 'ZZ-CANARY-diagram-name-123', '%E0%A4%A'];
  const safeDecode = (n) => { try { return decodeURIComponent(n); } catch { return n; } };
  for (const n of bad) {
    const r = await s.call('GET', `/api/diagrams/${n}`);
    assert.ok(r.status >= 400, `${n} -> ${r.status}`);
    assert.match(r.headers.get('content-type'), /json/, n);
    for (const form of [n, safeDecode(n)]) if (form.length > 3) assert.ok(!r.text.includes(form), `${n} was echoed: ${r.text}`);
  }
  const r = await s.call('GET', '/api/diagrams/ZZ-CANARY-diagram-name-123');
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: 'unknown_diagram', message: 'No such diagram.' });
  const malformed = await s.call('GET', '/api/diagrams/%E0%A4%A');
  assert.equal(malformed.status, 400); assert.deepEqual(malformed.json, { error: 'bad_request', message: 'bad address' });
  assert.equal((await s.call('GET', '/api/diagrams/__proto__')).status, 404);
  assert.equal((await s.call('GET', '/api/diagrams/constructor')).status, 404);
  assert.equal((await s.call('GET', '/api/diagrams/worker/extra')).status, 404);
  assert.equal((await s.call('GET', '/api/diagrams?name=__proto__')).json.diagrams.length, 2, 'a query string is ignored');
});

test('diagrams are read-only over HTTP: POST, PUT and DELETE are refused', async () => {
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const r = await s.call(m, '/api/diagrams/worker', {});
    assert.equal(r.status, 404, m);
    assert.deepEqual(read('worker'), (await s.call('GET', '/api/diagrams/worker')).json);
  }
});

test('the loader refuses to start on an invalid, missing or unreadable file', () => {
  const cases = [
    ['wrong schema', (d) => { d.schema = 'diagram-studio/2'; }, /schema/],
    ['an arrow to a box that does not exist', (d) => { d.edges[0].target = 'ghost'; }, /unknown target/],
    ['a step that points at a missing arrow', (d) => { d.steps[0].edges = [99]; }, /edges/],
    ['an unknown group', (d) => { d.nodes[0].group = 'nope'; }, /unknown group/],
    ['an id that is not the file name', (d) => { d.id = 'interactive'; }, /id must equal/],
    ['no steps', (d) => { d.steps = []; }, /at least one step/],
    ['a bad handles hint', (d) => { d.edges[0].handles = ['r1', 'zz']; }, /handles/],
    ['a handles hint that is not a pair', (d) => { d.edges[0].handles = 'r1'; }, /handles/],
  ];
  for (const [what, edit, re] of cases) {
    const dir = brokenDir('worker', edit);
    assert.throws(() => createDiagrams({ dir }), re, what);
    assert.throws(() => createApp({ env: { P1MCP_DATA_DIR: tmpDir() }, diagramsDir: dir }), re, `${what}: createApp (so the server) does not start`);
  }
  const garbage = tmpDir(); for (const n of DIAGRAM_NAMES) fs.writeFileSync(path.join(garbage, `${n}.json`), '{ not json');
  assert.throws(() => createDiagrams({ dir: garbage }), /cannot be read as JSON/);
  const empty = tmpDir();
  assert.throws(() => createDiagrams({ dir: empty }), /cannot be read as JSON/, 'a missing file stops startup');
  assert.doesNotThrow(() => createDiagrams({ dir: brokenDir('worker', () => {}) }), 'an unchanged copy loads');
});

test('lookups never reach object prototypes: only the allow-list names resolve', () => {
  const d = createDiagrams();
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '', 'worker ', ' worker', 'Worker']) assert.equal(d.get(k), null, JSON.stringify(k));
  for (const k of [undefined, null, 1, {}, [], ['worker'], { toString: () => 'worker' }]) assert.equal(d.get(k), null);
  assert.equal(d.get('worker').id, 'worker');
});

test('doctor has a diagrams check that passes on the shipped files', () => {
  const c = runChecks({ env: { ...process.env, P1MCP_DATA_DIR: tmpDir() } }).find((x) => x.id === 'diagrams');
  assert.equal(c.level, 'pass'); assert.match(c.detail, /2 diagrams are valid diagram-studio\/1 data/);
});
