import React, { useEffect, useState } from "react";
import * as api from "../api.js";
import HealthCard from "../components/HealthCard.jsx";
import LoginDialog from "../components/LoginDialog.jsx";
import Setup from "./Setup.jsx";
import { DEMO_ENV_ID } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";

const REGIONS = ["com", "eu", "asia", "ca"];
const EMPTY = { kind: "pingone", label: "", region: "com", envId: "", endpointStyle: "mcp-host", idp: "pingone", idpBaseUrl: "", loginHint: "", clientId: "", url: "", authHeader: "Authorization", token: "" };

function Field({ label, children, hint }) {
  return <label className="field">{label}{children}{hint && <small>{hint}</small>}</label>;
}

function Wizard({ onCreated, say, defaults }) {
  const withDefaults = (x) => ({ ...x, envId: defaults.envId || "", ...(defaults.region ? { region: defaults.region } : {}) });
  const [f, setF] = useState(() => withDefaults(EMPTY));
  useEffect(() => { setF((x) => (x.envId || !defaults.envId ? x : withDefaults(x))); }, [defaults]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const uri = defaults.piFlowRedirectUri || "";
  async function copy() {
    try { await navigator.clipboard.writeText(uri); say("Redirect URI copied."); } catch { say("Copy failed: select the redirect URI and copy it by hand."); }
  }
  async function submit(e) {
    e.preventDefault(); setErr("");
    const body = f.kind === "pingone"
      ? { kind: "pingone", label: f.label, region: f.region, envId: f.envId, endpointStyle: f.endpointStyle, idp: f.idp, ...(f.idp === "pf" ? { idpBaseUrl: f.idpBaseUrl } : {}), clientId: f.clientId, ...(f.loginHint ? { loginHint: f.loginHint } : {}), redirectUri: uri }
      : { kind: f.kind, label: f.label, url: f.url, ...(f.token ? { authHeader: f.authHeader, token: f.token } : {}) };
    const r = await api.post("/api/connections", body);
    if (!r.ok) { setErr(r.json?.message || "Could not save the connection."); return; }
    setF((x) => ({ ...withDefaults(EMPTY), kind: x.kind, region: x.region })); // the secret fields are cleared; the server keeps the only copy
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
          <fieldset className="seg-fs"><legend>Authorization server</legend>
            <p className="hint" data-testid="idp-hint">
              Who signs the tokens this connection uses. <strong>PingOne</strong> (the default): PingOne's hosted authorization server issues the access and id tokens.
              <strong> PingFederate</strong>: an OAuth application on your own PingFederate instance runs the interactive sign-in (native flow, authorization code + PKCE) instead; the MCP endpoint stays the PingOne one unless you also change it.
            </p>
            <label><input type="radio" name="idp" checked={f.idp === "pingone"} onChange={() => setF({ ...f, idp: "pingone" })} /> PingOne authorization server (default)</label>
            <label><input type="radio" name="idp" checked={f.idp === "pf"} onChange={() => setF({ ...f, idp: "pf" })} /> PingFederate (your own instance, interactive sign-in)</label>
            {f.idp === "pf" && (
              <Field label="PingFederate base URL" hint="Required, e.g. https://pingfederate.example.com — /as/token.oauth2, /as/authorization.oauth2 and /pf/JWKS are derived from it.">
                <input value={f.idpBaseUrl} onChange={set("idpBaseUrl")} required placeholder="https://pingfederate.example.com" spellCheck="false" autoComplete="off" />
              </Field>
            )}
          </fieldset>
          <p className="hint" data-testid="auth-note">Authentication: <strong>your own admin sign-in</strong> (PingOne's native flow, authorization code + PKCE). The hosted PingOne MCP server takes a user sign-in, not a worker application's token; the tools you see follow your admin roles (Ping's MCP docs).</p>
          <Field label="Client id"><input value={f.clientId} onChange={set("clientId")} required spellCheck="false" autoComplete="off" /></Field>
          <div className="redirect" data-testid="redirect-box">
            <p><strong>Use a public native application.</strong> Easiest: use <strong>Set up hosted PingOne MCP</strong> above. It uses the environment's <strong>PingOne MCP Server</strong> application when that is public, or else creates one. By hand: an OpenID Connect application with authorization code + PKCE, token endpoint authentication <strong>None</strong>, and a redirect URI it registers, for example this one (PingOne requires one; nothing is served at it):</p>
            <p className="row"><code data-testid="redirect-uri">{uri}</code> <button type="button" onClick={copy}>Copy</button></p>
            <p className="hint">Signing in is PingOne's native flow (pi.flow): this app shows the sign-in form itself and sends nothing to a callback. An application that needs a client secret cannot be used here. UNVERIFIED: the scopes PingOne grants, and whether the hosted MCP server accepts a token from this lab's own sign-in application (docs/live-checks.md).</p>
          </div>
          <Field label="Sign-in username (login_hint, optional)" hint="Sent to the authorization server and pre-filled in the sign-in dialog. You can still type another. PingFederate binds the sign-in to it.">
            <input value={f.loginHint} onChange={set("loginHint")} maxLength={256} spellCheck="false" autoComplete="off" data-testid="wiz-login-hint" />
          </Field>
          <Field label="MCP endpoint shape" hint="Ping's MCP docs name the mcp.pingone shape (the default). The api.pingone shape comes from the pingone-mcp skill and is UNVERIFIED.">
            <select value={f.endpointStyle} onChange={set("endpointStyle")}><option value="mcp-host">mcp.pingone.{"{region}"}/admin/{"{envId}"}/mcp (documented by Ping, default)</option><option value="api">api.pingone.{"{region}"}/v1/environments/{"{envId}"}/mcp (pingone-mcp skill, UNVERIFIED)</option></select>
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

// One local MCP server from the Working demos card: running and not yet connected (Connect), already connected (Use), or not running (how to start it).
function PresetRow({ p, conns, activeId, onConnect, onSelect, say }) {
  const existing = conns.find((c) => c.kind === "custom" && c.url === p.url);
  const where = p.url.replace(/^https?:\/\//, "");
  async function copy() {
    try { await navigator.clipboard.writeText(p.command); say("Start command copied."); } catch { say("Copy failed: select the command and copy it by hand."); }
  }
  if (p.running === undefined || p.running === null) return <div className="row" data-testid={`preset-${p.id}`}><button type="button" className="primary" disabled>Checking {p.name}…</button></div>;
  if (!p.running) {
    return (
      <div data-testid={`preset-${p.id}`}>
        <p><strong>{p.name} is not running</strong> at <code>{where}</code>. Start it from your <code>{p.folder}</code> folder, then press Check again:</p>
        <p className="row"><code data-testid={`preset-${p.id}-cmd`}>{p.command}</code> <button type="button" onClick={copy}>Copy command</button></p>
      </div>
    );
  }
  const inUse = existing && existing.id === activeId;
  return (
    <div className="row" data-testid={`preset-${p.id}`}>
      {!existing && <button type="button" className="primary" onClick={() => onConnect(p.id, p.name)}>Connect to {p.name}</button>}
      {existing && <button type="button" className="primary" disabled={inUse} aria-pressed={inUse} onClick={() => onSelect(existing.id)}>{inUse ? `${p.name} in use` : `Use ${p.name} (connected)`}</button>}
      <small className="hint">running at <code>{where}</code></small>
    </div>
  );
}

// Seen live 2026-11-16: the hosted PingOne MCP server answered 401 to a PingFederate-issued token (explicit deny at its gateway).
const PF_MCP_NOTE = "PingOne's hosted MCP server accepts only a PingOne sign-in. PF login signs you in, but the server refuses its tool calls (HTTP 401). Use P1 login for tools.";
const PF_NEEDS = "PF login needs a PingFederate base URL: add it under PingFederate on this card and press Save PingFederate.";

function ConnCard({ c, active, onSelect, onChange, onTest, say }) {
  const st = c.auth_status || {};
  async function act(fn, msg) { const r = await fn(); if (!r.ok) say(r.json?.message || "That did not work."); else if (msg) say(msg); onChange(); return r; }
  const [loginErr, setLoginErr] = useState("");
  const [login, setLogin] = useState(null); // { idp, start } while the sign-in dialog is open
  async function signIn(idp) {
    setLoginErr("");
    const r = await api.post(`/api/connections/${c.id}/login/start`, { idp });
    if (!r.ok) { const m = r.json?.message || "Could not start sign-in."; say(m); setLoginErr(m); return; } // say() is a visually-hidden live region: show the reason beside the buttons too
    setLogin({ idp, start: r.json });
  }
  const [hint, setHint] = useState(c.loginHint || "");
  const saveHint = (e) => { e.preventDefault(); act(() => api.post(`/api/connections/${c.id}/settings`, { loginHint: hint }), hint.trim() ? `Sign-in username hint saved for ${c.label}.` : `Sign-in username hint cleared for ${c.label}.`); };
  const setWrites = (on) => act(() => api.post(`/api/connections/${c.id}/settings`, { allowWrites: on }), on ? `Writes enabled for ${c.label}.` : `Writes turned off for ${c.label}.`);
  const pfReady = c.offline === true || Boolean(c.idpBaseUrl); // the mock simulates PingFederate; a live connection needs its own PingFederate base URL
  const [pf, setPf] = useState({ base: c.idpBaseUrl || "", client: c.pfClientId || "" });
  const pfChanged = pf.base.trim() !== (c.idpBaseUrl || "") || pf.client.trim() !== (c.pfClientId || "");
  const savePf = (e) => { e.preventDefault(); act(() => api.post(`/api/connections/${c.id}/settings`, { idpBaseUrl: pf.base, pfClientId: pf.client }), pf.base.trim() ? `PingFederate saved for ${c.label}: PF login is available.` : `PingFederate removed from ${c.label}.`); };
  return (
    <li className="card" data-state={active ? "active" : undefined} data-testid="conn-card">
      <div className="row between">
        <h3><Untrusted text={c.label} /></h3>
        <span className="chip">{c.kind === "pingone" ? (c.offline ? "mock demo" : "PingOne sign-in") : c.kind}</span>
      </div>
      <p className="meta">
        {c.kind === "pingone" ? <>Region {c.region}, environment <code>{c.envId}</code>, client <code>{c.clientId}</code>, secret: none (public client){c.idpBaseUrl && !c.offline && <>; PingFederate <code>{c.idpBaseUrl}</code>{c.pfClientId && <>, PF client <code>{c.pfClientId}</code></>}</>}</> : <>URL <code>{c.url}</code>, credential: {c.token || "not set"}</>}
      </p>
      <div className="row wrap">
        <button type="button" aria-pressed={active} onClick={() => onSelect(c.id)}>{active ? "In use" : "Use this connection"}</button>
        <button type="button" data-testid="test-conn" onClick={() => onTest(c.id)}>Test connection</button>
        {c.kind === "pingone" && c.auth === "interactive" && (st.signedIn
          ? <button type="button" onClick={() => act(() => api.post(`/api/connections/${c.id}/logout`), "Signed out; tokens cleared.")}>Sign out ({st.as})</button>
          : <span className="row">
              <button type="button" onClick={() => signIn("pingone")} title="Interactive sign-in at PingOne (native flow, authorization code + PKCE)">P1 login</button>
              <button type="button" data-testid="pf-login" disabled={!pfReady} onClick={() => signIn("pf")}
                title={pfReady ? "Interactive sign-in at PingFederate (native flow, authorization code + PKCE)" : PF_NEEDS}>PF login</button>
              {!pfReady && <small className="hint" data-testid="pf-hint">{PF_NEEDS}</small>}
            </span>)}
        <button type="button" onClick={() => { if (window.confirm(`Delete the connection "${c.label}"?`)) act(() => api.del(`/api/connections/${c.id}`), "Connection deleted."); }}>Delete</button>
      </div>
      {c.kind === "pingone" && c.auth === "interactive" && !c.offline && c.idpBaseUrl && <p className="hint" data-testid="pf-mcp-note">{PF_MCP_NOTE}</p>}
      {c.legacyWorker && <p className="notice" data-state="bad" data-testid="legacy-worker">Saved by an older build for a worker (client_credentials) token, which the hosted PingOne MCP server does not take: it needs a user sign-in. Delete this connection and add a PingOne one (Setup creates the sign-in application).</p>}
      {c.kind === "pingone" && c.auth === "interactive" && !st.signedIn && (
        <form className="row wrap" onSubmit={saveHint} aria-label="Sign-in username hint">
          <label className="field">Sign-in username (login_hint, optional)
            <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={256} spellCheck="false" autoComplete="off" data-testid="card-login-hint" />
          </label>
          <button type="submit" data-testid="card-login-hint-save" disabled={hint.trim() === (c.loginHint || "")}>Save hint</button>
        </form>
      )}
      {c.kind === "pingone" && c.auth === "interactive" && !c.offline && !st.signedIn && (
        <form className="row wrap" onSubmit={savePf} aria-label="PingFederate">
          <label className="field">PingFederate base URL (for PF login, optional)
            <input value={pf.base} onChange={(e) => setPf({ ...pf, base: e.target.value })} maxLength={300} placeholder="https://pingfederate.example.com" spellCheck="false" autoComplete="off" data-testid="card-pf-base" />
          </label>
          <label className="field">PingFederate client id (optional)
            <input value={pf.client} onChange={(e) => setPf({ ...pf, client: e.target.value })} maxLength={120} placeholder={c.clientId} spellCheck="false" autoComplete="off" data-testid="card-pf-client" />
          </label>
          <button type="submit" data-testid="card-pf-save" disabled={!pfChanged}>Save PingFederate</button>
          <small className="hint">The OAuth client on that PingFederate must be public (no secret), allow authorization code + PKCE and redirectless (pi.flow) sign-in. Empty client id: this connection's client id is used.</small>
        </form>
      )}
      {loginErr && <p className="err-text" role="alert" data-testid="login-err">{loginErr}</p>}
      {login && <LoginDialog conn={c} idp={login.idp} start={login.start} onClose={() => setLogin(null)}
        onDone={(as) => { setLogin(null); onSelect(c.id); say(`Signed in${as ? ` as ${as}` : ""}; ${c.label} is now the connection in use.`); onChange(); onTest(c.id, { modal: false }); }} />}
      <label className={`writes${c.allowWrites ? " writes--on" : ""}`}>
        <input type="checkbox" checked={c.allowWrites} onChange={(e) => setWrites(e.target.checked)} />
        Allow writes for this connection {c.allowWrites ? "(ON: write and destructive calls can run after confirmation)" : "(off: read tools only)"}
      </label>
    </li>
  );
}

export default function Connections({ defaults, mode, conns, activeId, onSelect, reload, tests, testBusy, runTest, now, say }) {
  const active = conns.find((c) => c.id === activeId);
  // In Live, ask the server which local demo servers answer. In Mock the page asks nothing (the server would not probe anyway).
  const [presets, setPresets] = useState(null);
  const checkPresets = async () => { setPresets(null); const r = await api.get("/api/presets"); setPresets(r.ok ? r.json.presets : []); };
  useEffect(() => { if (mode === "live") checkPresets(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The mock demo is a user sign-in like a real PingOne connection: the tools it lists follow the mock account that signs in.
  async function demo() {
    const body = { kind: "pingone", offline: true, label: "Mock demo (sign in as mock.admin or mock.viewer)", region: "com", envId: DEMO_ENV_ID, endpointStyle: "mcp-host", auth: "interactive", clientId: "mock-native-app" };
    const r = await api.post("/api/connections", body);
    if (!r.ok) { say(r.json?.message || "Could not add the demo."); return; }
    say("Mock demo added. Press P1 login and sign in as mock.admin (every tool) or mock.viewer (read tools only)."); await reload(); onSelect(r.json.id);
  }
  async function preset(id, name) {
    const r = await api.post(`/api/presets/${id}`);
    if (!r.ok) { say(r.json?.message || `Could not add ${name}.`); return; }
    say(`${name} added.`); await reload(); onSelect(r.json.id); runTest(r.json.id, { modal: false });
  }
  return (
    <>
      <h1>Connections</h1>
      <p className="lede">A connection says which MCP server to talk to and how to authenticate. Secrets are write-only: after saving they show as <q>set</q>. Writes are off for every new connection. The header toggle decides which connections are shown: Mock shows the mock demo, Live shows real servers.</p>
      {mode === "mock" && (
        <section className="card" aria-labelledby="demo-h">
          <h2 id="demo-h">Try the mock</h2>
          <p>The mock demo talks to an in-process mock of PingOne's hosted MCP server and authorization server on this machine. The tool catalog is an illustrative sample, not a recording, and its write tools change only an in-memory fake tenant.</p>
          <p data-testid="demo-accounts">You sign in to it the way an administrator signs in to the real one, and the tools you see follow the account's roles: <code>mock.admin</code> sees every tool, <code>mock.viewer</code> only the read tools.</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={demo}>Add mock demo (sign in)</button>
          </div>
          <p className="hint">To connect a real PingOne tenant or MCP server, press Live in the header and add a connection (see the README, Mock and live modes).</p>
        </section>
      )}
      {mode === "live" && (
        <section className="card" aria-labelledby="presets-h">
          <h2 id="presets-h">Working demos</h2>
          <p>Banking and OpenSearch are local MCP servers on this machine. The lab checks whether each one is running: connect with one click, or copy the command that starts it (the lab runs in its own container and cannot start them itself). For your PingOne tenant use Setup below: it creates the sign-in application, and you sign in as yourself. You can still add your own connections below.</p>
          {presets === null
            ? <p className="hint" role="status">Checking which demo servers are running…</p>
            : presets.map((p) => <PresetRow key={p.id} p={p} conns={conns} activeId={activeId} onConnect={preset} onSelect={onSelect} say={say} />)}
          <button type="button" onClick={checkPresets} disabled={presets === null}>Check again</button>
        </section>
      )}
      {conns.length > 0 && <ul className="plain">{conns.map((c) => <ConnCard key={c.id} c={c} active={c.id === activeId} onSelect={onSelect} onChange={reload} onTest={runTest} say={say} />)}</ul>}
      {active && <HealthCard conn={active} test={tests[active.id]} busy={testBusy === active.id} now={now} />}
      {mode === "live" && <Setup defaults={defaults} onCreated={async (c) => { await reload(); onSelect(c.id); }} say={say} />}
      {mode === "live" && <Wizard defaults={defaults} onCreated={async (c) => { await reload(); onSelect(c.id); }} say={say} />}
    </>
  );
}
