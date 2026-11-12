#!/usr/bin/env node
// Generates content-pack.json (repo root) for the Learning Hub. Format: docs/content-pack.schema.json (copy of the ID-JAG kit's).
// Deterministic: lists sorted by id, 2-space JSON, no timestamps; a commit is recorded only when passed (--commit=<sha>).
// Sources: none. A source is listed only if its URL was fetched this build or verified in the skill/seeds; the only
// PingOne documentation fetch attempted (regions page) returned 404 (docs/references.md), so the list is empty on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_PATH = path.join(ROOT, 'content-pack.json');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const CARDS = [
  { id: 'connections', label: 'Connect to a server', description: 'Mock: the mock demo with a viewer/admin role switch. Live (owner opt-in): worker or interactive PingOne, or a custom MCP server.', group: 'setup', href: '/#/connections', terms: ['hosted-mcp-server', 'admin-plane', 'worker-application', 'client-credentials', 'authorization-code-pkce'] },
  { id: 'tools', label: 'Tools and safety classes', description: 'Every tool with a read, write or destructive badge and why; scan the list for poisoned metadata.', group: 'try-it', href: '/#/tools', terms: ['role-gated-tool-list', 'read-only-by-default'] },
  { id: 'short-list', label: 'Why a short tool list', description: 'Story: the list is gated by roles. Switch the mock demo from viewer to admin and watch it grow.', group: 'concept', href: '/#/stories', terms: ['role-gated-tool-list'], story: 'S01' },
  { id: 'second-look', label: 'A write needs a second look', description: 'Story: writes are blocked, then confirmed on the exact arguments; destructive calls need the name typed.', group: 'concept', href: '/#/stories', terms: ['read-only-by-default', 'confirm-gate', 'audit-log'], story: 'S02' },
  { id: 'mcp-first', label: 'MCP first, Management API second', description: 'When to use the hosted MCP tools and when to fall back to the REST API.', group: 'concept', href: '/#/mcp-first', terms: ['mcp-first-rule'] },
  { id: 'audit', label: 'Audit log', description: 'Every call, allowed or blocked, redacted.', group: 'reference', href: '/#/audit', terms: ['audit-log'] },
  { id: 'diagram', label: 'Diagram', description: 'Client, gate, token source and server. Movable boxes, Simulate, Reset, speed.', group: 'concept', href: '/#/diagram' },
];

export function buildPack({ commit } = {}) {
  const pkg = readJson('package.json');
  const stories = fs.readdirSync(path.join(ROOT, 'web/src/data/stories')).filter((f) => f.endsWith('.json'))
    .map((f) => { const s = readJson(`web/src/data/stories/${f}`); return { id: s.id, title: s.title, say: s.say, file: `web/src/data/stories/${f}` }; }).sort(byId);
  const ids = new Set(stories.map((s) => s.id));
  const pack = {
    schema: 'demo-content-pack/1',
    id: 'pingone-mcp-inspector',
    title: 'PingOne MCP Inspector LAB',
    version: pkg.version,
    ...(commit ? { source: { repo: 'pingone-mcp-inspector-LAB', commit } } : {}),
    demo: { id: 'pingone-mcp-inspector', name: 'PingOne MCP Inspector LAB', catalog: 'D3', baseUrl: 'http://localhost:5201', doctor: '/api/health', tags: ['mcp', 'pingone', 'admin-plane', 'read-only'] },
    glossary: readJson('content/terms.json').sort(byId),
    sources: [],
    cards: CARDS.map(({ href, ...c }) => ({ ...c, action: { type: 'route', href } })).sort(byId),
    diagrams: [{ id: 'connection-path', label: 'Client, gate, token source, server', href: '/#/diagram' }],
    stories,
  };
  for (const c of pack.cards) if (c.story && !ids.has(c.story)) throw new Error(`card ${c.id} names unknown story ${c.story}`);
  return pack;
}
export const serialize = (p) => `${JSON.stringify(p, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice(9);
  fs.writeFileSync(PACK_PATH, serialize(buildPack({ commit })));
  console.log(`wrote ${PACK_PATH}`);
}
