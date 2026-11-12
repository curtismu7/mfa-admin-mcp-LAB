// In-process mock of the hosted PingOne MCP server AND a PingOne-like authorization server (token, authorize, jwks),
// on loopback. Used by mock mode and by tests. The tool catalog mirrors the MFA administration tool set PingOne
// announced for early access (verified live in the family demo 2026-11-12: names, camelCase arguments, role-gated
// list) plus a small general-admin sample; shapes follow the pingone-mcp conventions. It is an ILLUSTRATIVE SAMPLE,
// NOT A RECORDING of any tenant. Write tools change only the in-memory fake tenant below.
import crypto from 'node:crypto';
import http from 'node:http';
import { pkceChallenge } from './auth.js';

export const FIXTURE_LABEL = 'illustrative sample, not a recording';
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' };
const ENV = { environmentId: S };

// role: 'viewer' sees only read tools; 'admin' sees all.
// MFA ADMINISTRATION — the lab's subject. Environment MFA settings, device-authentication
// and FIDO (passkey) policies, notification policies, OATH tokens, and sender/delivery
// settings for email, phone and WhatsApp.
const MFA_CATALOG = [
  { name: 'getMfaSettings', description: 'Get the environment MFA settings: pairing, authentication, phone extensions.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'updateMfaSettings', description: 'Update the environment MFA settings.', inputSchema: obj({ ...ENV, pairingKeyFormat: S }, ['environmentId']), role: 'admin' },
  { name: 'resetMfaSettings', description: 'Reset the environment MFA settings to defaults.', inputSchema: obj({ ...ENV }, ['environmentId']), role: 'admin' },
  { name: 'listMfaDeviceAuthenticationPolicies', description: 'List MFA device authentication policies.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getMfaDeviceAuthenticationPolicy', description: 'Get one MFA device authentication policy.', inputSchema: obj({ ...ENV, policyId: S }, ['environmentId', 'policyId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'createMfaDeviceAuthenticationPolicy', description: 'Create an MFA device authentication policy.', inputSchema: obj({ ...ENV, name: S }, ['environmentId', 'name']), role: 'admin' },
  { name: 'updateMfaDeviceAuthenticationPolicy', description: 'Update an MFA device authentication policy.', inputSchema: obj({ ...ENV, policyId: S, name: S }, ['environmentId', 'policyId']), role: 'admin' },
  { name: 'deleteMfaDeviceAuthenticationPolicy', description: 'Delete an MFA device authentication policy.', inputSchema: obj({ ...ENV, policyId: S }, ['environmentId', 'policyId']), annotations: { destructiveHint: true }, role: 'admin' },
  { name: 'listFidoPolicies', description: 'List FIDO (passkey) policies.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getFidoPolicy', description: 'Get one FIDO policy.', inputSchema: obj({ ...ENV, policyId: S }, ['environmentId', 'policyId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'createFidoPolicy', description: 'Create a FIDO policy.', inputSchema: obj({ ...ENV, name: S }, ['environmentId', 'name']), role: 'admin' },
  { name: 'updateFidoPolicy', description: 'Update a FIDO policy.', inputSchema: obj({ ...ENV, policyId: S, name: S }, ['environmentId', 'policyId']), role: 'admin' },
  { name: 'deleteFidoPolicy', description: 'Delete a FIDO policy.', inputSchema: obj({ ...ENV, policyId: S }, ['environmentId', 'policyId']), annotations: { destructiveHint: true }, role: 'admin' },
  { name: 'listNotificationPolicies', description: 'List notification policies with their delivery quotas.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getNotificationPolicy', description: 'Get one notification policy.', inputSchema: obj({ ...ENV, policyId: S }, ['environmentId', 'policyId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'createNotificationPolicy', description: 'Create a notification policy.', inputSchema: obj({ ...ENV, name: S }, ['environmentId', 'name']), role: 'admin' },
  { name: 'updateNotificationPolicy', description: 'Update a notification policy.', inputSchema: obj({ ...ENV, policyId: S, name: S }, ['environmentId', 'policyId']), role: 'admin' },
  { name: 'deleteNotificationPolicy', description: 'Delete a notification policy.', inputSchema: obj({ ...ENV, policyId: S }, ['environmentId', 'policyId']), annotations: { destructiveHint: true }, role: 'admin' },
  { name: 'getNotificationsSettings', description: 'Get environment notification settings: from address, delivery mode, quotas.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'listOathTokens', description: 'List OATH tokens.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getOathToken', description: 'Get one OATH token by id.', inputSchema: obj({ ...ENV, tokenId: S }, ['environmentId', 'tokenId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getOathTokenBySerialNumber', description: 'Get one OATH token by serial number.', inputSchema: obj({ ...ENV, serialNumber: S }, ['environmentId', 'serialNumber']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getEmailDeliverySettings', description: 'Get email sender and delivery settings.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'listPhoneDeliverySettings', description: 'List phone (SMS/voice) delivery settings.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getPhoneDeliverySettings', description: 'Get one phone delivery settings record.', inputSchema: obj({ ...ENV, settingsId: S }, ['environmentId', 'settingsId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getWhatsAppDeliverySettings', description: 'Get WhatsApp delivery settings.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
];

// A small general-admin sample so the scan/classification story keeps its variety.
const GENERAL_CATALOG = [
  { name: 'listApplications', description: 'List applications in the environment.', inputSchema: obj({ ...ENV }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'getUser', description: 'Get one user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'viewer' },
  { name: 'listUsers', description: 'List users.', inputSchema: obj({ ...ENV, filter: S }, ['environmentId']), annotations: { readOnlyHint: true }, role: 'viewer' },
  { name: 'createUser', description: 'Create a user.', inputSchema: obj({ ...ENV, username: S, email: S, populationId: S }, ['environmentId', 'username']), role: 'admin' },
  { name: 'deleteUser', description: 'Delete a user.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), annotations: { destructiveHint: true }, role: 'admin' },
  { name: 'purgeUserData', description: 'Purge user data.', inputSchema: obj({ ...ENV, userId: S }, ['environmentId', 'userId']), role: 'admin' },
  { name: 'syncTenantWidgets', description: 'A tool with an unrecognised verb: classified write.', inputSchema: obj({ ...ENV }), role: 'admin' },
];

const CATALOG = [...MFA_CATALOG, ...GENERAL_CATALOG];
const stripRole = ({ role, ...t }) => t;

export function createMock({ now = Date.now } = {}) {
  const config = { forgeIdToken: false, sse: false, expiresIn: 3600, issOverride: null, nonceOverride: null, audOverride: null, calls: [] };
  const tokens = new Map();   // access -> { role, exp, sub, clientId }
  const refreshes = new Map(); // refresh -> { role, sub, clientId }
  const codes = new Map();     // code -> { clientId, redirectUri, challenge, nonce, role, envId }
  const clients = new Map();   // id -> { secret, role }  (unregistered ids are accepted offline)
  const freshTenant = () => ({
    users: [{ id: 'u1', username: 'sample.user', enabled: true }, { id: 'u2', username: 'other.user', enabled: true }],
    applications: [{ id: 'a1', name: 'Sample App' }],
    mfaSettings: { pairing: { maxAllowedDevices: 20 }, authentication: { deviceSelection: 'DEFAULT_TO_FIRST' }, users: { mfaEnabled: true } },
    fidoPolicies: [{ id: 'f1', name: 'Passkeys', authenticatorAttachment: 'PLATFORM', discoverableCredentials: 'REQUIRED' }],
    deviceAuthPolicies: [{ id: 'd1', name: 'Default MFA Policy', deviceSelection: 'ALWAYS_DISPLAY_DEVICES' }],
    notificationPolicies: [{ id: 'n1', name: 'Default Notification Policy', default: true, deliveryMethods: ['SMS', 'Voice', 'WhatsApp'] }],
    notificationsSettings: { deliveryMode: 'ALL', from: { name: 'PingOne', address: 'noreply@example.com' } },
    oathTokens: [],
    emailDelivery: { protocol: 'SMTPS' },
    phoneDelivery: [],
  });
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
      // MFA administration — read
      case 'getMfaSettings': return t.mfaSettings;
      case 'listMfaDeviceAuthenticationPolicies': return t.deviceAuthPolicies;
      case 'getMfaDeviceAuthenticationPolicy': return t.deviceAuthPolicies.find((x) => x.id === a.policyId) || null;
      case 'listFidoPolicies': return t.fidoPolicies;
      case 'getFidoPolicy': return t.fidoPolicies.find((x) => x.id === a.policyId) || null;
      case 'listNotificationPolicies': return t.notificationPolicies;
      case 'getNotificationPolicy': return t.notificationPolicies.find((x) => x.id === a.policyId) || null;
      case 'getNotificationsSettings': return t.notificationsSettings;
      case 'listOathTokens': return t.oathTokens;
      case 'getOathToken': return t.oathTokens.find((x) => x.id === a.tokenId) || null;
      case 'getOathTokenBySerialNumber': return t.oathTokens.find((x) => x.serialNumber === a.serialNumber) || null;
      case 'getEmailDeliverySettings': return t.emailDelivery;
      case 'listPhoneDeliverySettings': return t.phoneDelivery;
      case 'getPhoneDeliverySettings': return t.phoneDelivery.find((x) => x.id === a.settingsId) || null;
      case 'getWhatsAppDeliverySettings': return { provider: null, enabled: false };
      // MFA administration — write (in-memory fake tenant only)
      case 'updateMfaSettings': { Object.assign(t.mfaSettings, { pairing: { ...t.mfaSettings.pairing, pairingKeyFormat: a.pairingKeyFormat || t.mfaSettings.pairing.pairingKeyFormat } }); return t.mfaSettings; }
      case 'resetMfaSettings': t.mfaSettings = freshTenant().mfaSettings; return t.mfaSettings;
      case 'createMfaDeviceAuthenticationPolicy': { const x = { id: `d${t.deviceAuthPolicies.length + 1}`, name: a.name }; t.deviceAuthPolicies.push(x); return x; }
      case 'updateMfaDeviceAuthenticationPolicy': { const x = t.deviceAuthPolicies.find((p) => p.id === a.policyId); if (x) x.name = a.name || x.name; return x || null; }
      case 'deleteMfaDeviceAuthenticationPolicy': t.deviceAuthPolicies = t.deviceAuthPolicies.filter((x) => x.id !== a.policyId); return { deleted: a.policyId };
      case 'createFidoPolicy': { const x = { id: `f${t.fidoPolicies.length + 1}`, name: a.name }; t.fidoPolicies.push(x); return x; }
      case 'updateFidoPolicy': { const x = t.fidoPolicies.find((p) => p.id === a.policyId); if (x) x.name = a.name || x.name; return x || null; }
      case 'deleteFidoPolicy': t.fidoPolicies = t.fidoPolicies.filter((x) => x.id !== a.policyId); return { deleted: a.policyId };
      case 'createNotificationPolicy': { const x = { id: `n${t.notificationPolicies.length + 1}`, name: a.name, default: false }; t.notificationPolicies.push(x); return x; }
      case 'updateNotificationPolicy': { const x = t.notificationPolicies.find((p) => p.id === a.policyId); if (x) x.name = a.name || x.name; return x || null; }
      case 'deleteNotificationPolicy': t.notificationPolicies = t.notificationPolicies.filter((x) => x.id !== a.policyId); return { deleted: a.policyId };
      // General-admin sample
      case 'listApplications': return t.applications;
      case 'listUsers': return t.users;
      case 'getUser': return t.users.find((x) => x.id === a.userId) || null;
      case 'createUser': { const x = { id: `u${t.users.length + 1}`, username: a.username, enabled: true }; t.users.push(x); return x; }
      case 'deleteUser': t.users = t.users.filter((x) => x.id !== a.userId); return { deleted: a.userId };
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
