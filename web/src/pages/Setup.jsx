import React, { useEffect, useState } from "react";
import * as api from "../api.js";

// Set up hosted PingOne MCP: paste a Management worker client id + secret once;
// the lab checks the environment, uses the environment's "PingOne MCP Server" application
// when it is a public sign-in app (unchanged), or else finds or creates its own public native
// sign-in application (pi.flow), and saves the connection. The worker secret is sent to
// this lab's server only, used for one Management API token mint, and never stored.
// The worker never calls the MCP server: the saved connection is an admin user's sign-in.
export default function Setup({ onCreated, say, defaults }) {
  const [f, setF] = useState({ region: defaults.region || "com", envId: defaults.envId || "", workerClientId: "", workerClientSecret: "" });
  // The default environment arrives after the first render; fill it unless the user has already typed one.
  useEffect(() => { setF((x) => (x.envId || !defaults.envId ? x : { ...x, envId: defaults.envId, region: defaults.region || x.region })); }, [defaults]);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [err, setErr] = useState("");
  const [workerEnv, setWorkerEnv] = useState(null); // true = the lab found its worker.env; no pasting needed
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function checkEnv(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    const r = await api.post("/api/setup/check", { region: f.region, envId: f.envId });
    setBusy(false);
    if (!r.ok) { setErr(r.json?.message || "The check failed."); setCheck(null); return; }
    if (!r.json.ok) { setErr(r.json.message); setCheck(null); return; }
    setCheck(r.json);
    setWorkerEnv(r.json.workerEnv === true);
    say(r.json.workerEnv ? `Environment found; the lab's worker.env will be used for setup.` : `Environment "${r.json.environment}" found.`);
  }

  async function apply(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    const r = await api.post("/api/setup/apply", f);
    setBusy(false);
    if (!r.ok) { setErr(r.json?.message || "Setup failed."); return; }
    say(r.json.source === "mcp-server-app"
      ? `Using the environment's "${r.json.appName}" application as it is, with its redirect URI ${r.json.redirectUri}.`
      : `Sign-in application "${r.json.appName}" ${r.json.created ? "created" : "reused"}${r.json.why ? ` (${r.json.why})` : ""}.`);
    const c = await api.post("/api/connections", r.json.connection);
    if (!c.ok) { setErr(c.json?.message || "The application is set up, but saving the connection failed."); return; }
    setF((x) => ({ ...x, workerClientSecret: "" })); // the secret is never stored anywhere
    onCreated(c.json);
  }

  return (
    <form className="card" onSubmit={check ? apply : checkEnv} aria-labelledby="setup-h" data-testid="setup">
      <h2 id="setup-h">Set up hosted PingOne MCP (automatic)</h2>
      <p>The lab configures your tenant for you: it signs in through the environment's <strong>PingOne MCP Server</strong> application when that is a public sign-in app, and changes nothing on it. Otherwise it finds or creates its own public native sign-in application. Either way the sign-in is PingOne's native flow (pi.flow, authorization code + PKCE, no client secret). Then it saves the connection. All you add afterwards is your admin sign-in: username, password and the code PingOne sends you.</p>
      <p className="hint" data-testid="setup-worker-scope">Setup uses a <strong>Management worker application</strong> (client_credentials) whose identity can read and update applications — e.g. an Environment Admin role. It calls the PingOne <strong>Management API only</strong>, to create the sign-in application; it is never used to call the MCP server, which takes your admin sign-in. If the lab's <code>~/.config/mfa-admin-mcp/worker.env</code> exists (PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET), it is used automatically and nothing is pasted. Otherwise paste the client id and secret below: used for one token mint, never stored; only this lab's server sees them.</p>
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
          <p>Environment found. Setup will use the <strong>PingOne MCP Server</strong> application as it is, with one of its own loopback redirect URIs. If that application is missing, disabled, not public or has no loopback redirect URI, it finds or creates the public native application <strong>MFA Admin MCP LAB sign-in</strong> with this placeholder redirect URI (PingOne requires one; nothing is served at it):</p>
          <p className="row"><code data-testid="setup-redirect">{check.redirectUri}</code></p>
          {workerEnv && <p className="hint" data-testid="setup-workerenv">Using the worker credentials from <code>~/.config/mfa-admin-mcp/worker.env</code> — nothing to paste.</p>}
          <label className="field">Worker client id
            <input value={f.workerClientId} onChange={set("workerClientId")} required spellCheck="false" autoComplete="off" />
          </label>
          <label className="field">Worker client secret
            <input type="password" value={f.workerClientSecret} onChange={set("workerClientSecret")} required autoComplete="new-password" />
          </label>
          <p className="hint">Used once to mint a Management API token, then discarded (write-only, never stored). Not sent to the MCP server.</p>
        </div>
      )}
      {err && <p className="err-text" role="alert">{err}</p>}
      <button type="submit" className="primary" disabled={busy} data-testid="setup-go">{busy ? "Working…" : check ? (workerEnv ? "Configure my tenant and save the connection" : "Create sign-in app and save connection") : "Check the environment"}</button>
    </form>
  );
}
