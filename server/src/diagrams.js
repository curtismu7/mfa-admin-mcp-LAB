// The diagrams are diagram-studio/1 DATA (server/diagrams/*.json), loaded by name and checked with the studio's own validator copy.
// Nothing here or in the web page builds nodes or edges by hand. Every file is read and checked once, when the app is created: an
// invalid or missing file stops the server from starting. Names come from a fixed allow-list and live in a Map, so a request name is
// only ever a lookup key (never a path, never an object property, never echoed back).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDiagram } from './diagramStudioValidate.js';

export const DIAGRAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../diagrams');
export const DIAGRAM_NAMES = Object.freeze(['worker', 'interactive']);
const HANDLE = /^[lrtb][12]$/;

// Beyond the studio's schema: the file's id is its name, a step must exist, and the optional per-edge `handles` hint (which side slot an
// arrow leaves and enters by) is a pair of slot ids. The studio's own validator ignores that hint.
function extraProblems(name, d) {
  const p = [];
  if (d.id !== name) p.push(`id must equal the file name "${name}"`);
  if (!Array.isArray(d.steps) || !d.steps.length) p.push('at least one step is required');
  for (const [i, e] of (Array.isArray(d.edges) ? d.edges : []).entries()) {
    if (e.handles !== undefined && !(Array.isArray(e.handles) && e.handles.length === 2 && e.handles.every((h) => typeof h === 'string' && HANDLE.test(h)))) p.push(`edge ${i + 1}: handles must be two slot ids such as "r1","l1"`);
  }
  return p;
}

export function createDiagrams({ dir = DIAGRAM_DIR, names = DIAGRAM_NAMES } = {}) {
  const docs = new Map();
  for (const name of names) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')); }
    catch { throw new Error(`diagram "${name}" cannot be read as JSON`); }
    const problems = validateDiagram(doc);
    if (!problems.length) problems.push(...extraProblems(name, doc));
    if (problems.length) throw new Error(`diagram "${name}" is not valid diagram-studio/1: ${problems.join('; ')}`);
    docs.set(name, doc);
  }
  return {
    names: [...docs.keys()],
    list: () => [...docs].map(([name, d]) => ({ name, title: d.title })),
    get: (name) => (typeof name === 'string' ? docs.get(name) ?? null : null),
  };
}
