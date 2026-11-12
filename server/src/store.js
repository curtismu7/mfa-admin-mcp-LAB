// Saved connections. Adapted from mcp-tools server/src/store.js (MIT, same author): atomic write, file mode 600 in a
// mode 700 dir, secrets (worker client secret, custom token) held here and never returned: publicView() shows 'set'.
// Access/refresh/id tokens are NOT stored here: auth.js keeps them in memory only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackHost } from './security.js';
import { isPrivateLiteral, validEnvId, validRegion } from './urls.js';

const KINDS = new Set(['pingone', 'custom', 'raw']);

function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must be http or https');
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) throw new Error('url must be https (http is allowed only for a loopback address)');
  if (isPrivateLiteral(u.hostname)) throw new Error('url must not be a private or link-local address');
  if (u.username || u.password) throw new Error('put credentials in the token field, not in the URL');
  return u.toString();
}
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);

export function createStore({ dir }) {
  const file = path.join(dir, 'connections.json');
  function load() {
    try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
  }
  function save(all) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  function create(b) {
    if (!KINDS.has(b.kind)) throw new Error(`kind must be one of: ${[...KINDS].join(', ')}`);
    const rec = { id: crypto.randomUUID(), kind: b.kind, label: str(b.label, 80) || `${b.kind} server`, createdAt: new Date().toISOString(), allowWrites: false };
    if (b.kind === 'pingone') {
      rec.offline = b.offline === true;
      rec.region = str(b.region || 'com', 12).toLowerCase();
      if (b.regionOther === true) rec.regionOther = true;
      if (!validRegion(rec.region, rec.regionOther)) throw new Error('region must be one of com, eu, asia, ca (set regionOther:true to use another PingOne suffix; UNVERIFIED)');
      rec.envId = str(b.envId, 64);
      if (!validEnvId(rec.envId)) throw new Error('envId must be your PingOne environment id (a UUID)');
      rec.auth = b.auth === 'interactive' ? 'interactive' : 'worker';
      rec.endpointStyle = b.endpointStyle === 'mcp-host' ? 'mcp-host' : 'api';
      rec.clientId = str(b.clientId, 120);
      if (!rec.clientId) throw new Error('clientId is required');
      if (rec.auth === 'worker') {
        rec.clientSecret = str(b.clientSecret, 500);
        if (!rec.clientSecret) throw new Error('clientSecret is required for worker auth');
        rec.tokenAuthMethod = b.tokenAuthMethod === 'post' ? 'post' : 'basic';
      } else {
        rec.redirectUri = str(b.redirectUri, 300);
        if (!rec.redirectUri) throw new Error('redirectUri is required for interactive auth (the loopback URI registered on your OAuth application)');
        let ru; try { ru = new URL(rec.redirectUri); } catch { ru = null; }
        if (!ru || ru.protocol !== 'http:' || !isLoopbackHost(ru.hostname)) throw new Error('redirectUri must be an http loopback URI such as http://localhost:5201/api/oauth/callback');
      }
    } else {
      rec.url = cleanUrl(b.url);
      if (str(b.token, 2000)) { rec.authHeader = str(b.authHeader || 'Authorization', 60); rec.token = str(b.token, 2000); }
    }
    const all = load(); all[rec.id] = rec; save(all);
    return rec;
  }

  const get = (id) => { const all = load(); return typeof id === 'string' && Object.hasOwn(all, id) ? all[id] : null; };
  const list = () => Object.values(load());
  function update(id, patch) {
    const all = load(); const rec = Object.hasOwn(all, id) ? all[id] : null;
    if (!rec) return null;
    if (typeof patch.allowWrites === 'boolean') rec.allowWrites = patch.allowWrites;
    // Mock demo only: the mock derives the role from the client id, so the role switch is a client id swap.
    if (rec.offline && /^(viewer|admin)-demo$/.test(patch.clientId || '')) rec.clientId = patch.clientId;
    save(all); return rec;
  }
  // Reset: every connection goes back to writes off (the safe state). Saved connections and their secrets are kept.
  function resetWrites() { const all = load(); let n = 0; for (const rec of Object.values(all)) if (rec.allowWrites) { rec.allowWrites = false; n++; } if (n) save(all); return n; }
  function remove(id) { const all = load(); if (!Object.hasOwn(all, id)) return false; delete all[id]; save(all); return true; }

  function publicView(rec) {
    const { clientSecret, token, url, ...rest } = rec;
    const v = { ...rest };
    if (rec.kind === 'pingone' && rec.auth === 'worker') v.clientSecret = clientSecret ? 'set' : null;
    if (rec.kind !== 'pingone') { v.token = token ? 'set' : null; const u = new URL(url); v.url = `${u.origin}${u.pathname}`; v.urlHasQuery = Boolean(u.search); }
    return v;
  }
  function secretsOf(rec) {
    let q = [];
    try { q = rec?.url ? [...new URL(rec.url).searchParams.values()] : []; } catch { /* none */ }
    return [rec?.clientSecret, rec?.token, ...q].filter(Boolean);
  }
  return { create, get, list, update, remove, resetWrites, publicView, secretsOf, file };
}
