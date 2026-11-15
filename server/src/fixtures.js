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

// Recorded tool lists: the tools/list of a Live server (names, descriptions, schemas, annotations;
// never a call result), kept so the mock demo can list those tools and answer them with a labelled
// synthetic reply. Merged by tool name across recordings; scrubbed and size-capped before writing.
const CATALOG_FILE = 'recorded-tools.json';
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_SCHEMA = 20000;

export function createRecordedTools({ dir }) {
  const file = path.join(dir, CATALOG_FILE);
  const load = () => {
    try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(p) ? p : []; } catch { return []; }
  };
  const save = (list) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  };
  return {
    file,
    // record(tools, { source, secrets }): tools is a tools/list array. Returns how many were kept and skipped.
    record(tools, { source, secrets = [] } = {}) {
      if (!Array.isArray(tools)) throw new Error('tools must be a list');
      const byName = new Map(load().map((t) => [t.name, t]));
      const recordedAt = new Date().toISOString();
      const src = scrub(String(source || 'recorded'), secrets).slice(0, 200);
      let kept = 0; let skipped = 0;
      for (const t of tools) {
        const name = typeof t?.name === 'string' ? t.name : '';
        const schema = JSON.stringify(t?.inputSchema ?? { type: 'object', properties: {} });
        if (!TOOL_NAME.test(name) || schema.length > MAX_SCHEMA || (!byName.has(name) && byName.size >= MAX_TOOLS)) { skipped++; continue; }
        byName.set(name, {
          name,
          description: scrub(String(t.description ?? ''), secrets).slice(0, 1000),
          inputSchema: JSON.parse(scrub(schema, secrets)),
          annotations: t.annotations && typeof t.annotations === 'object' ? JSON.parse(scrub(JSON.stringify(t.annotations), secrets)) : null,
          source: src, recordedAt,
        });
        kept++;
      }
      save([...byName.values()]);
      return { kept, skipped, total: byName.size };
    },
    all: () => load(),
    clear: () => { const had = load().length; save([]); return had; },
  };
}
