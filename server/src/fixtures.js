// Recorded tool responses ("fixtures"): real JSON-RPC results captured from a Live server,
// replayed by the mock when it has no data of its own for a tool. Stored per tool name in a
// mode-600 JSON file in the data dir; secrets are scrubbed before anything is written.
// A recorded response is labelled with its source and date, so the mock never passes off a
// recording as the in-process sample.
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './redact.js';

const FILE = 'fixtures.json';
const MAX_TOOLS = 500;

export function createFixtures({ dir }) {
  const file = path.join(dir, FILE);
  const load = () => {
    try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
  };
  const save = (all) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  };
  return {
    file,
    // record(tool, mcpResult, { source, secrets }): mcpResult is the full JSON-RPC tools/call result envelope.
    record(tool, result, { source, secrets = [] } = {}) {
      if (typeof tool !== 'string' || !tool) throw new Error('tool is required');
      const all = load();
      if (!all[tool] && Object.keys(all).length >= MAX_TOOLS) throw new Error(`fixture store is full (${MAX_TOOLS} tools); delete one first`);
      all[tool] = { recordedAt: new Date().toISOString(), source: scrub(String(source || 'recorded'), secrets).slice(0, 200), result: JSON.parse(scrub(JSON.stringify(result ?? null), secrets)) };
      save(all);
      return all[tool];
    },
    get: (tool) => load()[tool] ?? null,
    all: () => load(),
    remove: (tool) => { const all = load(); if (!Object.hasOwn(all, tool)) return false; delete all[tool]; save(all); return true; },
    count: () => Object.keys(load()).length,
  };
}
