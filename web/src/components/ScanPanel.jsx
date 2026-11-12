import React, { useState } from "react";
import * as api from "../api.js";
import { Untrusted } from "../lib/Untrusted.jsx";

// "Scan this server's tools": reads tools/list and runs the metadata rules (copied from mcp-tools). Never calls a tool,
// never blocks anything. Findings quote server text, so every string is rendered as inert text.
export default function ScanPanel({ conn }) {
  const [state, setState] = useState({ busy: false, res: null, err: "" });
  async function run() {
    setState({ busy: true, res: null, err: "" });
    const r = await api.post(`/api/connections/${conn.id}/scan`);
    setState(r.ok ? { busy: false, res: r.json, err: "" } : { busy: false, res: null, err: `${r.json?.error || "error"}: ${r.json?.message || ""}` });
  }
  const { res } = state;
  return (
    <section className="card" aria-labelledby="scan-h" data-testid="scan-panel">
      <h2 id="scan-h">Scan this server's tools</h2>
      <p className="meta">Checks tool names, descriptions and argument defaults for poisoned metadata (hidden instructions, off-box defaults, credential harvesting, look-alike names, invisible characters). It reads the tool list only and reports; it blocks nothing.</p>
      <button type="button" onClick={run} disabled={state.busy}>{state.busy ? "Scanning…" : "Scan this server's tools"}</button>
      {state.err && <p className="err-text" role="alert">{state.err}</p>}
      {res && (
        <div role="status" data-testid="scan-result">
          <p><strong data-testid="scan-summary">{res.summary.total === 0 ? "No findings" : `${res.summary.total} finding${res.summary.total === 1 ? "" : "s"}`}</strong> in {res.tools} tool{res.tools === 1 ? "" : "s"} ({res.summary.high} high, {res.summary.warn} warn, {res.summary.info} info).{res.fixture ? ` Catalog: ${res.fixture}.` : ""}</p>
          {res.truncated && <p className="warn-text">The scan was truncated by a size budget; the rest was not scanned.</p>}
          <ul className="plain" data-testid="scan-findings">
            {res.findings.map((f, i) => (
              <li key={i} className="card"><span className={`badge badge--${f.severity === "high" ? "destructive" : f.severity === "warn" ? "write" : "read"}`}>{f.severity}</span> <code>{f.ruleId}</code> <Untrusted text={f.subject} />{f.arg !== undefined && <> arg <Untrusted text={f.arg} /></>}: <Untrusted text={f.detail} /></li>
            ))}
          </ul>
          <details><summary>What a scan does not catch</summary><ul>{res.limits.map((l) => <li key={l.id}>{l.text}</li>)}</ul></details>
        </div>
      )}
    </section>
  );
}
