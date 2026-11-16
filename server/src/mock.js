// In-process mock of the hosted PingOne MCP server AND a PingOne-like authorization server (token, authorize, jwks),
// on loopback. Used by mock mode and by tests. The tool catalog mirrors the MFA administration tool set PingOne
// announced for early access (verified live in the family demo 2026-11-12: names, camelCase arguments, role-gated
// list) plus a small general-admin sample; shapes follow the pingone-mcp conventions. It is an ILLUSTRATIVE SAMPLE,
// NOT A RECORDING of any tenant. Write tools change only the in-memory fake tenant below.
import crypto from 'node:crypto';
import http from 'node:http';
import { pkceChallenge } from './auth.js';

export const FIXTURE_LABEL = 'illustrative sample, not a recording';
export const SYNTHETIC_NOTE = 'invented sample: the mock has no data for this tool. A recorded fixture replaces this with a real response.';
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' };
const ENV = { environmentId: S };

// role: 'viewer' sees only read tools; 'admin' sees all. The role rides on the signed-in mock user (MOCK_USERS), as the tools a
// real user sees depend on that user's admin roles (Ping's MCP docs); the client id plays no part.
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
  { name: 'syncTenantWidgets', description: 'Re-syncs tenant widgets. A deliberately unusual verb, to show how a tool with no recognised read/write verb is classified and gated.', inputSchema: obj({ ...ENV }), role: 'admin' },
];

const CATALOG = [...MFA_CATALOG, ...GENERAL_CATALOG];

// The mock authorization server's native (pi.flow) sign-in. These accounts exist ONLY here; the dialog offers them for the mock connection.
// All share one password and one code. mock.admin: password, then an SMS code; every tool. mock.viewer: the same steps; read tools only.
// mock.nomfa: password only. mock.multi: password, a device choice (SMS or email), then the code.
export const MOCK_LOGIN = { username: 'mock.admin', password: 'mock-password', otp: '123456', viewer: 'mock.viewer' };
const SMS = { id: 'mock-dev-sms', type: 'SMS', phone: '+1 *** *** 0142', usableStatus: { status: 'ENABLED' } };
const EMAIL = { id: 'mock-dev-email', type: 'EMAIL', email: 'mock.multi@example.invalid', usableStatus: { status: 'ENABLED' } };
const MOCK_USERS = {
  'mock.admin': { devices: [SMS], role: 'admin' }, 'mock.viewer': { devices: [SMS], role: 'viewer' },
  'mock.nomfa': { devices: [], role: 'admin' }, 'mock.multi': { devices: [SMS, EMAIL], role: 'admin' },
};
// PingOne's native-flow step names (vendor content types) and error codes.
const FLOW = { password: 'usernamePassword.check', otp: 'otp.check', device: 'device.select', badPassword: 'INVALID_CREDENTIALS', badOtp: 'OTP_VALIDATION_FAILED' };
const vnd = (name) => `application/vnd.pingidentity.${name}+json`;
const stripRole = ({ role, ...t }) => t;

export function createMock({ now = Date.now } = {}) {
  // resources: every RFC 8707 resource indicator the mock AS received ({ at: 'authorize'|'authorization_code'|'refresh_token', resource }).
  // The mock accepts it and does not act on it.
  const config = { forgeIdToken: false, sse: false, expiresIn: 3600, issOverride: null, nonceOverride: null, audOverride: null, calls: [], resumeAsJson: false, afterPassword: null, flowSteps: [], resources: [] };
  const tokens = new Map();   // access -> { role, exp, sub, clientId }
  const refreshes = new Map(); // refresh -> { role, sub, clientId }
  const codes = new Map();     // code -> { clientId, redirectUri, challenge, nonce, role, sub, envId }
  const flows = new Map();     // flow id -> { kind, clientId, redirectUri, challenge, nonce, envId, status, user, st, devices, code }
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
  const recordedFixtures = new Map(); // tool -> { source, recordedAt, result }: real responses captured from a Live server
  const recordedTools = new Map(); // tool -> { name, description, inputSchema, annotations, role }: a Live server's tools/list, answered with synthetic replies

  const roleOfUser = (username) => (MOCK_USERS[username]?.role === 'viewer' ? 'viewer' : 'admin');
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
      // Any tool this catalog does not know (the mock demo can be pointed at a custom server's tool
      // list): synthesize a plausible read-shaped answer from the arguments instead of a bare "ok",
      // so the demo shows real-looking JSON-RPC even before anyone records a fixture.
      default: return synthetic(name, a);
    }
  }

  // A best-effort fake for a tool outside the catalog. Read-shaped (a listing or a record), echoed
  // arguments included, and always carrying the synthetic label — never mistaken for recorded data.
  function synthetic(name, a) {
    const list = /^(list|search|find)/i.test(name);
    const record = { tool: name, synthetic: true, note: SYNTHETIC_NOTE, arguments: a };
    return list
      ? { items: [record], total: 1, synthetic: true }
      : record;
  }

  function rpc(role, msg) {
    const tools = [...CATALOG, ...recordedTools.values()].filter((t) => role === 'admin' || t.role === 'viewer');
    switch (msg.method) {
      case 'initialize': return { protocolVersion: '2025-06-18', serverInfo: { name: 'mock-pingone-mcp', version: FIXTURE_LABEL }, capabilities: { tools: {} } };
      case 'tools/list': return { tools: tools.map(stripRole) };
      case 'tools/call': {
        const name = msg.params?.name; const a = msg.params?.arguments || {};
        const fixture = recordedFixtures.get(name);
        // A tool with a recorded fixture is discoverable even though it is not in the sample catalog:
        // the recording came from a real server, so the mock answers for it. The recording carries the
        // real JSON-RPC result verbatim, labelled as a recording, never re-generated.
        if (!tools.some((t) => t.name === name) && !fixture) return { error: { code: -32602, message: `unknown tool: ${String(name).slice(0, 60)}` } };
        config.calls.push({ name, arguments: a });
        if (fixture) return { result: { ...fixture.result, _meta: { ...(fixture.result?._meta || {}), recordedFrom: fixture.source, recordedAt: fixture.recordedAt } } };
        return { result: { content: [{ type: 'text', text: JSON.stringify(callTool(name, a)) }] } };
      }
      case 'resources/list': return { resources: [] };
      case 'prompts/list': return { prompts: [] };
      default: return { error: { code: -32601, message: 'method not found' } };
    }
  }

  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
  const send = (res, status, body, type = 'application/json', extra = {}) => { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };


  // ---- native flow (response_mode=pi.flow): POST steps to the flow, carrying the session-token cookie that rotates on every step.
  const stCookie = (flow) => ({ 'Set-Cookie': `ST=${flow.st}; Path=/; HttpOnly` });
  const flowView = (flow, extra = {}) => ({ id: flow.id, status: flow.status, ...extra });
  function openFlow(envId, q) {
    if (q.get('response_type') !== 'code' || q.get('response_mode') !== 'pi.flow' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('nonce') || !q.get('redirect_uri') || !q.get('client_id')) return null;
    if (q.has('resource')) config.resources.push({ at: 'authorize', resource: q.get('resource') });
    const flow = { id: `mockflow${crypto.randomBytes(8).toString('hex')}`, clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), challenge: q.get('code_challenge'), nonce: q.get('nonce'), envId, status: 'USERNAME_PASSWORD_REQUIRED', st: crypto.randomBytes(12).toString('hex') };
    flows.set(flow.id, flow);
    return flow;
  }
  const deviceBody = (flow, devices) => ({ _embedded: { devices }, devices, ...(devices.length === 1 ? { selectedDevice: { id: devices[0].id } } : {}), id: flow.id });
  function issueCode(flow) {
    const code = crypto.randomBytes(16).toString('hex');
    const role = roleOfUser(flow.user);
    codes.set(code, { clientId: flow.clientId, redirectUri: flow.redirectUri, challenge: flow.challenge, nonce: flow.nonce, role, sub: `mock-${role}-user`, envId: flow.envId });
    return code;
  }
  async function flowStep(req, res, flow) {
    const k = FLOW;
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim();
    const sent = /(?:^|;\s*)ST=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1];
    if (sent !== flow.st) return send(res, 401, { code: 'INVALID_TOKEN', message: 'Session token cookie value does not match' });
    let b; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { code: 'INVALID_REQUEST' }); }
    const done = (extra) => { flow.st = crypto.randomBytes(12).toString('hex'); config.flowSteps.push({ status: flow.status, contentType: ct }); return send(res, 200, flowView(flow, extra), 'application/json', stCookie(flow)); };
    const finishFlow = () => { flow.status = 'COMPLETED'; flow.code = issueCode(flow); return done({ resumeUrl: `${base}/${flow.envId}/as/resume?flowId=${flow.id}` }); };
    const stepName = Object.entries(k).find(([, v]) => v && ct === vnd(v))?.[0];
    if (stepName === 'password' && flow.status === 'USERNAME_PASSWORD_REQUIRED') {
      const u = MOCK_USERS[b.username];
      if (!u || b.password !== MOCK_LOGIN.password) return send(res, 400, { code: 'INVALID_DATA', details: [{ code: k.badPassword, message: 'The provided credentials are invalid' }] });
      flow.user = b.username; flow.devices = u.devices;
      if (config.afterPassword) { flow.status = config.afterPassword; return done(); }
      if (!u.devices.length) return finishFlow();
      flow.status = u.devices.length > 1 ? 'DEVICE_SELECTION_REQUIRED' : 'OTP_REQUIRED';
      return done(deviceBody(flow, u.devices));
    }
    if (stepName === 'device' && (flow.status === 'DEVICE_SELECTION_REQUIRED' || flow.status === 'OTP_REQUIRED')) {
      const id = b.device?.id;
      const dev = flow.devices.find((d) => d.id === id);
      if (!dev) return send(res, 400, { code: 'INVALID_DATA', details: [{ code: 'INVALID_VALUE', message: 'unknown device' }] });
      flow.status = 'OTP_REQUIRED';
      return done(deviceBody(flow, [dev]));
    }
    if (stepName === 'otp' && flow.status === 'OTP_REQUIRED') {
      if (b.otp !== MOCK_LOGIN.otp) return send(res, 400, { code: 'INVALID_DATA', details: [{ code: k.badOtp, message: 'The passcode is not valid' }] });
      return finishFlow();
    }
    return send(res, stepName ? 400 : 415, { code: stepName ? 'INVALID_FLOW_STATE' : 'UNSUPPORTED_MEDIA_TYPE', message: `${flow.status}: that step is not allowed now` });
  }

  async function handle(req, res) {
    const url = new URL(req.url, base || 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[1] === 'flows' && parts[2] && req.method === 'POST') { const f = flows.get(parts[2]); return f && f.envId === parts[0] ? flowStep(req, res, f) : send(res, 404, { code: 'NOT_FOUND' }); }
    if (parts[1] === 'as' && parts[2] === 'resume' && req.method === 'GET') {
      const f = flows.get(url.searchParams.get('flowId') || '');
      const sent = /(?:^|;\s*)ST=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1];
      if (!f || f.status !== 'COMPLETED' || !f.code || sent !== f.st) return send(res, 400, { code: 'INVALID_FLOW', message: 'Session token cookie value does not match' });
      const code = f.code; f.code = null;
      if (config.resumeAsJson) return send(res, 200, { authorizeResponse: { code } });
      return send(res, 302, '', 'text/plain', { Location: `${f.redirectUri}?${new URLSearchParams({ code })}` });
    }
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
      // Only the two grants a user sign-in needs. client_credentials is refused: the hosted MCP takes a user, not a worker.
      const f = new URLSearchParams(await readBody(req));
      const g = f.get('grant_type');
      if (f.has('resource')) config.resources.push({ at: g, resource: f.get('resource') });
      if (g === 'refresh_token') {
        const r = refreshes.get(f.get('refresh_token'));
        if (!r) return send(res, 400, { error: 'invalid_grant' });
        refreshes.delete(f.get('refresh_token'));
        return send(res, 200, issue(r.clientId, r.role, r.sub, true));
      }
      if (g === 'authorization_code') {
        const c = codes.get(f.get('code')); codes.delete(f.get('code'));
        if (!c || c.redirectUri !== f.get('redirect_uri') || c.clientId !== f.get('client_id') || pkceChallenge(f.get('code_verifier') || '') !== c.challenge) return send(res, 400, { error: 'invalid_grant' });
        const out = issue(c.clientId, c.role, c.sub, true);
        out.id_token = idToken(c.envId, c.clientId, c.sub, c.nonce);
        return send(res, 200, out);
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (parts[1] === 'as' && parts[2] === 'authorize') {
      // Only the native flow: a redirect request is refused, the way an app that does not allow it would refuse it (rule 16).
      const flow = openFlow(parts[0], url.searchParams);
      if (!flow) return send(res, 400, { error: 'invalid_request', error_description: 'this mock authorization server answers only response_mode=pi.flow with code + PKCE S256 and a nonce' });
      return send(res, 200, flowView(flow), 'application/json', stCookie(flow));
    }
    return send(res, 404, { error: 'not_found' });
  }

  return {
    config, tenant, tokens, refreshes,
    get base() { return base; },
    handle,
    // Real responses recorded from a Live server; served by tools/call before the in-process sample.
    setFixtures: (all) => { recordedFixtures.clear(); for (const [k, v] of Object.entries(all || {})) recordedFixtures.set(k, v); },
    fixturesLoaded: () => recordedFixtures.size,
    // Tool lists recorded from Live servers: listed by the mock and answered with a synthetic reply (or a fixture).
    // A name the sample catalog already has keeps the catalog's tool. role 'viewer' = the tool classes as read.
    setRecordedTools: (list) => { recordedTools.clear(); for (const t of list || []) if (!CATALOG.some((c) => c.name === t.name)) recordedTools.set(t.name, t); },
    revoke: (access) => tokens.delete(access),
    // Reset: the fake tenant goes back to its starting records and every token, code and recorded call is dropped.
    reset() { Object.assign(tenant, freshTenant()); tokens.clear(); refreshes.clear(); codes.clear(); flows.clear(); config.calls.length = 0; config.flowSteps.length = 0; config.resources.length = 0; },
    async start() {
      server = http.createServer((q, r) => { handle(q, r).catch(() => send(r, 500, { error: 'mock_error' })); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    async stop() { if (!server) return; server.closeAllConnections?.(); await new Promise((r) => server.close(r)); server = null; },
  };
}
