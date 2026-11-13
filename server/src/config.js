// Mode and port configuration.
//
// MFA_ADMIN_MCP_MODE is the owner's opt-in for Live. mock (the default) keeps Live refused; live lets the header toggle go to
// Live. The page always opens in Mock; Live is entered by pressing the header toggle each time (nothing is remembered). A bare MODE is NOT read: the
// shared settings file is read by every standalone app, and another app's MODE must not switch this one. Anything that is not mock
// or live is an error, never a silent fallback.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindHost, isLoopbackHost } from './security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PORT = 7815;
export const PORT_MIN = 7815;
export const PORT_MAX = 7815; // one port per app (ports rule, 2026-11-07); PORT is for dev only
export const port = (env = process.env) => Number(env.PORT) || DEFAULT_PORT;
// One port per app (ports rule, 2026-11-07): production binds 7815. The e2e run needs two throwaway
// servers (main + a refused-Live twin) and the tests use ephemeral ports; those are dev conveniences,
// not deployments, so the entrypoint's range check does not apply when the e2e harness is driving.
export const portInRange = (p) => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;
export const portAllowed = (p, env = process.env) =>
  portInRange(p) || (env.E2E_GUARD_FILE ? Number.isInteger(p) && p > 0 && p <= 65535 : false);
export const dataDir = (env = process.env) => path.resolve(root, env.MFAADM_DATA_DIR || '.data');
export const webDist = path.join(root, 'web', 'dist');

export const MODES = Object.freeze(['mock', 'live']);
export const MODE_KEY = 'MFA_ADMIN_MCP_MODE';

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
    { id: 'loopback-bind', ok: isLoopbackHost(host) || (Boolean(env.MFAADM_BIND) && env.MFAADM_CONTAINER === '1'), detail: 'the server is bound to loopback; a non-loopback bind (MFAADM_BIND) is accepted for Live only inside the container image, which sets MFAADM_CONTAINER=1 and is published on 127.0.0.1 only' },
  ];
}
// null when Live may run; otherwise which guards failed and what each needs.
export function liveRefusal(env = process.env) {
  const failed = liveGuards(env).filter((g) => !g.ok);
  return failed.length ? { failed: failed.map((g) => g.id), needs: failed.map((g) => g.detail) } : null;
}
