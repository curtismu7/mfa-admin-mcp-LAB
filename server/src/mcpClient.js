// Stateless MCP JSON-RPC over HTTP. Adapted from mcp-tools server/src/mcp/http.js and AI-DEMO2
// services/mcpPingOneHttpAdapter.js (_send, _extractJsonRpc), both same author. Differences: stateless (no initialize
// handshake; the hosted PingOne server needs none per the pingone-mcp skill), a 401 retry after a token refresh,
// redirects refused, size and time capped, JSON or SSE replies parsed defensively.
const PROTOCOL_VERSION = '2025-06-18';
export const MAX_BYTES = 4 * 1024 * 1024;

export function rpcError(message, code, extra = {}) { return Object.assign(new Error(String(message).slice(0, 300)), { code, ...extra }); }

export function sseMessages(text) {
  const out = [];
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* not JSON */ }
  }
  return out;
}

async function readBody(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const dec = new TextDecoder();
  let text = ''; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw rpcError(`reply larger than ${MAX_BYTES} bytes`, 'mcp_reply_too_large');
      text += dec.decode(value, { stream: true });
    }
  } catch (err) {
    // A timeout that fires mid-body (slow-drip SSE) surfaces as a raw DOMException; map it like the header-phase one.
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw rpcError('MCP HTTP reply timed out while reading the body', 'mcp_timeout');
    throw err;
  } finally { reader.cancel().catch(() => {}); }
  return text.trim();
}

function parseReply(text, sse, id) {
  if (!text) return undefined;
  if (sse || !text.startsWith('{')) {
    const msgs = sseMessages(text);
    if (msgs.length) return msgs.find((m) => m && m.id === id) ?? msgs.at(-1);
    if (sse) throw rpcError('reply has no parseable event', 'mcp_bad_reply');
  }
  try { return JSON.parse(text); } catch { throw rpcError('reply is neither JSON nor an SSE frame', 'mcp_bad_reply'); }
}

// getAuth(): Promise<[headerName, value] | null>. refreshAuth(): Promise<boolean> (true = a new token is ready, retry once).
// handshake: true = do the MCP initialize + notifications/initialized once, then send mcp-protocol-version and
// mcp-session-id on every call (spec-compliant servers reject a bare tools/list with 400). Off for the stateless hosted PingOne server.
export function createMcpClient({ url, getAuth, refreshAuth, timeoutMs = 20_000, fetchImpl = fetch, handshake = false }) {
  let msgId = 0;
  let session = null; // { protocolVersion, sessionId } once the handshake ran
  async function post(body, retried) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session && body.method !== 'initialize') {
      headers['mcp-protocol-version'] = session.protocolVersion;
      if (session.sessionId) headers['mcp-session-id'] = session.sessionId;
    }
    const auth = await getAuth?.();
    if (auth) headers[auth[0]] = auth[1];
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body) });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw rpcError(`MCP HTTP request timed out after ${timeoutMs}ms`, 'mcp_timeout');
      throw rpcError(`MCP HTTP request unreachable (${err?.cause?.code || err?.code || 'network error'})`, 'mcp_unreachable');
    }
    if (res.status >= 300 && res.status < 400) { res.body?.cancel().catch(() => {}); throw rpcError(`MCP HTTP ${res.status}: redirects are not followed`, 'mcp_http_error', { httpStatus: res.status }); }
    if (res.status === 401 && !retried && refreshAuth && await refreshAuth().catch(() => false)) { res.body?.cancel().catch(() => {}); return post(body, true); }
    if (!res.ok) {
      const t = (await readBody(res).catch(() => '')).slice(0, 300);
      throw rpcError(`MCP HTTP ${res.status}${t ? `: ${t}` : ''}`, 'mcp_http_error', { httpStatus: res.status });
    }
    if (body.method === 'initialize') session = { protocolVersion: PROTOCOL_VERSION, sessionId: res.headers.get('mcp-session-id') || null };
    const text = await readBody(res);
    const reply = parseReply(text, /text\/event-stream/i.test(res.headers.get('content-type') || ''), body.id);
    if (body.method === 'initialize' && reply?.result?.protocolVersion) session.protocolVersion = reply.result.protocolVersion;
    return reply;
  }
  async function ensureSession() {
    if (!handshake || session) return;
    const init = await post({ jsonrpc: '2.0', id: ++msgId, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pingone-mcp-inspector', version: '0.2.0' } } }, false);
    if (init?.error) { session = null; throw rpcError(init.error.message || 'MCP initialize failed', 'mcp_rpc_error', { mcpCode: init.error.code }); }
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false).catch(() => {});
  }
  async function rpc(method, params = {}) {
    await ensureSession();
    const id = ++msgId;
    const json = await post({ jsonrpc: '2.0', id, method, params }, false);
    if (json?.error) throw rpcError(json.error.message || 'MCP JSON-RPC error', 'mcp_rpc_error', { mcpCode: json.error.code });
    return json?.result;
  }
  return { rpc, listTools: async () => { const r = await rpc('tools/list', {}); return Array.isArray(r?.tools) ? r.tools : []; } };
}
