import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAuth } from './auth.js';
import { annotate } from './classify.js';
import { analyze, LIMITS, RULES } from './scanner/index.js';
import { MODES, MODE_KEY, dataDir as cfgDataDir, liveRefusal, modeFrom, webDist } from './config.js';
import { createDiagrams, DIAGRAM_DIR } from './diagrams.js';
import { createAudit, decide, argsHash } from './gate.js';
import { createHealth } from './health.js';
import { createMcpClient } from './mcpClient.js';
import { createMock } from './mock.js';
import { permit } from './netguard.js';
import { scrub, scrubJson } from './redact.js';
import { hostCheck, isLoopbackHost, labAllowedHosts, sameOriginWrites } from './security.js';
import { createStore } from './store.js';
import { validateArgs } from './validate.js';
import { liveHosts, mcpUrl } from './urls.js';
import { shelfInfo } from './shelfLink.js';

const RAW_FREE = new Set(['initialize', 'ping', 'tools/list', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get']);
const CALLBACK_PATHS = new Set(['/api/oauth/callback', '/callback']);
const isMock = (c) => c.kind === 'pingone' && c.offline === true;
const HINT_SHORT = 'A short list usually means missing admin roles, not a broken server (from the pingone-mcp skill; this tool has not verified it against a live tenant).';

export function createApp({ env = process.env, lab = labAllowedHosts(env), store, mock, fetchImpl = fetch, now = Date.now, diagramsDir = DIAGRAM_DIR } = {}) {
  const diagrams = createDiagrams({ dir: diagramsDir }); // diagram-studio/1 data, validated now: an invalid file stops the app from starting
  const dir = cfgDataDir(env);
  store ||= createStore({ dir });
  const audit = createAudit({ dir });
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

  function clientFor(conn) {
    if (conn.kind === 'pingone') {
      return createMcpClient({
        url: mcpUrl({ ...conn, offlineBase: offlineBase(conn) }), fetchImpl,
        getAuth: async () => ['Authorization', `Bearer ${await auth.accessToken(conn)}`],
        refreshAuth: () => auth.renew(conn),
      });
    }
    return createMcpClient({ url: conn.url, fetchImpl, handshake: true, getAuth: async () => (conn.token ? [conn.authHeader || 'Authorization', conn.token] : null) });
  }

  function fail(res, conn, err) {
    const secrets = conn ? secretsFor(conn) : auth.allSecrets();
    const message = scrub(err?.message || 'error', secrets).slice(0, 300);
    const code = err?.code || 'internal_error';
    const status = code === 'login_required' ? 401 : code === 'mcp_timeout' ? 504 : /^(mcp_|token_|jwks_)/.test(code) ? 502 : code === 'bad_request' ? 400 : 500;
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
  app.post('/api/connections', (req, res) => {
    const wantsMock = req.body?.kind === 'pingone' && req.body?.offline === true;
    if (!wantsMock && liveGate) return refuseLive(res);
    try { const c = store.create(req.body || {}); health.refresh(); res.status(201).json(view(c)); }
    catch (err) { res.status(400).json({ error: 'bad_request', message: scrub(err.message, [req.body?.clientSecret, req.body?.token]) }); }
  });
  // One-click presets. 'pingone' reads the worker from a LOCAL file outside the repo (P1MCP_WORKER_ENV_FILE), never from the repo.
  const PRESETS = {
    banking: () => ({ kind: 'custom', label: 'Banking MCP (local)', url: env.P1MCP_BANKING_URL || 'http://localhost:9901/mcp' }),
    opensearch: () => ({ kind: 'custom', label: 'OpenSearch MCP (local)', url: env.P1MCP_OPENSEARCH_URL || 'http://localhost:9900/mcp' }),
    pingone: () => {
      const file = env.P1MCP_WORKER_ENV_FILE || path.join(os.homedir(), '.config', 'pingone-mcp-inspector', 'worker.env');
      let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { const e = new Error(`Create ${file} with PINGONE_ENV_ID, PINGONE_REGION, PINGONE_CLIENT_ID and PINGONE_CLIENT_SECRET (see .env.example), then try again.`); e.needsSetup = true; throw e; }
      const v = Object.fromEntries(txt.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
      // The environment id and region may come from the shared settings file (PINGONE_ENVIRONMENT_ID, PINGONE_REGION); the worker's client id and secret never do.
      const envId = v.PINGONE_ENV_ID || env.PINGONE_ENVIRONMENT_ID;
      if (!envId || !v.PINGONE_CLIENT_ID || !v.PINGONE_CLIENT_SECRET) { const e = new Error(`${file} must set PINGONE_CLIENT_ID and PINGONE_CLIENT_SECRET (and PINGONE_ENV_ID unless PINGONE_ENVIRONMENT_ID is in the shared settings file).`); e.needsSetup = true; throw e; }
      return { kind: 'pingone', label: 'PingOne standalone worker', region: v.PINGONE_REGION || env.PINGONE_REGION || 'com', envId, auth: 'worker', endpointStyle: v.PINGONE_ENDPOINT_STYLE || 'mcp-host', clientId: v.PINGONE_CLIENT_ID, clientSecret: v.PINGONE_CLIENT_SECRET };
    },
  };
  app.post('/api/presets/:id', (req, res) => {
    const make = Object.hasOwn(PRESETS, req.params.id) ? PRESETS[req.params.id] : null;
    if (!make) return res.status(404).json({ error: 'unknown_preset', message: 'No such preset.' });
    if (liveGate) return refuseLive(res);
    let body; try { body = make(); } catch (err) { return res.status(err.needsSetup ? 409 : 500).json({ error: 'needs_setup', message: err.message }); }
    try { const c = store.create(body); health.refresh(); res.status(201).json(view(c)); }
    catch (err) { res.status(400).json({ error: 'bad_request', message: scrub(err.message, [body.clientSecret]) }); }
  });
  app.delete('/api/connections/:id', h((_req, res, conn) => { auth.logout(conn); store.remove(conn.id); health.refresh(); res.json({ ok: true }); }, { noNetwork: true }));
  app.post('/api/connections/:id/settings', h((req, res, conn) => res.json(view(store.update(conn.id, { allowWrites: req.body?.allowWrites }))), { noNetwork: true }));

  app.post('/api/connections/:id/role', h((req, res, conn) => {
    if (!conn.offline || conn.auth !== 'worker' || !['viewer', 'admin'].includes(req.body?.role)) return res.status(400).json({ error: 'bad_request', message: 'the role switch exists only on an offline worker demo connection (role: viewer or admin)' });
    auth.logout(conn);
    res.json(view(store.update(conn.id, { clientId: `${req.body.role}-demo` })));
  }));

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
      if (conn.kind === 'pingone') {
        out.expectedNote = 'A fully privileged Worker app is said to see about 60-70 tools (pingone-mcp skill; UNVERIFIED by this tool).';
        if (tools.length < 40) out.hint = HINT_SHORT;
      }
      if (conn.offline) out.fixture = 'illustrative sample, not a recording';
      res.json(out);
    } catch (err) {
      if (err?.code === 'login_required') throw err;
      const e = { ok: false, error: String(err?.code || 'error'), message: scrub(err?.message, secretsFor(conn)).slice(0, 300) };
      if (err?.httpStatus === 401 || err?.httpStatus === 403) e.hint = 'The server refused the credential. For PingOne: check the client, environment and region, and the admin roles on the identity (UNVERIFIED: which of these is the cause on a live tenant).';
      res.json(e);
    }
  }));

  // ---- gated call (shared by /call and raw tools/call)
  async function gatedCall(conn, { tool, arguments: args, confirm, argsHash: hash, typedName }) {
    const secrets = secretsFor(conn);
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (typeof tool !== 'string' || !tool) return { status: 400, body: { error: 'bad_request', message: 'tool is required' } };
    const entry = (await listAnnotated(conn)).find((t) => t.name === tool);
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
  app.post('/api/connections/:id/rpc', h(async (req, res, conn) => {
    const { method, params } = req.body || {};
    if (method === 'tools/call') { const r = await gatedCall(conn, { ...(params || {}), tool: params?.name, confirm: req.body.confirm, argsHash: req.body.argsHash, typedName: req.body.typedName }); return res.status(r.status).json(r.body); }
    if (!RAW_FREE.has(method)) return res.status(403).json({ error: 'method_not_allowed', message: `raw console allows: ${[...RAW_FREE].join(', ')} and tools/call (through the gate)` });
    const result = await clientFor(conn).rpc(method, params && typeof params === 'object' ? params : {});
    res.json({ result: scrubJson(result, secretsFor(conn)) });
  }));

  // ---- interactive login
  app.post('/api/connections/:id/login/start', h((req, res, conn) => {
    let u; try { u = new URL(conn.redirectUri); } catch { u = null; }
    const hostPort = String(req.headers.host || '').split(':').pop();
    if (!u || u.protocol !== 'http:' || !isLoopbackHost(u.hostname) || !CALLBACK_PATHS.has(u.pathname) || u.port !== hostPort || u.search || u.hash) {
      return res.status(400).json({ error: 'redirect_uri_invalid', message: `redirectUri must be http://localhost:${hostPort}/api/oauth/callback (or /callback), exactly as registered on your OAuth application.` });
    }
    res.json({ authorizeUrl: auth.startLogin(conn).authorizeUrl });
  }));
  const callback = async (req, res) => {
    const at = `http://${req.headers.host}${req.path}`;
    let location;
    try {
      const pendingConn = store.get(auth.pendingConnId(String(req.query.state ?? '')));
      if (pendingConn && !isMock(pendingConn) && liveGate) throw Object.assign(new Error('live is refused'), { code: 'live_refused' });
      if (pendingConn && isMock(pendingConn)) await ensureMock();
      const r = await withPermits(pendingConn, () => auth.completeLogin({ q: req.query, at, getConn: (id) => store.get(id) })); location = `/?login=ok&connection=${encodeURIComponent(r.connId)}`; }
    catch (err) { location = `/?login=error&reason=${encodeURIComponent(String(err.code || 'error'))}`; }
    res.redirect(302, location);
  };
  for (const p of CALLBACK_PATHS) app.get(p, callback);
  app.post('/api/connections/:id/logout', h((_req, res, conn) => { auth.logout(conn); res.json({ ok: true }); }, { noNetwork: true }));

  app.get('/api/audit', (_req, res) => res.json({ entries: audit.recent() }));
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

  app.locals.store = store; app.locals.auth = auth; app.locals.audit = audit; app.locals.mock = theMock;
  app.locals.close = async () => { health.stop(); if (!mock && mockStarted) await theMock.stop(); };
  return app;
}
