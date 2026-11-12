import assert from 'node:assert/strict';
import test from 'node:test';
import { area, classify } from '../src/classify.js';
import { validateArgs } from '../src/validate.js';
import { GOLDEN } from './golden.js';

test('classification golden table', () => {
  for (const [name, annotations, want] of GOLDEN) assert.equal(classify({ name, annotations }).class, want, `${name} ${JSON.stringify(annotations)}`);
});
test('classification records its source', () => {
  assert.equal(classify({ name: 'frobnicate' }).source, 'unknown');
  assert.equal(classify({ name: 'listUsers' }).source, 'name');
  assert.equal(classify({ name: 'frobnicate', annotations: { readOnlyHint: true } }).source, 'unknown');
});
test('area grouping by name', () => {
  assert.equal(area('listApplications'), 'application');
  assert.equal(area('createUser'), 'user');
  assert.equal(area('getUser'), 'user');
  assert.equal(area('users_list'), 'user');
});
test('camelCase validator warns on snake_case, unknown and missing', () => {
  const schema = { properties: { environmentId: {}, userId: {} }, required: ['environmentId'] };
  const w = validateArgs(schema, { environment_id: 'x', userId: 'y', bogus: 1 });
  assert.deepEqual(w.map((x) => [x.param, x.kind]).sort(), [['bogus', 'unknown'], ['environmentId', 'missing'], ['environment_id', 'snake_case']].sort());
  assert.match(w.find((x) => x.kind === 'snake_case').message, /environmentId/);
  assert.deepEqual(validateArgs(schema, { environmentId: 'e' }), []);
  assert.deepEqual(validateArgs(null, { a: 1 }), []);
});
test('docs/classification.md is generated from the golden table and is not stale', async () => {
  const { render } = await import('../../scripts/gen-classification.mjs');
  const fs = await import('node:fs');
  assert.equal(fs.readFileSync(new URL('../../docs/classification.md', import.meta.url), 'utf8'), render());
});
