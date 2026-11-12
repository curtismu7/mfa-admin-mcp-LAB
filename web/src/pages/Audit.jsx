import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { pretty } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";

export default function Audit() {
  const [entries, setEntries] = useState(null);
  const load = useCallback(async () => { const r = await api.get("/api/audit"); setEntries(r.ok ? [...r.json.entries].reverse() : []); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h1>Audit</h1>
      <p className="lede">Every call this app was asked to make, allowed or blocked, newest first. Argument values that look like secrets are redacted; tokens and client secrets are never written here. The file is local (mode 600).</p>
      <button type="button" onClick={load}>Refresh</button>
      {entries && entries.length === 0 && <p>No calls yet.</p>}
      {entries && entries.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>Time</th><th>Connection</th><th>Tool</th><th>Class</th><th>Outcome</th><th>Args hash</th><th>Arguments (redacted)</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}${i}`} data-testid="audit-row">
                  <td>{e.at}</td><td><Untrusted text={e.connection} /></td><td><Untrusted text={e.tool} /></td><td>{e.class || "-"}</td>
                  <td><span className={`badge ${e.outcome === "ok" ? "badge--read" : "badge--write"}`}>{e.outcome}</span></td>
                  <td><code>{(e.argsHash || "").slice(0, 12)}</code></td><td><Untrusted block text={pretty(e.args)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
