// Preflight checks, shared by scripts/doctor.mjs and GET /api/health. Synchronous, no network. Values of settings are never printed.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import fs from 'node:fs';
import path from 'node:path';
import { MODE_KEY, PORT_MAX, PORT_MIN, dataDir, liveRefusal, modeFrom, port, portInRange } from './config.js';
import { createDiagrams } from './diagrams.js';
import { bindHost, isLoopbackHost, labAllowedHosts } from './security.js';

export function runChecks({ env = process.env } = {}) {
  const out = [];
  const add = (id, level, detail) => out.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', major >= 26 ? `Node ${process.versions.node}` : `Node ${process.versions.node}; need 26 or newer`);

  // Which mode Live is in: an opt-in, never a bare MODE. Mock is the default and needs no setup.
  try {
    const mode = modeFrom(env);
    const refusal = liveRefusal(env);
    add('mode', 'pass', mode === 'live' && !refusal ? `${MODE_KEY}=live: Live is allowed (owner opt-in); the page still opens in Mock` : mode === 'live' ? `${MODE_KEY}=live is set but Live is REFUSED (${refusal.failed.join(', ')})` : `${MODE_KEY} not set (mock): Live is refused until the owner opts in`);
  } catch (e) { add('mode', 'fail', e.message); }

  const dir = dataDir(env);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const p = path.join(dir, '.doctor'); fs.writeFileSync(p, 'x', { mode: 0o600 }); fs.unlinkSync(p); add('data-dir', 'pass', 'data directory is writable'); }
  catch { add('data-dir', 'fail', 'data directory is not writable'); }

  const host = bindHost(env);
  add('bind', isLoopbackHost(host) || env.P1MCP_BIND ? 'pass' : 'fail', isLoopbackHost(host) ? 'loopback only' : env.P1MCP_BIND ? 'non-loopback bind opted in via P1MCP_BIND' : 'bind address is not loopback');

  try {
    const n = labAllowedHosts(env).size;
    add('lab-hosts', 'pass', n ? `LAB_ALLOWED_HOSTS: ${n} extra Host name(s) (the lab-proxy)` : 'LAB_ALLOWED_HOSTS unset: loopback Host headers only');
  } catch (e) { add('lab-hosts', 'fail', e.message); }

  const p = port(env);
  add('port-range', portInRange(p) ? 'pass' : 'fail', portInRange(p) ? `server port ${p} (within ${PORT_MIN}-${PORT_MAX})` : `server port ${p} is outside ${PORT_MIN}-${PORT_MAX}`);

  try { const d = createDiagrams(); add('diagrams', 'pass', `${d.names.length} diagrams are valid diagram-studio/1 data (${d.names.join(', ')})`); }
  catch (e) { add('diagrams', 'fail', e.message); }

  add('outbound', 'info', 'Mock makes no outbound call. Live reaches only the hosts of the saved connection you use (https, or http on loopback), through the netguard; a typed name that resolves to a private address is not caught, only literal private addresses are refused');
  return out;
}
export const allPassed = (c) => c.every((x) => x.level !== 'fail');
