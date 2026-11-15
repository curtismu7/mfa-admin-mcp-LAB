import fs from 'node:fs';
import express from 'express';
import { createAuth } from './auth.js';
import { annotate } from './classify.js';
import { analyze, LIMITS, RULES } from './scanner/index.js';
import { MODES, MODE_KEY, dataDir as cfgDataDir, liveRefusal, modeFrom, webDist } from './config.js';
import { createDiagrams, DIAGRAM_DIR } from './diagrams.js';
import { createAudit, decide, argsHash } from './gate.js';
import { createFixtures, createRecordedTools } from './fixtures.js';
import { createHealth } from './health.js';
import { createMcpClient } from './mcpClient.js';
import { createMock, MOCK_LOGIN } from './mock.js';
import { permit } from './netguard.js';
import { setupRouter } from './setup.js';
import { scrub, scrubJson } from './redact.js';
import { hostCheck, isLoopbackHost, labAllowedHosts, sameOriginWrites } from './security.js';
import { createStore } from './store.js';
import { validateArgs } from './validate.js';
import { liveHosts, mcpUrl } from './urls.js';
import { shelfInfo } from './shelfLink.js';

const RAW_FREE = new Set(['initialize', 'ping', 'tools/list', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get']);
const isMock = (c) => c.kind === 'pingone' && c.offline === true;
const HINT_SHORT = 'A short list usually means the signed-in user is missing admin roles, not a broken server (Ping\'s MCP docs: the tools a user sees depend on that user\'s admin roles; this tool has not verified the count against a live tenant).';
const EXPECTED_NOTE = 'The list follows the admin roles of the signed-in user: a user with fewer roles sees fewer tools (Ping\'s MCP docs). How many tools a fully privileged administrator sees is UNVERIFIED by this tool.';

export function createApp({ env = process.env, lab = labAllowedHosts(env), store, mock, fetchImpl = fetch, now = Date.now, diagramsDir = DIAGRAM_DIR } = {}) {
  const diagrams = createDiagrams({ dir: diagramsDir }); // diagram-studio/1 data, validated now: an invalid file stops the app from starting
  const dir = cfgDataDir(env);
  store ||= createStore({ dir });
  const audit = createAudit({ dir });
  const fixtures = createFixtures({ dir });
  const recordedTools = createRecordedTools({ dir });
  // The mock lists recorded tools to a viewer only when they class as read, the way the sample catalog is role-gated.
  const feedRecordedTools = () => theMock.setRecordedTools?.(annotate(recordedTools.all()).map(({ name, description, inputSchema, annotations, class: c }) => ({ name, description, inputSchema, annotations, role: c === 'read' ? 'viewer' : 'admin' })));
  const theMock = mock || createMock();
  let mockStarted = Boolean(mock?.base);
  const ensureMock = async () => { if (!mockStarted) { await theMock.start(); mockStarted = true; } };
  const offlineBase = (c) => (c.kind === 'pingone' && c.offline ? theMock.base : null);
  const auth = createAuth({ resolveBase: offlineBase, fetchImpl, now });
  const health = createHealth({ store, env });
  // Live is refused unless every guard in config.js passes. A saved connection to anything but the in-process mock is Live.
  const liveGate = liveRefusal(env);
  const refuseLive = (res) => res.status(403).json({ error: 'live_refused', message: `Live is refused: ${liveGate.failed.join(', ')}. ${liveGate.needs.join(' ')}`, failed: liveGate.failed, needs: liveGate.needs });
  // A short-lived permit for each host the connection can reach, held while one operation on it runs (see netguard.js).
  async function withPermits(conn, fn) {
    const releases = liveHosts(conn).map((host) => permit(host));
    try { return await fn(); } finally { for (const r of releases) r(); }
  }

  const secretsFor = (conn) => [...store.secretsOf(conn), ...auth.allSecrets()];
  const view = (c) => ({ ...store.publicView(c), auth_status: auth.status(c) });

  // Inside the container, 'localhost' in a saved URL is the container itself, not the machine the
  // browser means. When running as the container image, dial the host for loopback targets
  // (host.docker.internal; the compose file's loopback-only publish is unchanged).
  const dialUrl = (raw) => {
    if (process.env.MFAADM_CONTAINER !== '1') return raw;
    try { const u = new URL(raw); if (isLoopbackHost(u.hostname)) { u.hostname = 'host.docker.internal'; return u.toString(); } } catch { /* kept as-is */ }
    return raw;
  };

  function clientFor(conn) {
    if (conn.kind === 'pingone') {
      return createMcpClient({
        url: conn.offline ? mcpUrl({ ...conn, offlineBase: offlineBase(conn) }) : dialUrl(mcpUrl(conn)), fetchImpl,
        getAuth: async () => ['Authorization', `Bearer ${await auth.accessToken(conn)}`],
        refreshAuth: () => auth.renew(conn),
      });
    }
    // A stored token is the bare credential; the standard Authorization header needs the Bearer scheme.
    // A header named anything else (or a token that already carries a scheme) is sent as-is.
    const headerFor = (c) => {
      const name = c.authHeader || 'Authorization';
      const v = String(c.token);
      const needsBearer = /^authorization$/i.test(name) && !/^[a-z]+ /i.test(v);
      return [name, needsBearer ? `Bearer ${v}` : v];
    };
    return createMcpClient({ url: dialUrl(conn.url), fetchImpl, handshake: true, getAuth: async () => (conn.token ? headerFor(conn) : null) });
  }

  function fail(res, conn, err) {
    const secrets = conn ? secretsFor(conn) : auth.allSecrets();
    const message = scrub(err?.message || 'error', secrets).slice(0, 300);
    const code = err?.code || 'internal_error';
    const status = /^(login_required|invalid_credentials|invalid_otp)$/.test(code) ? 401 : code === 'login_expired' ? 410 : /^(login_unsupported|worker_unsupported)$/.test(code) ? 409 : code === 'mcp_timeout' ? 504
      : /^(mcp_|token_|jwks_|pi_flow_|bad_id_token|iss_mismatch|aud_mismatch|nonce_mismatch)/.test(code) ? 502 : /^(bad_request|pf_not_configured|not_interactive)$/.test(code) ? 400 : 500;
    const body = { error: String(code), message: status === 500 && !err?.code ? 'internal error' : message };
    if (err?.httpStatus) body.upstreamStatus = err.httpStatus;
    return res.status(status).json(body);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck(env));
  app.use(sameOriginWrites(lab));
  app.use(express.json({ limit: '200kb' }));
  app.use('/api/health', health.router);

  // noNetwork: the route only edits local state, so it stays available when Live is refused (an owner can always delete or lock down).
  const h = (fn, { noNetwork = false } = {}) => async (req, res) => {
    const conn = req.params.id ? store.get(req.params.id) : null;
    if (req.params.id && !conn) return res.status(404).json({ error: 'not_found', message: 'no such connection' });
    if (conn && !noNetwork && !isMock(conn) && liveGate) return refuseLive(res);
    try {
      if (conn && isMock(conn)) await ensureMock();
      await withPermits(conn, () => fn(req, res, conn));
    } catch (err) { fail(res, conn, err); }
  };

  // ---- mode: what the header toggle may do. Rule 19: the server-side Mock/Real mode. The page opens in the
  // owner's requested mode; POST /api/mode switches for this run. Real is only available when every Live guard passes.
  let runMode = modeFrom(env); // 'mock' | 'live'
  const modeView = () => ({
    source: runMode === 'live' ? 'real' : 'mock',
    realAvailable: !liveGate,
    realReason: liveGate ? `Live is refused: ${liveGate.failed.join(', ')}. ${liveGate.needs.join(' ')}` : null,
  });
  app.post('/api/mode', (req, res) => {
    const source = req.body?.source;
    if (source !== 'mock' && source !== 'real') return res.status(400).json({ error: 'bad_request', message: 'source must be exactly "mock" or "real"' });
    if (source === 'real' && liveGate) return res.status(409).json({ error: 'real_not_available', message: modeView().realReason });
    runMode = source === 'real' ? 'live' : 'mock';
    res.json(modeView());
  });
  app.get('/api/info', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ mode: runMode, ...modeView(), modes: [...MODES], key: MODE_KEY, requested: modeFrom(env), live: { available: !liveGate, failed: liveGate?.failed ?? [], needs: liveGate?.needs ?? [] } });
  });

  // Reset: run state goes back to the start (audit history, tokens, half-finished sign-ins, writes off, the mock's fake tenant). Saved
  // connections and their secrets are kept. The page also puts the diagram boxes back.
  app.post('/api/reset', (_req, res) => {
    audit.clear(); auth.resetAll(); const writesOff = store.resetWrites();
    if (mockStarted) theMock.reset();
    health.refresh();
    res.json({ ok: true, cleared: ['audit', 'tokens', 'pending sign-ins', 'mock tenant'], writesTurnedOff: writesOff, kept: ['connections'] });
  });

  // ---- diagrams: diagram-studio/1 data served by name from a fixed allow-list. An unknown name is a JSON 404 that does not echo the input.
  app.get('/api/diagrams', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ diagrams: diagrams.list() }); });
  app.get('/api/diagrams/:name', (req, res) => {
    const doc = diagrams.get(req.params.name);
    if (!doc) return res.status(404).json({ error: 'unknown_diagram', message: 'No such diagram.' });
    res.set('Cache-Control', 'no-store');
    return res.json(doc);
  });

  // ---- connections
  app.get('/api/connections', (_req, res) => res.json({ connections: store.list().map(view) }));
  setupRouter(app, { fetchImpl, env });
  app.post('/api/connections', (req, res) => {
    const wantsMock = req.body?.kind === 'pingone' && req.body?.offline === true;
    if (!wantsMock && liveGate) return refuseLive(res);
    try { const c = store.create(req.body || {}); health.refresh(); res.status(201).json(view(c)); }
    catch (err) { res.status(400).json({ error: 'bad_request', message: scrub(err.message, [req.body?.clientSecret, req.body?.token]) }); }
  });
  // One-click presets for local custom MCP servers. There is no PingOne preset: a PingOne connection needs a user sign-in (Setup makes one).
  const PRESETS = {
    banking: () => {
      const url = env.MFAADM_BANKING_URL || 'http://localhost:8081/mcp';
      // The family banking MCP (mcp-resource-server-LAB) is bearer-token only. With no JWKS source
      // configured it accepts a well-formed local test token (STRICT_AUTH=false default), so the
      // preset mints one itself: aud = its resource, scope = banking:read. A real deployment sets
      // MFAADM_BANKING_TOKEN and this minting path is skipped.
      const h = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const token = env.MFAADM_BANKING_TOKEN || `${h({ alg: 'none', typ: 'JWT' })}.${h({ iss: 'mfa-admin-mcp-lab-preset', aud: env.MFAADM_BANKING_AUD || 'mcp-invest.ping.demo', scope: 'banking:read', sub: 'lab-preset', exp: Math.floor(Date.now() / 1000) + 86400 })}.`;
      return { kind: 'custom', label: 'Banking MCP (local)', url, token, authHeader: 'Authorization' };
    },
    opensearch: () => ({ kind: 'custom', label: 'OpenSearch MCP (local)', url: env.MFAADM_OPENSEARCH_URL || 'http://localhost:9900/mcp' }),
  };
  app.post('/api/presets/:id', (req, res) => {
    const make = Object.hasOwn(PRESETS, req.params.id) ? PRESETS[req.params.id] : null;
    if (!make) return res.status(404).json({ error: 'unknown_preset', message: 'No such preset.' });
    if (liveGate) return refuseLive(res);
    const body = make();
    try { const c = store.create(body); health.refresh(); res.status(201).json(view(c)); }
    catch (err) { res.status(400).json({ error: 'bad_request', message: scrub(err.message, [body.token]) }); }
  });
  app.delete('/api/connections/:id', h((_req, res, conn) => { auth.logout(conn); store.remove(conn.id); health.refresh(); res.json({ ok: true }); }, { noNetwork: true }));
  app.post('/api/connections/:id/settings', h((req, res, conn) => res.json(view(store.update(conn.id, { allowWrites: req.body?.allowWrites, loginHint: req.body?.loginHint }))), { noNetwork: true }));

  // ---- tools, health card
  async function listAnnotated(conn) { return annotate(await clientFor(conn).listTools()); }
  app.get('/api/connections/:id/tools', h(async (_req, res, conn) => {
    const tools = scrubJson(await listAnnotated(conn), secretsFor(conn));
    const byClass = { read: 0, write: 0, destructive: 0 };
    const areas = {};
    for (const t of tools) { byClass[t.class]++; (areas[t.area] ||= []).push(t.name); }
    res.json({ count: tools.length, byClass, areas, tools });
  }));
  // Scan this server's tool metadata (rule table copied from mcp-tools). Reads tools/list only; never calls a tool, never blocks anything.
  app.post('/api/connections/:id/scan', h(async (_req, res, conn) => {
    const tools = await clientFor(conn).listTools();
    const { findings, truncated } = analyze({ tools });
    const summary = { info: 0, warn: 0, high: 0, total: findings.length };
    for (const f of findings) summary[f.severity]++;
    res.json(scrubJson({
      scanner: { source: 'mcp-tools rule table (copied)', enforcement: 'none' }, tools: tools.length, truncated, summary, findings,
      rules: Object.fromEntries(Object.entries(RULES).map(([id, r]) => [id, r.title])), limits: LIMITS,
      ...(conn.offline ? { fixture: 'illustrative sample, not a recording' } : {}),
    }, secretsFor(conn)));
  }));
  app.post('/api/connections/:id/test', h(async (_req, res, conn) => {
    try {
      const tools = await listAnnotated(conn);
      const out = { ok: true, toolCount: tools.length, byClass: { read: 0, write: 0, destructive: 0 } };
      for (const t of tools) out.byClass[t.class]++;
      // the tools themselves, for the result dialog: name and safety class only, sorted by name
      out.tools = scrubJson(tools.map((t) => ({ name: t.name, class: t.class, classSource: t.classSource })).sort((a, b) => String(a.name).localeCompare(String(b.name))), secretsFor(conn));
      if (conn.kind === 'pingone') {
        out.expectedNote = EXPECTED_NOTE;
        if (tools.length < 40) out.hint = HINT_SHORT;
      }
      if (conn.offline) out.fixture = 'illustrative sample, not a recording';
      res.json(out);
    } catch (err) {
      if (err?.code === 'login_required' || err?.code === 'worker_unsupported') throw err;
      const e = { ok: false, error: String(err?.code || 'error'), message: scrub(err?.message, secretsFor(conn)).slice(0, 300) };
      if (err?.httpStatus === 401 || err?.httpStatus === 403) e.hint = 'The server refused the credential. For PingOne: check the client, environment and region, and the admin roles of the signed-in user (UNVERIFIED: which of these is the cause on a live tenant).';
      res.json(e);
    }
  }));

  // ---- gated call (shared by /call and raw tools/call)
  async function gatedCall(conn, { tool, arguments: args, confirm, argsHash: hash, typedName }) {
    const secrets = secretsFor(conn);
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (typeof tool !== 'string' || !tool) return { status: 400, body: { error: 'bad_request', message: 'tool is required' } };
    let entry = (await listAnnotated(conn)).find((t) => t.name === tool);
    // A recorded fixture makes a tool from the recording server callable on the mock demo too: it
    // replays a read-only snapshot, so it is treated as a read (writes still go through the gate).
    if (!entry && conn?.offline && fixtures.get(tool)) entry = { name: tool, class: 'read', classSource: 'recorded fixture', description: `Replays a response recorded from a real server on ${String(fixtures.get(tool).recordedAt || '').slice(0, 10)}.`, inputSchema: { type: 'object', properties: {} } };
    if (!entry) { audit.record({ conn, tool, outcome: 'blocked:tool_not_listed', args: a }, secrets); return { status: 404, body: { error: 'tool_not_listed', message: 'this identity does not see that tool (the list is gated by role)' } }; }
    const verdict = decide({ cls: entry.class, allowWrites: conn.allowWrites, connId: conn.id, tool, args: a, confirm, hash, typedName });
    const warnings = validateArgs(entry.inputSchema, a);
    if (!verdict.ok) {
      audit.record({ conn, tool, cls: entry.class, outcome: `blocked:${verdict.error}`, args: a, hash: argsHash(conn.id, tool, a) }, secrets);
      const { ok, status, ...body } = verdict;
      return { status, body: scrubJson({ ...body, class: entry.class, warnings }, secrets) };
    }
    try {
      const result = await clientFor(conn).rpc('tools/call', { name: tool, arguments: a });
      audit.record({ conn, tool, cls: entry.class, outcome: 'ok', args: a, hash: argsHash(conn.id, tool, a) }, secrets);
      return { status: 200, body: { class: entry.class, warnings, result: scrubJson(result, secretsFor(conn)) } };
    } catch (err) {
      audit.record({ conn, tool, cls: entry.class, outcome: 'error', args: a, hash: argsHash(conn.id, tool, a), note: err?.code }, secrets);
      throw err;
    }
  }
  app.post('/api/connections/:id/call', h(async (req, res, conn) => { const r = await gatedCall(conn, req.body || {}); res.status(r.status).json(r.body); }));
  // Form suggestions: fill a tool argument from a read-only lookup tool instead of asking the
  // user to know values (index names, user ids). Strictly heuristic: the lookup tool must exist
  // in this connection's catalog, must class as read, and runs with the connection's own gate.
  const LOOKUP_BY_FIELD = [
    { test: /^index(name)?$/i, tools: ['ListIndexTool', 'list_indices', 'listIndexes', 'ListIndicesTool', 'list_index'], pick: (r) => deepCollect(r, ['index', 'name', 'id']) },
    { test: /^(user(id)?|userId)$/i, tools: ['listUsers', 'getUsers', 'list_users'], pick: (r) => deepCollect(r, ['username', 'id', 'userId', 'email']) },
    { test: /^environmentId$/i, tools: ['listEnvironments', 'getEnvironments'], pick: (r) => deepCollect(r, ['id', 'name']) },
  ];
  // Tool results wrap payloads in content blocks; JSON-in-text is the common shape, so parse it.
  const unwrap = (result) => {
    const blocks = result?.content;
    if (Array.isArray(blocks)) {
      const parsed = blocks.map((b) => { if (b?.type !== 'text' || typeof b.text !== 'string') return b; try { return JSON.parse(b.text); } catch { return b; } });
      return parsed.length === 1 ? parsed[0] : parsed;
    }
    return result;
  };
  function deepCollect(v, keys, out = [], depth = 0) {
    if (out.length >= 50 || depth > 8) return out;
    if (Array.isArray(v)) { for (const x of v) deepCollect(x, keys, out, depth + 1); return out; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (keys.includes(k) && (typeof x === 'string' || typeof x === 'number')) out.push(String(x));
        else deepCollect(x, keys, out, depth + 1);
      }
    }
    return out;
  }
  app.post('/api/connections/:id/suggest', h(async (req, res, conn) => {
    const field = String(req.body?.field || '');
    const spec = LOOKUP_BY_FIELD.find((l) => l.test.test(field));
    if (!spec) return res.status(400).json({ error: 'bad_request', message: `No suggestions available for "${field}".` });
    const tools = await listAnnotated(conn);
    const lookup = tools.find((t) => spec.tools.includes(t.name) && t.class === 'read');
    if (!lookup) return res.status(404).json({ error: 'no_lookup_tool', message: `This server has no read tool to list values for "${field}" (tried: ${spec.tools.join(', ')}).` });
    const args = /^(user(id)?|userId)$/i.test(field) ? (conn.kind === 'pingone' ? { environmentId: conn.envId, limit: 25 } : {}) : {};
    if (lookup.name === 'ListIndexTool' || /list.?ind/i.test(lookup.name)) { for (const k of Object.keys(lookup.inputSchema?.properties || {})) if (/^index(name)?$/i.test(k)) args[k] = ''; }
    const r = await gatedCall(conn, { tool: lookup.name, arguments: args });
    if (r.status !== 200) return res.status(r.status).json(r.body);
    const values = [...new Set(spec.pick(unwrap(r.body?.result)))].slice(0, 50);
    res.json({ ok: true, field, via: lookup.name, values });
  }));
  app.post('/api/connections/:id/rpc', h(async (req, res, conn) => {
    const { method, params } = req.body || {};
    if (method === 'tools/call') { const r = await gatedCall(conn, { ...(params || {}), tool: params?.name, confirm: req.body.confirm, argsHash: req.body.argsHash, typedName: req.body.typedName }); return res.status(r.status).json(r.body); }
    if (!RAW_FREE.has(method)) return res.status(403).json({ error: 'method_not_allowed', message: `raw console allows: ${[...RAW_FREE].join(', ')} and tools/call (through the gate)` });
    const result = await clientFor(conn).rpc(method, params && typeof params === 'object' ? params : {});
    res.json({ result: scrubJson(result, secretsFor(conn)) });
  }));

  // ---- interactive login: PingOne's native flow (response_mode=pi.flow), rule 16. No redirect and no callback: the page shows the
  // form for each step, this server drives the flow at the authorization server and keeps the tokens. The password and the one-time
  // code are passed on and never stored or logged; an error message that could carry one is scrubbed of it.
  const STEP_ACTIONS = new Set(['password', 'otp', 'device']);
  app.post('/api/connections/:id/login/start', h(async (req, res, conn) => {
    const r = await auth.startLogin(conn, { idp: req.body?.idp });
    res.json({ ok: true, ...r, ...(isMock(conn) ? { mockLogin: MOCK_LOGIN } : {}) });
  }));
  app.post('/api/connections/:id/login/step', h(async (req, res, conn) => {
    const b = req.body || {};
    const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
    const ok = STEP_ACTIONS.has(b.action) && str(b.loginId, 64)
      && (b.action !== 'password' || (str(b.username, 256) && str(b.password, 1024)))
      && (b.action !== 'otp' || /^[0-9A-Za-z]{4,12}$/.test(String(b.otp ?? '')))
      && (b.action !== 'device' || /^[A-Za-z0-9-]{6,64}$/.test(String(b.deviceId ?? '')));
    if (!ok) return res.status(400).json({ error: 'bad_request', message: 'The sign-in step is incomplete or malformed.' });
    res.json({ ok: true, ...(await auth.loginStep(conn, { loginId: b.loginId, action: b.action, username: b.username, password: b.password, otp: b.otp, deviceId: b.deviceId })) });
  }));
  app.post('/api/connections/:id/logout', h((_req, res, conn) => { auth.logout(conn); res.json({ ok: true }); }, { noNetwork: true }));

  app.get('/api/audit', (_req, res) => res.json({ entries: audit.recent() }));

  // ---- recorded fixtures: real tool responses captured from a Live server, replayed by the mock
  app.get('/api/fixtures', (_req, res) => res.json({ count: fixtures.count(), fixtures: fixtures.all() }));
  // One fixture by tool name: the UI shows it under a successful call ("Sample JSON-RPC response").
  // No fixture is a normal answer (most tools have none), so it is 200 + null, not a 404 the browser logs.
  app.get('/api/fixtures/:tool', h((req, res) => {
    res.json(fixtures.get(req.params.tool)); // null when none
  }, { noNetwork: true }));
  // Record takes the tool + result the UI just received. The connection is named in the body (this
  // route has no :id); it is only used for the label and the secret scrubbing, never for a call.
  app.post('/api/fixtures', h(async (req, res) => {
    const { tool, result, connectionId } = req.body || {};
    if (typeof tool !== 'string' || !tool) return res.status(400).json({ error: 'bad_request', message: 'tool is required' });
    if (!result || typeof result !== 'object') return res.status(400).json({ error: 'bad_request', message: 'result (the JSON-RPC result envelope) is required' });
    const conn = connectionId ? store.get(connectionId) : null;
    const secrets = secretsFor(conn || { label: '', url: '', clientSecret: '', token: '' }).concat([conn?.clientSecret, conn?.token].filter(Boolean));
    try {
      const saved = fixtures.record(tool, result, { source: `recorded from ${scrub(conn?.label || 'a live server', secrets)} (${conn?.kind || 'live'}), ${new Date().toISOString().slice(0, 10)}`, secrets });
      theMock.setFixtures?.(fixtures.all());
      if (conn) audit.record({ conn, tool, outcome: 'fixture_recorded' }, secrets);
      res.status(201).json({ ok: true, tool, recordedAt: saved.recordedAt, source: saved.source });
    } catch (err) { res.status(400).json({ error: 'bad_request', message: scrub(String(err.message || 'could not record'), secrets) }); }
  }));
  app.delete('/api/fixtures/:tool', h(async (req, res, conn) => {
    const gone = fixtures.remove(req.params.tool);
    theMock.setFixtures?.(fixtures.all());
    if (gone && conn) audit.record({ conn, tool: req.params.tool, outcome: 'fixture_deleted' }, secretsFor(conn));
    res.json({ ok: gone });
  }));
  // ---- recorded tool lists: a Live server's tools/list, so the mock demo lists those tools and answers
  // each with a labelled synthetic reply. Only metadata is recorded; no tool is called.
  app.get('/api/recorded-tools', (_req, res) => { const all = recordedTools.all(); res.json({ count: all.length, tools: all.map(({ name, source, recordedAt }) => ({ name, source, recordedAt })) }); });
  app.post('/api/connections/:id/record-tools', h(async (_req, res, conn) => {
    if (conn.offline) return res.status(400).json({ error: 'bad_request', message: 'record the tool list of a Live connection; the mock demo already knows its own tools' });
    const secrets = secretsFor(conn);
    const r = recordedTools.record(await clientFor(conn).listTools(), { source: `recorded from ${scrub(conn.label || 'a live server', secrets)} (${conn.kind}), ${new Date().toISOString().slice(0, 10)}`, secrets });
    feedRecordedTools();
    audit.record({ conn, tool: 'tools/list', outcome: 'tools_recorded' }, secrets);
    res.status(201).json({ ok: true, ...r });
  }));
  app.delete('/api/recorded-tools', (_req, res) => { const removed = recordedTools.clear(); feedRecordedTools(); res.json({ ok: true, removed }); });
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button


  if (fs.existsSync(webDist)) { app.use(express.static(webDist)); app.get('*', (req, res, next) => (req.path.startsWith('/api/') ? next() : res.sendFile('index.html', { root: webDist }))); }
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'request too large' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'bad_request', message: 'invalid JSON' });
    if (err instanceof URIError) return res.status(400).json({ error: 'bad_request', message: 'bad address' }); // a malformed %-escape in a path (Express reports it as a URIError)
    return res.status(500).json({ error: 'internal_error', message: 'internal error' });
  });

  // Recorded fixtures replay real responses inside the mock; load what is on disk now and keep the mock in step.
  theMock.setFixtures?.(fixtures.all());
  feedRecordedTools();

  app.locals.store = store; app.locals.auth = auth; app.locals.audit = audit; app.locals.mock = theMock; app.locals.fixtures = fixtures; app.locals.recordedTools = recordedTools;
  app.locals.close = async () => { health.stop(); if (!mock && mockStarted) await theMock.stop(); };
  return app;
}
