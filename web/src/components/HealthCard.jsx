import React from "react";
import { countdown } from "../lib/format.js";

// Health card for the active connection. Shows the tool count with a plain-language role hint, who is signed in
// (the subject only) and the token's remaining time. No token value is ever in the data this receives.
export default function HealthCard({ conn, test, busy, now }) {
  if (!conn) return null;
  const st = conn.auth_status || {};
  const exp = st.expiresAt;
  const identity = conn.kind !== "pingone" ? (conn.token === "set" ? "custom header set" : "no credential")
    : conn.auth === "interactive" ? (st.signedIn ? `signed in as ${st.as}` : "not signed in")
      : st.token === "set" ? "worker token set" : "no token yet";
  return (
    <section className="card" aria-labelledby="health-h" data-testid="health-card">
      <h2 id="health-h">Health: {conn.label}</h2>
      {busy && <p>Checking the connection…</p>}
      {!busy && !test && <p>Not tested yet. Press Test connection.</p>}
      {!busy && test && test.ok && (
        <dl className="kv">
          <dt>Tools</dt>
          <dd><strong data-testid="tool-count">{test.toolCount}</strong> ({test.byClass.read} read, {test.byClass.write} write, {test.byClass.destructive} destructive)</dd>
          {test.hint && (<><dt>Role hint</dt><dd className="warn-text">{test.hint}</dd></>)}
          {test.expectedNote && (<><dt>Expected</dt><dd>{test.expectedNote}</dd></>)}
          {test.fixture && (<><dt>Catalog</dt><dd>{test.fixture}</dd></>)}
        </dl>
      )}
      {!busy && test && !test.ok && <p className="err-text" role="alert">{test.error}: {test.message}{test.hint ? ` ${test.hint}` : ""}</p>}
      <dl className="kv">
        <dt>Identity</dt><dd data-testid="identity">{identity}</dd>
        {exp && (<><dt>Token expires in</dt><dd data-testid="expiry">{countdown(exp, now)}</dd></>)}
      </dl>
    </section>
  );
}
