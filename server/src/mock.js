// In-process mock of the hosted PingOne MCP server AND a PingOne-like authorization server (token, authorize, jwks),
// on loopback. Used by mock mode and by tests. The tool catalog is an ILLUSTRATIVE SAMPLE, NOT A RECORDING: names
// and shapes follow the pingone-mcp skill's conventions (camelCase, role-gated list); no real recording was found in
// AI-DEMO2. Write tools change only the in-memory fake tenant below.
import crypto from 'node:crypto';
import http from 'node:http';
import { pkceChallenge } from './auth.js';

export const FIXTURE_LABEL = 'illustrative sample, not a recording';
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' };
const ENV = { environmentId: S };

// role: 'viewer' sees only read tools; 'admin' sees all.
const CATALOG = [
  { name: 'listApplications', description: 'List applications in the environment.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getApplication', description: 'Get one application.', inputSchema: obj({ ...ENV, applicationId: S }, ['environmentId', 'applicationId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'listPopulations', description: 'List populations.', inputSchema: obj({ ...ENV }, ['environmentId']), role: 'viewer' },
  { name: 'listUsers', description: 'List users.', inputSchema: obj({ ...ENV, filter: S }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getUser', description: 'Get one user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'viewer' },
  { name: 'searchUsers', description: 'Search users by attribute.', inputSchema: obj({ ...ENV, query: S }, ['environmentId']), role: 'viewer' },
  { name: 'listDaVinciFlows', description: 'List DaVinci flows.', inputSchema: obj({ ...ENV }, ['environmentId']), role: 'viewer' },
  { name: 'describeEnvironment', description: 'Describe the environment configuration.', inputSchema: obj({ ...ENV }, ['environmentId']), role: 'viewer' },
  { name: 'createApplication', description: 'Create an application.', inputSchema: obj({ ...ENV, name: S, type: S }, ['environmentId', 'name']), annotations: { readOnlyHint: false, destructiveHint: false }, role: 'admin' },
  { name: 'updateApplication', description: 'Update an application.', inputSchema: obj({ ...ENV, applicationId: S, name: S }, ['environmentId', 'applicationId']), role: 'admin' },
  { name: 'createUser', description: 'Create a user.', inputSchema: obj({ ...ENV, username: S, email: S, populationId: S }, ['environmentId', 'username']), role: 'admin' },
  { name: 'updateUser', description: 'Update a user.', inputSchema: obj({ ...ENV, userId: S, email: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'enableUser', description: 'Enable a user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'disableUser', description: 'Disable a user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'resetUserPassword', description: 'Start the reset flow for a user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'unlockUser', description: 'Unlock a user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'assignUserToGroup', description: 'Add a user to a group.', inputSchema: obj({ ...ENV, userId: S, groupId: S }, ['environmentId', 'userId', 'groupId']), role: 'admin' },
  { name: 'deleteUser', description: 'Delete a user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), annotations: { destructiveHint: true }, role: 'admin' },
  { name: 'deleteApplication', description: 'Delete an application.', inputSchema: obj({ ...ENV, applicationId: S }, ['environmentId', 'applicationId']), role: 'admin' },
  { name: 'purgeUserData', description: 'Purge user data.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'syncTenantWidgets', description: 'A tool with an unrecognised verb: classified write.', inputSchema: obj({ ...ENV }), role: 'admin' },
];
const stripRole = ({ role, ...t }) => t;

export function createMock({ now = Date.now } = {}) {
  const config = { forgeIdToken: false, sse: false, expiresIn: 3600, issOverride: null, nonceOverride: null, audOverride: null, calls: [] };
  const tokens = new Map();   // access -> { role, exp, sub, clientId }
  const refreshes = new Map(); // refresh -> { role, sub, clientId }
  const codes = new Map();     // code -> { clientId, redirectUri, challenge, nonce, role, envId }
  const clients = new Map();   // id -> { secret, role }  (unregistered ids are accepted offline)
  const freshTenant = () => ({ users: [{ id: 'u1', username: 'sample.user', enabled: true }, { id: 'u2', username: 'other.user', enabled: true }], applications: [{ id: 'a1', name: 'Sample App' }] });
  const tenant = freshTenant();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-1', alg: 'RS256', use: 'sig' };
  let n = 0; let server; let base = '';

  const roleOf = (clientId) => clients.get(clientId)?.role || (/^viewer/i.test(clientId) ? 'viewer' : 'admin');
  const issuer = (env) => config.issOverride || `${base}/${env}/as`;

  function issue(clientId, role, sub, withRefresh) {
    const access = `mock-at-${++n}-${crypto.randomBytes(6).toString('hex')}`;
    tokens.set(access, { role, sub, clientId, exp: now() + config.expiresIn * 1000 });
    const out = { access_token: access, token_type: 'Bearer', expires_in: config.expiresIn };
    if (withRefresh) { const r = `mock-rt-${++n}-${crypto.randomBytes(6).toString('hex')}`; refreshes.set(r, { role, sub, clientId }); out.refresh_token = r; }
    return out;
  }
  const forgerKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; // test-only: a key the jwks does not publish
  function idToken(env, clientId, sub, nonce) {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'mock-1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: issuer(env), aud: config.audOverride ?? clientId, sub, nonce: config.nonceOverride ?? nonce, exp: Math.floor(now() / 1000) + 600, iat: Math.floor(now() / 1000) })).toString('base64url');
    return `${h}.${p}.${crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(config.forgeIdToken ? forgerKey : privateKey).toString('base64url')}`;
  }

  function callTool(name, a) {
    const t = tenant;
    switch (name) {
      case 'listApplications': return t.applications;
      case 'getApplication': return t.applications.find((x) => x.id === a.applicationId) || null;
      case 'listUsers': case 'searchUsers': return t.users;
      case 'getUser': return t.users.find((x) => x.id === a.userId) || null;
      case 'createApplication': { const x = { id: `a${t.applications.length + 1}`, name: a.name }; t.applications.push(x); return x; }
      case 'createUser': { const x = { id: `u${t.users.length + 1}`, username: a.username, enabled: true }; t.users.push(x); return x; }
      case 'disableUser': case 'enableUser': { const u = t.users.find((x) => x.id === a.userId); if (u) u.enabled = name === 'enableUser'; return u || null; }
      case 'deleteUser': t.users = t.users.filter((x) => x.id !== a.userId); return { deleted: a.userId };
      case 'deleteApplication': t.applications = t.applications.filter((x) => x.id !== a.applicationId); return { deleted: a.applicationId };
      default: return { ok: true, note: `${name} ran against the in-memory fake tenant` };
    }
  }

  function rpc(role, msg) {
    const tools = CATALOG.filter((t) => role === 'admin' || t.role === 'viewer');
    switch (msg.method) {
      case 'initialize': return { protocolVersion: '2025-06-18', serverInfo: { name: 'mock-pingone-mcp', version: FIXTURE_LABEL }, capabilities: { tools: {} } };
      case 'tools/list': return { tools: tools.map(stripRole) };
      case 'tools/call': {
        const name = msg.params?.name; const a = msg.params?.arguments || {};
        if (!tools.some((t) => t.name === name)) return { error: { code: -32602, message: `unknown tool: ${String(name).slice(0, 60)}` } };
        config.calls.push({ name, arguments: a });
        return { result: { content: [{ type: 'text', text: JSON.stringify(callTool(name, a)) }] } };
      }
      case 'resources/list': return { resources: [] };
      case 'prompts/list': return { prompts: [] };
      default: return { error: { code: -32601, message: 'method not found' } };
    }
  }

  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
  const send = (res, status, body, type = 'application/json', extra = {}) => { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

  async function handle(req, res) {
    const url = new URL(req.url, base || 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'mcp' && req.method === 'POST') {
      const tok = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!tok || tok.exp <= now()) return send(res, 401, { error: 'Invalid authentication' });
      let msg; try { msg = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
      const r = rpc(tok.role, msg);
      const out = { jsonrpc: '2.0', id: msg.id, ...(r.error || r.result ? r : { result: r }) };
      return config.sse ? send(res, 200, `event: message\ndata: ${JSON.stringify(out)}\n\n`, 'text/event-stream') : send(res, 200, out);
    }
    if (parts[1] === 'as' && parts[2] === 'jwks') return send(res, 200, { keys: [jwk] });
    if (parts[1] === 'as' && parts[2] === 'token' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      let id = f.get('client_id'); let secret = f.get('client_secret');
      const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
      if (basic) { const [i, ...s] = Buffer.from(basic[1], 'base64').toString().split(':'); id = i; secret = s.join(':'); }
      const g = f.get('grant_type');
      if (g === 'client_credentials') {
        const c = clients.get(id);
        if (!id || !secret || (c && c.secret !== secret)) return send(res, 401, { error: 'invalid_client', error_description: 'bad client credentials' });
        return send(res, 200, issue(id, roleOf(id), `worker:${id}`, false));
      }
      if (g === 'refresh_token') {
        const r = refreshes.get(f.get('refresh_token'));
        if (!r) return send(res, 400, { error: 'invalid_grant' });
        refreshes.delete(f.get('refresh_token'));
        return send(res, 200, issue(r.clientId, r.role, r.sub, true));
      }
      if (g === 'authorization_code') {
        const c = codes.get(f.get('code')); codes.delete(f.get('code'));
        if (!c || c.redirectUri !== f.get('redirect_uri') || c.clientId !== f.get('client_id') || pkceChallenge(f.get('code_verifier') || '') !== c.challenge) return send(res, 400, { error: 'invalid_grant' });
        const out = issue(c.clientId, c.role, 'mock-admin-user', true);
        out.id_token = idToken(c.envId, c.clientId, 'mock-admin-user', c.nonce);
        return send(res, 200, out);
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (parts[1] === 'as' && parts[2] === 'authorize') {
      const q = url.searchParams;
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce') || !q.get('redirect_uri')) return send(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), challenge: q.get('code_challenge'), nonce: q.get('nonce'), role: roleOf(q.get('client_id')), envId: parts[0] });
      const back = new URL(q.get('redirect_uri'));
      back.search = new URLSearchParams({ code, state: q.get('state'), iss: issuer(parts[0]) }).toString();
      return send(res, 302, '', 'text/plain', { Location: back.toString() });
    }
    return send(res, 404, { error: 'not_found' });
  }

  return {
    config, tenant, clients, tokens, refreshes,
    get base() { return base; },
    revoke: (access) => tokens.delete(access),
    // Reset: the fake tenant goes back to its starting records and every token, code and recorded call is dropped.
    reset() { Object.assign(tenant, freshTenant()); tokens.clear(); refreshes.clear(); codes.clear(); config.calls.length = 0; },
    async start() {
      server = http.createServer((q, r) => { handle(q, r).catch(() => send(r, 500, { error: 'mock_error' })); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    async stop() { if (!server) return; server.closeAllConnections?.(); await new Promise((r) => server.close(r)); server = null; },
  };
}
