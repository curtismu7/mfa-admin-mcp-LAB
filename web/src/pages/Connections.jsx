import React, { useState } from "react";
import * as api from "../api.js";
import HealthCard from "../components/HealthCard.jsx";
import { DEMO_ENV_ID, redirectUriFor } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";

const REGIONS = ["com", "eu", "asia", "ca"];
const EMPTY = { kind: "pingone", label: "", region: "com", envId: "", auth: "worker", endpointStyle: "api", clientId: "", clientSecret: "", tokenAuthMethod: "basic", url: "", authHeader: "Authorization", token: "" };

function Field({ label, children, hint }) {
  return <label className="field">{label}{children}{hint && <small>{hint}</small>}</label>;
}

function Wizard({ onCreated, say }) {
  const [f, setF] = useState(EMPTY);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const uri = redirectUriFor();
  async function copy() {
    try { await navigator.clipboard.writeText(uri); say("Redirect URI copied."); } catch { say("Copy failed: select the redirect URI and copy it by hand."); }
  }
  async function submit(e) {
    e.preventDefault(); setErr("");
    const body = f.kind === "pingone"
      ? { kind: "pingone", label: f.label, region: f.region, envId: f.envId, auth: f.auth, endpointStyle: f.endpointStyle, clientId: f.clientId, ...(f.auth === "worker" ? { clientSecret: f.clientSecret, tokenAuthMethod: f.tokenAuthMethod } : { redirectUri: uri }) }
      : { kind: f.kind, label: f.label, url: f.url, ...(f.token ? { authHeader: f.authHeader, token: f.token } : {}) };
    const r = await api.post("/api/connections", body);
    if (!r.ok) { setErr(r.json?.message || "Could not save the connection."); return; }
    setF((x) => ({ ...EMPTY, kind: x.kind, region: x.region })); // the secret fields are cleared; the server keeps the only copy
    say(`Connection ${r.json.label} saved.`);
    onCreated(r.json);
  }
  return (
    <form className="card" onSubmit={submit} aria-labelledby="wiz-h">
      <h2 id="wiz-h">Add a connection</h2>
      <Field label="Type">
        <select value={f.kind} onChange={set("kind")}>
          <option value="pingone">PingOne hosted MCP (your tenant)</option>
          <option value="custom">Custom MCP server (HTTP)</option>
          <option value="raw">Raw (a custom server, driven from the raw console)</option>
        </select>
      </Field>
      <Field label="Name (optional)"><input value={f.label} onChange={set("label")} maxLength={80} /></Field>
      {f.kind === "pingone" ? (
        <>
          <div className="grid2">
            <Field label="Region" hint="com, eu, asia and ca are from the pingone-mcp skill. Other regions are UNVERIFIED.">
              <select value={f.region} onChange={set("region")}>{REGIONS.map((r) => <option key={r}>{r}</option>)}</select>
            </Field>
            <Field label="Environment id" hint="Your own PingOne environment (a UUID). Not a secret, never stored in this app's code.">
              <input value={f.envId} onChange={set("envId")} required spellCheck="false" autoComplete="off" />
            </Field>
          </div>
          <fieldset className="seg-fs"><legend>Authentication</legend>
            <p className="hint" data-testid="worker-unverified">UNVERIFIED: sources disagree on whether the hosted PingOne MCP server accepts a worker (client_credentials) token. One source reports a 401 audience mismatch, the pingone-mcp skill says it is supported. If it is rejected, use interactive sign-in. See docs/live-checks.md item 2.</p>
            <label><input type="radio" name="auth" checked={f.auth === "worker"} onChange={() => setF({ ...f, auth: "worker" })} /> Worker application (client_credentials, no human)</label>
            <label><input type="radio" name="auth" checked={f.auth === "interactive"} onChange={() => setF({ ...f, auth: "interactive" })} /> Interactive admin sign-in (authorization code + PKCE)</label>
          </fieldset>
          <Field label="Client id"><input value={f.clientId} onChange={set("clientId")} required spellCheck="false" autoComplete="off" /></Field>
          {f.auth === "worker" ? (
            <div className="grid2">
              <Field label="Client secret" hint="Write-only: kept on this machine's server, never shown again.">
                <input type="password" value={f.clientSecret} onChange={set("clientSecret")} required autoComplete="new-password" />
              </Field>
              <Field label="Token endpoint auth">
                <select value={f.tokenAuthMethod} onChange={set("tokenAuthMethod")}><option value="basic">Basic (client_secret_basic)</option><option value="post">Form post (client_secret_post)</option></select>
              </Field>
            </div>
          ) : (
            <div className="redirect" data-testid="redirect-box">
              <p><strong>Register this exact redirect URI</strong> on your OAuth application in PingOne:</p>
              <p className="row"><code data-testid="redirect-uri">{uri}</code> <button type="button" onClick={copy}>Copy</button></p>
              <p className="hint">Signing in sends your browser to PingOne's authorization server. That is this tool's connection to a third-party server, not a sign-in to this app (it has no accounts). UNVERIFIED: the scopes and consent PingOne shows, and whether it accepts an http://localhost redirect (see docs/live-checks.md).</p>
            </div>
          )}
          <Field label="MCP endpoint shape" hint="Two shapes appear in our sources and we have not verified which one your tenant answers on.">
            <select value={f.endpointStyle} onChange={set("endpointStyle")}><option value="api">api.pingone.{"{region}"}/v1/environments/{"{envId}"}/mcp (skill)</option><option value="mcp-host">mcp.pingone.{"{region}"}/admin/{"{envId}"}/mcp (AI-DEMO2)</option></select>
          </Field>
        </>
      ) : (
        <>
          <Field label="Server URL"><input value={f.url} onChange={set("url")} required placeholder="https://example.invalid/mcp" spellCheck="false" /></Field>
          <div className="grid2">
            <Field label="Header name"><input value={f.authHeader} onChange={set("authHeader")} /></Field>
            <Field label="Header value (optional)" hint="Write-only, e.g. Bearer abc. Never shown again."><input type="password" value={f.token} onChange={set("token")} autoComplete="new-password" /></Field>
          </div>
        </>
      )}
      {err && <p className="err-text" role="alert">{err}</p>}
      <button type="submit" className="primary">Save connection</button>
    </form>
  );
}

function ConnCard({ c, active, onSelect, onChange, onTest, say }) {
  const st = c.auth_status || {};
  async function act(fn, msg) { const r = await fn(); if (!r.ok) say(r.json?.message || "That did not work."); else if (msg) say(msg); onChange(); return r; }
  async function signIn() {
    const r = await api.post(`/api/connections/${c.id}/login/start`);
    if (!r.ok) { say(r.json?.message || "Could not start sign-in."); return; }
    say("Sending your browser to PingOne's authorization server…");
    window.location.assign(r.json.authorizeUrl);
  }
  const setWrites = (on) => act(() => api.post(`/api/connections/${c.id}/settings`, { allowWrites: on }), on ? `Writes enabled for ${c.label}.` : `Writes turned off for ${c.label}.`);
  const role = c.clientId === "admin-demo" ? "admin" : c.clientId === "viewer-demo" ? "viewer" : null;
  return (
    <li className="card" data-state={active ? "active" : undefined} data-testid="conn-card">
      <div className="row between">
        <h3><Untrusted text={c.label} /></h3>
        <span className="chip">{c.kind === "pingone" ? (c.offline ? "mock demo" : `PingOne ${c.auth}`) : c.kind}</span>
      </div>
      <p className="meta">
        {c.kind === "pingone" ? <>Region {c.region}, environment <code>{c.envId}</code>, client <code>{c.clientId}</code>, secret: {c.auth === "worker" ? (c.clientSecret || "not set") : "none (public client)"}</> : <>URL <code>{c.url}</code>, credential: {c.token || "not set"}</>}
      </p>
      <div className="row wrap">
        <button type="button" aria-pressed={active} onClick={() => onSelect(c.id)}>{active ? "In use" : "Use this connection"}</button>
        <button type="button" onClick={() => onTest(c.id)}>Test connection</button>
        {c.kind === "pingone" && c.auth === "interactive" && (st.signedIn
          ? <button type="button" onClick={() => act(() => api.post(`/api/connections/${c.id}/logout`), "Signed out; tokens cleared.")}>Sign out ({st.as})</button>
          : <button type="button" onClick={signIn}>Sign in</button>)}
        {role && c.auth === "worker" && (
          <span className="seg" role="group" aria-label="Demo role">
            {["viewer", "admin"].map((r) => <button key={r} type="button" aria-pressed={role === r} onClick={() => act(() => api.post(`/api/connections/${c.id}/role`, { role: r }), `Demo role is now ${r}. Test the connection again.`).then(() => onTest(c.id))}>{r}</button>)}
          </span>
        )}
        <button type="button" onClick={() => { if (window.confirm(`Delete the connection "${c.label}"?`)) act(() => api.del(`/api/connections/${c.id}`), "Connection deleted."); }}>Delete</button>
      </div>
      <label className={`writes${c.allowWrites ? " writes--on" : ""}`}>
        <input type="checkbox" checked={c.allowWrites} onChange={(e) => setWrites(e.target.checked)} />
        Allow writes for this connection {c.allowWrites ? "(ON: write and destructive calls can run after confirmation)" : "(off: read tools only)"}
      </label>
    </li>
  );
}

export default function Connections({ mode, conns, activeId, onSelect, reload, tests, testBusy, runTest, now, say }) {
  const active = conns.find((c) => c.id === activeId);
  async function demo(kind) {
    const body = { kind: "pingone", offline: true, label: kind === "worker" ? "Mock demo (viewer/admin switch)" : "Mock demo (interactive sign-in)", region: "com", envId: DEMO_ENV_ID, endpointStyle: "api", auth: kind,
      clientId: kind === "worker" ? "viewer-demo" : "admin-demo", ...(kind === "worker" ? { clientSecret: "demo-secret" } : { redirectUri: redirectUriFor() }) };
    const r = await api.post("/api/connections", body);
    if (!r.ok) { say(r.json?.message || "Could not add the demo."); return; }
    say("Mock demo added."); await reload(); onSelect(r.json.id); if (kind === "worker") runTest(r.json.id);
  }
  async function preset(id, name) {
    const r = await api.post(`/api/presets/${id}`);
    if (!r.ok) { say(r.json?.message || `Could not add ${name}.`); return; }
    say(`${name} added.`); await reload(); onSelect(r.json.id); runTest(r.json.id);
  }
  return (
    <>
      <h1>Connections</h1>
      <p className="lede">A connection says which MCP server to talk to and how to authenticate. Secrets are write-only: after saving they show as <q>set</q>. Writes are off for every new connection. The header toggle decides which connections are shown: Mock shows the mock demo, Live shows real servers.</p>
      {mode === "mock" && (
        <section className="card" aria-labelledby="demo-h">
          <h2 id="demo-h">Try the mock</h2>
          <p>The mock demo talks to an in-process mock of PingOne's hosted MCP server and authorization server on this machine. The tool catalog is an illustrative sample, not a recording, and its write tools change only an in-memory fake tenant.</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => demo("worker")}>Add mock demo (worker, viewer/admin switch)</button>
            <button type="button" onClick={() => demo("interactive")}>Add mock demo with sign-in (interactive)</button>
          </div>
          <p className="hint">To connect a real PingOne tenant or MCP server, press Live in the header. Live is an owner opt-in and is refused until it is set up (see the README, Mock and live modes).</p>
        </section>
      )}
      {mode === "live" && (
        <section className="card" aria-labelledby="presets-h">
          <h2 id="presets-h">Working demos</h2>
          <p>One click each. Banking and OpenSearch are local MCP servers on this machine (they must be running). The PingOne worker reads its credentials from a local file outside this repo; the secret is never shown. You can still add your own connections below.</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => preset("banking", "Banking MCP")}>Add banking MCP</button>
            <button type="button" className="primary" onClick={() => preset("opensearch", "OpenSearch MCP")}>Add OpenSearch MCP</button>
            <button type="button" className="primary" onClick={() => preset("pingone", "PingOne standalone worker")}>Add PingOne worker</button>
          </div>
        </section>
      )}
      {conns.length > 0 && <ul className="plain">{conns.map((c) => <ConnCard key={c.id} c={c} active={c.id === activeId} onSelect={onSelect} onChange={reload} onTest={runTest} say={say} />)}</ul>}
      {active && <HealthCard conn={active} test={tests[active.id]} busy={testBusy === active.id} now={now} />}
      {mode === "live" && <Wizard onCreated={async (c) => { await reload(); onSelect(c.id); }} say={say} />}
    </>
  );
}
