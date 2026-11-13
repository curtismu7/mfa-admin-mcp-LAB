import React, { useState } from "react";
import * as api from "../api.js";

// Set up hosted PingOne MCP: paste a Management worker client id + secret once;
// the lab checks the environment, finds or creates the sign-in application,
// registers this lab's callback on it, and saves the connection. The worker
// secret is sent to this lab's server only, used for one token mint, and never
// stored.
export default function Setup({ onCreated, say }) {
  const [f, setF] = useState({ region: "com", envId: "", workerClientId: "", workerClientSecret: "" });
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function checkEnv(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    const r = await api.post("/api/setup/check", { region: f.region, envId: f.envId });
    setBusy(false);
    if (!r.ok) { setErr(r.json?.message || "The check failed."); setCheck(null); return; }
    if (!r.json.ok) { setErr(r.json.message); setCheck(null); return; }
    setCheck(r.json);
    say(`Environment "${r.json.environment}" found.`);
  }

  async function apply(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    const r = await api.post("/api/setup/apply", f);
    setBusy(false);
    if (!r.ok) { setErr(r.json?.message || "Setup failed."); return; }
    say(`Sign-in application "${r.json.appName}" ${r.json.created ? "created" : "reused"}; the callback is registered.`);
    const c = await api.post("/api/connections", r.json.connection);
    if (!c.ok) { setErr(c.json?.message || "The application is set up, but saving the connection failed."); return; }
    setF((x) => ({ ...x, workerClientSecret: "" })); // the secret is never stored anywhere
    onCreated(c.json);
  }

  return (
    <form className="card" onSubmit={check ? apply : checkEnv} aria-labelledby="setup-h" data-testid="setup">
      <h2 id="setup-h">Set up hosted PingOne MCP (automatic)</h2>
      <p>The lab configures your tenant for you: it finds or creates a sign-in application (authorization code + PKCE), registers this lab's callback on it, and saves the connection. All you add afterwards is your admin sign-in.</p>
      <p className="hint">You need a <strong>Management worker application</strong> (client_credentials) whose identity can read and update applications — e.g. an Environment Admin role. Its client id and secret are pasted once, used for one token mint, and never stored; only this lab's server sees them.</p>
      <div className="grid2">
        <label className="field">Region
          <select value={f.region} onChange={set("region")}>{["com", "eu", "asia", "ca"].map((r) => <option key={r}>{r}</option>)}</select>
        </label>
        <label className="field">Environment id
          <input value={f.envId} onChange={set("envId")} required spellCheck="false" autoComplete="off" data-testid="setup-env" />
        </label>
      </div>
      {check && (
        <div className="redirect" data-testid="setup-plan">
          <p>Environment <strong>{check.environment}</strong> found. Setup will register this callback:</p>
          <p className="row"><code>{check.callback}</code></p>
          <label className="field">Worker client id
            <input value={f.workerClientId} onChange={set("workerClientId")} required spellCheck="false" autoComplete="off" />
          </label>
          <label className="field">Worker client secret
            <input type="password" value={f.workerClientSecret} onChange={set("workerClientSecret")} required autoComplete="new-password" />
          </label>
          <p className="hint">Used once to mint a Management token, then discarded (write-only, never stored).</p>
        </div>
      )}
      {err && <p className="err-text" role="alert">{err}</p>}
      <button type="submit" className="primary" disabled={busy} data-testid="setup-go">{busy ? "Working…" : check ? "Create sign-in app and save connection" : "Check the environment"}</button>
    </form>
  );
}
