// The safety gate and the audit log. Pattern from mcp-tools (confirm-gate with argsHash), same author.
//  read          -> runs.
//  write/destr.  -> blocked unless the connection has allowWrites; then {confirm:true, argsHash} must match the exact
//                   arguments; destructive also needs typedName === the tool name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './redact.js';

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
export const argsHash = (connId, tool, args) => crypto.createHash('sha256').update(JSON.stringify(canon({ connId, tool, args: args ?? {} }))).digest('hex');

export function decide({ cls, allowWrites, connId, tool, args, confirm, hash, typedName }) {
  if (cls === 'read') return { ok: true };
  const expected = argsHash(connId, tool, args);
  if (!allowWrites) return { ok: false, status: 403, error: 'writes_disabled', message: `"${tool}" is a ${cls} tool. Turn on "allow writes" for this connection to use it.` };
  if (confirm !== true) return { ok: false, status: 409, error: 'confirm_required', argsHash: expected, class: cls, arguments: args ?? {}, requiresTypedName: cls === 'destructive', message: 'Review the exact arguments, then resend with confirm:true and this argsHash.' };
  if (hash !== expected) return { ok: false, status: 409, error: 'args_hash_mismatch', argsHash: expected, message: 'The arguments changed since they were confirmed; review them again.' };
  if (cls === 'destructive' && typedName !== tool) return { ok: false, status: 409, error: 'typed_name_required', argsHash: expected, message: `Type the tool name "${tool}" to confirm a destructive call.` };
  return { ok: true };
}

const SENSITIVE_KEY = /secret|password|passwd|token|credential|api[-_]?key|authorization/i;
function redactArgs(v, secrets, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactArgs(x, secrets, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redactArgs(x, secrets, depth + 1)]));
  return typeof v === 'string' ? scrub(v, secrets).slice(0, 300) : v;
}

export function createAudit({ dir, now = () => new Date() }) {
  const file = path.join(dir, 'audit.jsonl');
  const mem = [];
  return {
    file,
    record({ conn, tool, cls, outcome, args, hash, note }, secrets = []) {
      const e = { at: now().toISOString(), connectionId: conn.id, connection: scrub(conn.label, secrets), kind: conn.kind, tool: scrub(String(tool), secrets).slice(0, 120), class: cls ?? null, outcome, argsHash: hash ?? null, args: redactArgs(args ?? {}, secrets) };
      if (note) e.note = scrub(String(note), secrets).slice(0, 200);
      mem.push(e); if (mem.length > 500) mem.shift();
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      } catch { /* the in-memory copy still serves GET /api/audit */ }
      return e;
    },
    recent: (n = 200) => mem.slice(-n),
    // Reset: forget the run history, in memory and on disk.
    clear() { mem.length = 0; try { fs.rmSync(file, { force: true }); } catch { /* nothing to remove */ } },
  };
}
