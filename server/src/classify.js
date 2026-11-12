// Tool safety class: read | write | destructive. Unknown = write (the conservative default).
// Order: server annotations first (readOnlyHint / destructiveHint), else a name heuristic on the camelCase/snake words.
// Stricter than "annotations win": readOnlyHint:true is NOT honoured when the name's verb is a write or destructive one,
// nor when the name has no recognised verb at all (unknown = write), because annotations are server-supplied and a
// wrong one would open a write path. destructiveHint:true and readOnlyHint:false only ever make a tool stricter.
const READ = new Set(['list', 'get', 'read', 'search', 'describe', 'find', 'query', 'show', 'fetch', 'count', 'check', 'validate', 'lookup', 'export']);
const WRITE = new Set(['create', 'update', 'patch', 'put', 'set', 'add', 'assign', 'enable', 'disable', 'reset', 'unlock', 'revoke', 'import', 'send', 'invite', 'activate', 'deactivate', 'rotate', 'start', 'stop', 'run', 'execute', 'deploy', 'link', 'unlink', 'move', 'replace', 'upsert', 'register', 'regenerate', 'resend', 'verify']);
const DESTRUCTIVE = new Set(['delete', 'remove', 'purge', 'wipe', 'destroy', 'erase', 'drop']);
const RANK = { read: 0, write: 1, destructive: 2 };

export function words(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
}

function byName(name) {
  const ws = words(name);
  const first = ws[0];
  let cls = DESTRUCTIVE.has(first) ? 'destructive' : WRITE.has(first) ? 'write' : READ.has(first) ? 'read' : null;
  if (cls === null) {
    // Noun-first names (users_delete): the verb is not first, so scan every word before an annotation may be honoured.
    cls = 'write';
    let found = false;
    for (const w of ws) { const c = DESTRUCTIVE.has(w) ? 'destructive' : WRITE.has(w) ? 'write' : null; if (c) { found = true; if (RANK[c] > RANK[cls]) cls = c; } }
    return { cls, unknown: !found };
  }
  // A read verb followed by a write/destructive word (getOrCreateX) is not a read.
  for (const w of ws.slice(1)) {
    const c = DESTRUCTIVE.has(w) ? 'destructive' : WRITE.has(w) ? 'write' : null;
    if (c && RANK[c] > RANK[cls]) cls = c;
  }
  return { cls, unknown: false };
}

export function classify(tool) {
  const ann = tool?.annotations || {};
  const n = byName(tool?.name);
  if (ann.destructiveHint === true) return { class: 'destructive', source: 'annotation' };
  // readOnlyHint:true is only trusted when the name's own verb is a recognised read verb (then it agrees with the name).
  // An unknown name, or a write/destructive verb, keeps the name's class: the hint alone never opens a path past the write gate.
  if (ann.readOnlyHint === true) return { class: n.cls, source: n.unknown ? 'unknown' : 'name' };
  if (ann.readOnlyHint === false) return { class: RANK[n.cls] >= 1 ? n.cls : 'write', source: RANK[n.cls] >= 1 ? 'name' : 'annotation' };
  return { class: n.cls, source: n.unknown ? 'unknown' : 'name' };
}

// Area = the first noun after the verb (listApplications -> application), or the leading segment of users_list / users.list.
export function area(name) {
  const s = String(name);
  const ws = words(s);
  const isVerb = (w) => READ.has(w) || WRITE.has(w) || DESTRUCTIVE.has(w);
  if (/[._/:-]/.test(s)) {
    const first = words(s.split(/[._/:-]/)[0])[0];
    if (first && !isVerb(first)) return first.replace(/s$/, '');
  }
  const rest = isVerb(ws[0]) ? ws.slice(1) : ws;
  return (rest[0] || ws[0] || 'other').replace(/s$/, '');
}

export function annotate(tools) {
  return tools.map((t) => ({
    name: String(t.name), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? null,
    annotations: t.annotations ?? null, ...(({ class: c, source }) => ({ class: c, classSource: source }))(classify(t)), area: area(t.name),
  }));
}
