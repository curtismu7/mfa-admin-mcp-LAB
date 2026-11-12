import React from "react";
import { pretty, redactForDisplay } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";

// The exact JSON-RPC request this app sends and the response it got back (redacted: sensitive-looking argument names
// are masked here, and the server has already scrubbed its own secrets from the reply). All text, never HTML.
export default function CallView({ response }) {
  if (!response) return null;
  const j = response.json || {};
  const blocked = !response.ok;
  const title = response.ok ? "Result" : j.error === "writes_disabled" ? "Blocked: writes are off" : `Refused or failed (${response.status || "no reply"})`;
  return (
    <section className="card" aria-live="polite" data-testid="call-view">
      <h3>{title}</h3>
      {blocked && <p className="err-text" role="alert">{j.error}: <Untrusted text={j.message} /></p>}
      {Array.isArray(j.warnings) && j.warnings.length > 0 && <ul className="warns">{j.warnings.map((w) => <li key={`${w.kind}${w.param}`}><Untrusted text={w.message} /></li>)}</ul>}
      <div className="cols">
        <div><h4>Request (as sent to the MCP server; id assigned by this app)</h4><Untrusted block text={pretty(redactForDisplay(response.request))} /></div>
        <div><h4>Response (untrusted server text, shown inert)</h4><Untrusted block text={pretty(redactForDisplay(response.ok ? { jsonrpc: "2.0", result: j.result } : j))} /></div>
      </div>
    </section>
  );
}
