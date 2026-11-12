import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PACK_PATH, buildPack, serialize } from './build-content-pack.mjs';
import { validatePack } from './validate-content-pack.mjs';

test('content-pack.json is exactly what the generator produces (run: npm run content-pack)', () => {
  assert.equal(fs.readFileSync(PACK_PATH, 'utf8'), serialize(buildPack()), 'content-pack.json is stale; regenerate it and commit the result');
});
test('the generator is deterministic', () => assert.equal(serialize(buildPack()), serialize(buildPack())));
test('content-pack.json validates against docs/content-pack.schema.json (ajv)', () => {
  assert.deepEqual(validatePack(JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))), []);
});
test('the validator rejects a broken pack', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['no-such-term'];
  delete pack.title;
  assert.ok(validatePack(pack).length >= 2);
});
test('the pack has the ten required terms, two story cards, and lists no source it did not fetch', () => {
  const pack = buildPack();
  for (const id of ['hosted-mcp-server', 'admin-plane', 'worker-application', 'client-credentials', 'authorization-code-pkce', 'role-gated-tool-list', 'mcp-first-rule', 'read-only-by-default', 'confirm-gate', 'audit-log']) assert.ok(pack.glossary.some((g) => g.id === id), id);
  assert.deepEqual(pack.sources, []);
  assert.deepEqual(pack.cards.filter((c) => c.story).map((c) => c.story).sort(), ['S01', 'S02']);
});
test('a commit is recorded only when passed', () => {
  assert.equal(buildPack().source, undefined);
  assert.equal(buildPack({ commit: 'abc1234' }).source.commit, 'abc1234');
});
