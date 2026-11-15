// Saved connections. Adapted from mcp-tools server/src/store.js (MIT, same author): atomic write, file mode 600 in a
// mode 700 dir, secrets (the custom server's token or header value) held here and never returned: publicView() shows 'set'.
// Access/refresh/id tokens are NOT stored here: auth.js keeps them in memory only. A PingOne connection holds no secret at all: the
// hosted PingOne MCP server takes a user sign-in (pi.flow), so the saved record is a public client id and where to sign in.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackHost } from './security.js';
import { isPrivateLiteral, validEnvId, validRegion } from './urls.js';

const KINDS = new Set(['pingone', 'custom', 'raw']);
export const WORKER_REFUSED = 'The hosted PingOne MCP server takes a user sign-in (pi.flow), not a worker (client_credentials) token: save the connection without auth "worker" and without a client secret, then sign in. (Setup\'s Management worker only creates the sign-in application; it never calls the MCP server.)';

// login_hint: the username to offer in the sign-in dialog (and send to the authorization server). Plain text, no control characters.
export function cleanLoginHint(v) {
  const s = String(v ?? '').trim();
  if (s.length > 256 || /[\u0000-\u001f\u007f]/.test(s)) throw Object.assign(new Error('loginHint must be a short plain-text username (at most 256 characters, no control characters)'), { code: 'bad_request' });
  return s;
}

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
      if (b.auth === 'worker' || (b.clientSecret !== undefined && b.clientSecret !== null && b.clientSecret !== '')) throw new Error(WORKER_REFUSED);
      rec.auth = 'interactive';
      // mcp-host is the shape Ping's MCP docs name; api stays selectable (UNVERIFIED, see urls.js).
      rec.endpointStyle = b.endpointStyle === 'api' ? 'api' : 'mcp-host';
      // Which authorization server signs the tokens: PingOne (default) or a PingFederate instance.
      // PF is only meaningful for interactive sign-in (it must run an OAuth app for this tool's PKCE flow).
      rec.idp = b.idp === 'pf' ? 'pf' : 'pingone';
      if (rec.idp === 'pf') {
        rec.idpBaseUrl = str(b.idpBaseUrl, 300);
        // required unless the connection is the offline mock: a clean https (or loopback http) base; the /as suffix is appended by urls.asBase
        if (!rec.idpBaseUrl && !rec.offline) throw new Error('PingFederate needs its base URL (idpBaseUrl), for example https://pingfederate.example.com');
        if (rec.idpBaseUrl) {
          let bUrl; try { bUrl = new URL(rec.idpBaseUrl); } catch { bUrl = null; }
          const ok = bUrl && ((bUrl.protocol === 'https:') || (bUrl.protocol === 'http:' && isLoopbackHost(bUrl.hostname)));
          if (!ok || bUrl.username || bUrl.password) throw new Error('idpBaseUrl must be an https URL (http only for a loopback address), without credentials');
        }
      }
      rec.clientId = str(b.clientId, 120);
      if (b.loginHint) rec.loginHint = cleanLoginHint(b.loginHint);
      if (!rec.clientId) throw new Error('clientId is required');
      // pi.flow serves no callback, so a redirect URI is optional (the lab sends its own placeholder). A value kept from before pi.flow,
      // or one a custom application insists on, must still be a URL: http loopback, or https.
      rec.redirectUri = str(b.redirectUri, 300);
      if (rec.redirectUri) {
        let ru; try { ru = new URL(rec.redirectUri); } catch { ru = null; }
        const okCb = ru && ((ru.protocol === 'http:' && isLoopbackHost(ru.hostname)) || ru.protocol === 'https:');
        if (!okCb) throw new Error('redirectUri must be an http loopback URI or an https URI');
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
    if (rec.kind === 'pingone' && rec.auth === 'interactive' && typeof patch.loginHint === 'string') { const h = cleanLoginHint(patch.loginHint); if (h) rec.loginHint = h; else delete rec.loginHint; }
    save(all); return rec;
  }
  // Reset: every connection goes back to writes off (the safe state). Saved connections and their secrets are kept.
  function resetWrites() { const all = load(); let n = 0; for (const rec of Object.values(all)) if (rec.allowWrites) { rec.allowWrites = false; n++; } if (n) save(all); return n; }
  function remove(id) { const all = load(); if (!Object.hasOwn(all, id)) return false; delete all[id]; save(all); return true; }

  function publicView(rec) {
    const { clientSecret, token, url, ...rest } = rec;
    const v = { ...rest };
    // A worker connection saved by an older build keeps its secret on disk (never returned); it cannot call the MCP server any more.
    if (rec.kind === 'pingone' && rec.auth === 'worker') v.legacyWorker = true;
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
