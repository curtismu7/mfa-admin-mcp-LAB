import React, { useState } from "react";
import * as api from "../api.js";
import CallView from "../components/CallView.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import { useGatedCall } from "../components/useGatedCall.js";

const FREE = ["initialize", "ping", "tools/list", "resources/list", "resources/read", "resources/templates/list", "prompts/list", "prompts/get"];

// Mock params used when the server's tool list is empty or unreachable — works in mock and live mode.
const MOCK_PARAMS = { name: "getMfaSettings", arguments: { environmentId: "11111111-2222-4333-8444-555555555555" } };

export default function Raw({ conn }) {
  const [method, setMethod] = useState("tools/list");
  const [params, setParams] = useState("{}");
  const [err, setErr] = useState("");
  const [fillNote, setFillNote] = useState("");
  const g = useGatedCall();
  if (!conn) return <><h1>Raw JSON-RPC</h1><p>Select a connection first.</p></>;
  const gated = method === "tools/call";
  async function fillFromTools() {
    setFillNote("");
    const r = await api.get(`/api/connections/${conn.id}/tools`);
    const first = r.ok && Array.isArray(r.json.tools) ? r.json.tools[0] : null;
    const p = first
      ? { name: first.name, arguments: {} }
      : MOCK_PARAMS;
    setFillNote(first ? `Filled with "${first.name}", the first tool the server returned (${r.json.tools.length} tools).` : "No tools returned — filled with a mock example.");
    setParams(JSON.stringify(p, null, 2));
  }
  function onMethod(v) {
    setMethod(v);
    setFillNote("");
    if (v === "tools/call") fillFromTools();
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
        {fillNote && <p className="meta" role="status">{fillNote}</p>}
        {err && <p className="err-text" role="alert">{err}</p>}
        <button type="button" className="primary" onClick={send} disabled={g.busy}>{g.busy ? "Sending…" : "Send"}</button>
      </section>
      <CallView response={g.response} />
      {g.gate && <ConfirmDialog tool={g.gate.request.params?.name} gate={g.gate} busy={g.busy} onConfirm={g.confirm} onCancel={g.cancel} />}
    </>
  );
}
