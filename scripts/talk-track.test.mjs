import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { TALK_PATH, buildTalkTrack } from './build-talk-track.mjs';

test('docs/talk-track.md is exactly what the builder produces from the stories (run: npm run talk-track)', () => {
  assert.equal(fs.readFileSync(TALK_PATH, 'utf8'), buildTalkTrack(), 'docs/talk-track.md is stale; regenerate it and commit the result');
});
test('the talk track names the mode, presenter mode and Reset, carries both stories, and leaves no undefined cast token', () => {
  const t = buildTalkTrack();
  for (const w of ['## S01.', '## S02.', 'which mode you are in', 'presenter mode', 'Reset', 'UNVERIFIED']) assert.ok(t.includes(w), w);
  assert.ok(!/⟨missing|\{\{/.test(t), 'every {{cast}} token is defined by the generic vertical');
});
