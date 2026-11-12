// Mode and port configuration.
//
// PINGONE_MCP_INSPECTOR_MODE is the owner's opt-in for Live. mock (the default) keeps Live refused; live lets the header toggle go to
// Live. The page always opens in Mock; Live is entered by pressing the header toggle each time (nothing is remembered). A bare MODE is NOT read: the
// shared settings file is read by every standalone app, and another app's MODE must not switch this one. Anything that is not mock
// or live is an error, never a silent fallback.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindHost, isLoopbackHost } from './security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PORT = 5201;
export const PORT_MIN = 5201;
export const PORT_MAX = 5249;
export const port = (env = process.env) => Number(env.PORT) || DEFAULT_PORT;
export const portInRange = (p) => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;
export const dataDir = (env = process.env) => path.resolve(root, env.P1MCP_DATA_DIR || '.data');
export const webDist = path.join(root, 'web', 'dist');

export const MODES = Object.freeze(['mock', 'live']);
export const MODE_KEY = 'PINGONE_MCP_INSPECTOR_MODE';

export function modeFrom(env = process.env) {
  const raw = env[MODE_KEY];
  const m = raw === undefined || raw === '' ? 'mock' : raw;
  if (!MODES.includes(m)) throw new Error(`${MODE_KEY}=${String(m).slice(0, 20).replace(/[^\x20-\x7e]/g, '?')} is not a mode: use mock or live`);
  return m;
}

// The guards Live must pass before any saved live connection is used. Each: { id, ok, detail }. Every live connection is then checked
// again when it is saved (https, or http on loopback only; no credentials in the URL; no literal private address; see store.js).
export function liveGuards(env = process.env) {
  const host = bindHost(env);
  return [
    { id: 'owner-opt-in', ok: env[MODE_KEY] === 'live', detail: `${MODE_KEY}=live is set in the shared settings file (~/Development/.env, or the path in STANDALONE_ENV) or the environment` },
    { id: 'loopback-bind', ok: isLoopbackHost(host) || (Boolean(env.P1MCP_BIND) && env.P1MCP_CONTAINER === '1'), detail: 'the server is bound to loopback; a non-loopback bind (P1MCP_BIND) is accepted for Live only inside the container image, which sets P1MCP_CONTAINER=1 and is published on 127.0.0.1 only' },
  ];
}
// null when Live may run; otherwise which guards failed and what each needs.
export function liveRefusal(env = process.env) {
  const failed = liveGuards(env).filter((g) => !g.ok);
  return failed.length ? { failed: failed.map((g) => g.id), needs: failed.map((g) => g.detail) } : null;
}
