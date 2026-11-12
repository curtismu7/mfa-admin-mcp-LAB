#!/usr/bin/env node
/**
 * Generates docs/talk-track.md from the two stories in web/src/data/stories (filled with the generic vertical pack), so the presenter
 * script and the stories on the Stories page cannot drift: a test compares the committed file with this builder's output.
 *   node scripts/build-talk-track.mjs      (npm run talk-track)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillAll } from '../web/src/story/fill.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TALK_PATH = path.join(ROOT, 'docs', 'talk-track.md');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

export function buildTalkTrack() {
  const vertical = readJson('web/src/data/verticals/generic.json');
  const stories = fs.readdirSync(path.join(ROOT, 'web/src/data/stories')).filter((f) => f.endsWith('.json')).sort()
    .map((f) => fillAll(readJson(`web/src/data/stories/${f}`), vertical));
  const lines = [
    '# PingOne MCP Inspector LAB: talk track',
    '',
    'Generated from `web/src/data/stories/*.json` (generic vertical) by `npm run talk-track`. Do not edit by hand.',
    '',
    'Before you start, say which mode you are in: the header toggle, the `Mode:` chip and the banner all show it. **Mock** is simulated (an in-process mock of the hosted server, an illustrative sample, not a recording). **Live** is owner-run, refused until the owner opts in, and acts on a real server. Both stories run in Mock.',
    '',
    'Press P (or the Present button) for presenter mode: larger text, and the banner and the mode stay on screen. Esc leaves it. Reset (header) puts the demo back to its start: audit history, tokens, writes off, the mock\'s fake tenant, and the diagram boxes.',
    '',
  ];
  for (const s of stories) {
    lines.push(`## ${s.id}. ${s.title}`, '', `Page: ${s.modes.map((m) => (m === 'tool-list' ? 'Tools' : 'a tool page and the Raw console')).join(', ')}.`, '', `- Goal: ${s.goal}`, `- Obstacle: ${s.obstacle}`, `- Control: ${s.control}`, '');
    for (const st of s.steps) {
      lines.push(`### Step ${st.n}. ${st.title}`, '', `Do: ${st.tell}`, '', `Say: "${st.say}"`, '', `Why it matters: ${st.why}`, '');
      if (st.blocked) lines.push(`If the write is blocked: ${st.blocked.tell} Say: "${st.blocked.say}"`, '');
    }
    lines.push(`Proof (allowed path): ${s.proof.happy}`, '', `Proof (blocked path): ${s.proof.blocked}`, '', `Closing line: "${s.say}"`, '');
  }
  lines.push(
    '## Caveats to say out loud',
    '',
    '- Nothing here was run against a real PingOne tenant. Whether the hosted server accepts a worker (client_credentials) token, which endpoint shape a tenant answers on, and the scopes and consent of the interactive login are UNVERIFIED (docs/live-checks.md).',
    '- The mock tool catalog is an illustrative sample, not a recording. The read, write and destructive classes are a heuristic (docs/classification.md); unknown is treated as a write.',
    '- A clean scan of a tool list is not proof of safety.',
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.dirname(TALK_PATH), { recursive: true });
  fs.writeFileSync(TALK_PATH, buildTalkTrack());
  console.log(`wrote ${path.relative(process.cwd(), TALK_PATH) || TALK_PATH}`);
}
