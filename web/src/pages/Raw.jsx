import React, { useRef, useState } from "react";
import * as api from "../api.js";
import CallView from "../components/CallView.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import { useGatedCall } from "../components/useGatedCall.js";

const FREE = ["initialize", "ping", "tools/list", "resources/list", "resources/read", "resources/templates/list", "prompts/list", "prompts/get"];
const listNote = (m) => `${m} takes no required params, so {} is the right value. To fetch the next page, send { "cursor": "<nextCursor>" } with the nextCursor from the previous answer (there is none when everything fit on one page).`;
// A sample for each method that needs nothing from the server. resources/read, prompts/get and tools/call are filled from the server's own lists.
const SAMPLES = {
  initialize: { params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mfa-admin-mcp", version: "0.2.0" } }, note: "The handshake this app already sends before its first call: the MCP version it speaks, its capabilities (none) and its name." },
  ping: { params: {}, note: "ping takes no params: {} is the whole request. The server answers with an empty result." },
  "tools/list": { params: {}, note: listNote("tools/list") },
  "resources/list": { params: {}, note: listNote("resources/list") },
  "resources/templates/list": { params: {}, note: listNote("resources/templates/list") },
  "prompts/list": { params: {}, note: listNote("prompts/list") },
};
const show = (p) => JSON.stringify(p, null, 2);

export default function Raw({ conn }) {
  const [method, setMethod] = useState("tools/list");
  const [params, setParams] = useState("{}");
  const [err, setErr] = useState("");
  const [fillNote, setFillNote] = useState(SAMPLES["tools/list"].note);
  const want = useRef("tools/list"); // the method picked last: a fill that answers after the method changed again is dropped
  const [rec, setRec] = useState({ busy: false, note: "" });
  const g = useGatedCall();
  if (!conn) return <><h1>Raw JSON-RPC</h1><p>Select a connection first.</p></>;
  const gated = method === "tools/call";
  const fill = (m, p, note) => { if (want.current !== m) return; setParams(show(p)); setFillNote(note); };
  async function listed(method, key) {
    const r = await api.post(`/api/connections/${conn.id}/rpc`, { method, params: {} });
    return r.ok && Array.isArray(r.json?.result?.[key]) ? r.json.result[key] : null;
  }
  async function fillResource() {
    const list = await listed("resources/list", "resources");
    const first = list?.[0];
    fill("resources/read", { uri: first ? first.uri : "file:///example.txt" }, first
      ? `Filled with "${first.uri}", the first resource the server listed (${list.length} resources).`
      : `${list ? "The server lists no resources" : "Could not list the server's resources"}, so this is the shape only: { "uri": "<a uri from resources/list>" }. Sending this example gets a refusal from the server.`);
  }
  async function fillPrompt() {
    const list = await listed("prompts/list", "prompts");
    const first = list?.[0];
    const args = Object.fromEntries((first?.arguments || []).filter((a) => a.required).map((a) => [a.name, ""]));
    fill("prompts/get", { name: first ? first.name : "example-prompt", arguments: args }, first
      ? `Filled with "${first.name}", the first prompt the server listed (${list.length} prompts).${Object.keys(args).length ? " Fill in its required arguments." : ""}`
      : `${list ? "The server lists no prompts" : "Could not list the server's prompts"}, so this is the shape only: { "name": "<a name from prompts/list>", "arguments": { ... } }. Sending this example gets a refusal from the server.`);
  }
  async function fillFromTools() {
    const r = await api.get(`/api/connections/${conn.id}/tools`);
    const first = r.ok && Array.isArray(r.json.tools) ? r.json.tools[0] : null;
    const p = first
      ? { name: first.name, arguments: first.inputSchema?.properties?.environmentId && conn.envId ? { environmentId: conn.envId } : {} }
      : { name: "getMfaSettings", arguments: { environmentId: conn.envId || "11111111-2222-4333-8444-555555555555" } };
    fill("tools/call", p, first ? `Filled with "${first.name}", the first tool the server returned (${r.json.tools.length} tools).` : "No tools returned — filled with a mock example.");
  }
  function onMethod(v) {
    setMethod(v);
    want.current = v;
    setFillNote("");
    if (SAMPLES[v]) { setParams(show(SAMPLES[v].params)); setFillNote(SAMPLES[v].note); }
    else if (v === "tools/call") fillFromTools();
    else if (v === "resources/read") fillResource();
    else if (v === "prompts/get") fillPrompt();
  }
  function send() {
    let p; try { p = params.trim() ? JSON.parse(params) : {}; if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("params must be a JSON object"); } catch (e) { setErr(`params: ${e.message}`); return; }
    setErr("");
    g.run((extra) => api.post(`/api/connections/${conn.id}/rpc`, { method, params: p, ...extra }), { jsonrpc: "2.0", method, params: p });
  }
  return (
    <>
      <h1>Raw JSON-RPC</h1>
      <p className="lede">Send any of these methods as they are: {FREE.join(", ")}. <code>tools/call</code> is allowed too but goes through the same safety gate as the Tools page. Any other method is refused. The id is assigned by this app.</p>
      <section className="card">
        <label className="field">Method<input list="rpc-methods" value={method} onChange={(e) => onMethod(e.target.value)} spellCheck="false" /></label>
        <datalist id="rpc-methods">{[...FREE, "tools/call"].map((m) => <option key={m} value={m} />)}</datalist>
        <label className="field">Params (JSON object){gated && <small>For tools/call: {"{ \"name\": \"<tool>\", \"arguments\": { ... } }"}</small>}<textarea rows={6} value={params} onChange={(e) => setParams(e.target.value)} spellCheck="false" /></label>
        {fillNote && <p className="meta" role="status" data-testid="raw-note">{fillNote}</p>}
        {err && <p className="err-text" role="alert">{err}</p>}
        <button type="button" className="primary" onClick={send} disabled={g.busy}>{g.busy ? "Sending…" : "Send"}</button>
      </section>
      <CallView response={g.response} sample={{ tool: (() => { try { return gated ? JSON.parse(params)?.name : undefined; } catch { return undefined; } })() }} record={{
        can: gated && conn && !conn.offline,
        busy: rec.busy,
        note: rec.note,
        onRecord: async (j) => {
          setRec({ busy: true, note: "" });
          const name = (() => { try { return JSON.parse(params)?.name; } catch { return null; } })();
          const r = await api.post("/api/fixtures", { tool: name, result: j.result, connectionId: conn.id });
          setRec({ busy: false, note: r.ok ? `Recorded: the mock demo now replays this real response for ${name}.` : r.json?.message || "Could not record." });
          if (!r.ok) throw new Error(r.json?.message || "Could not record.");
        },
      }} />
      {g.gate && <ConfirmDialog tool={g.gate.request.params?.name} gate={g.gate} busy={g.busy} onConfirm={g.confirm} onCancel={g.cancel} />}
    </>
  );
}
