import React, { useState } from "react";
import * as api from "../api.js";
import FloatingDialog from "../floating-dialog/FloatingDialog";

// Interactive sign-in as PingOne's native flow (pi.flow, rule 16): no redirect, no new tab. This server opens the flow and
// answers each step; this dialog shows the form for the step it is told about: password, a device choice, a one-time code.
// The password and the code go to this app's own server, which passes them on; they are never stored, and the fields are
// cleared the moment they are sent. A step the lab cannot show (a passkey, an external sign-in) ends here with the reason.
const LABEL = { SMS: "text message", VOICE: "voice call", EMAIL: "email", TOTP: "authenticator app" };
const deviceName = (d) => `${LABEL[d.type] || d.type.toLowerCase()}${d.nickname ? ` “${d.nickname}”` : ""}${d.target ? ` (${d.target})` : ""}`;

export default function LoginDialog({ conn, start, onClose, onDone }) {
  // `start` is the first answer of login/start: { loginId, step, devices?, mockLogin? }.
  const [s, setS] = useState(start);
  const [f, setF] = useState({ username: start.mockLogin?.username || start.usernameHint || "", password: start.mockLogin?.password || "", otp: start.mockLogin?.otp || "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const where = "PingOne";

  async function send(body) {
    setBusy(true); setErr("");
    const r = await api.post(`/api/connections/${conn.id}/login/step`, { loginId: s.loginId, ...body });
    setBusy(false);
    setF((x) => ({ ...x, ...(body.action === "password" ? { password: "" } : {}), ...(body.action === "otp" ? { otp: "" } : {}) })); // what was typed is gone from the page as soon as it is sent
    if (!r.ok) {
      setErr(r.json?.message || "The sign-in did not work.");
      if (!["invalid_credentials", "invalid_otp", "bad_request"].includes(r.json?.error)) setS({ ...s, step: "failed" }); // the flow is over; start again
      return;
    }
    if (r.json.step === "done") { onDone(r.json.as); return; }
    setS((x) => ({ ...x, ...r.json }));
  }
  const submit = (action, extra) => (e) => { e.preventDefault(); send({ action, ...extra }); };
  const title = `Sign in to ${where}: ${conn.label}`;

  return (
    <FloatingDialog isOpen onClose={onClose} title={title} ariaLabel={title} footer={null} className="confirm-dialog"
      testId="login-dialog" storageKey="mfa-admin-mcp.login" defaultWidth={460} defaultHeight={null} minHeight={200}>
      {s.mockLogin && <p className="hint" data-testid="login-mock">Mock tenant: sign in as <code>{s.mockLogin.username}</code> (an admin: every tool){s.mockLogin.viewer && <> or <code>{s.mockLogin.viewer}</code> (a viewer: read tools only)</>} with password <code>{s.mockLogin.password}</code> (filled in for you), then the code <code>{s.mockLogin.otp}</code>. The tools you see follow the account you sign in as. These accounts exist only in the mock.</p>}
      {s.step === "password" && (
        <form onSubmit={submit("password", { username: f.username, password: f.password })} aria-label="Username and password">
          <label className="field">Username<input value={f.username} onChange={set("username")} required autoFocus autoComplete="username" spellCheck="false" data-testid="login-username" /></label>
          <label className="field">Password<input type="password" value={f.password} onChange={set("password")} required autoComplete="current-password" data-testid="login-password" /></label>
          <p className="hint">Sent to this app's own server, which passes it to {where}. It is not stored or logged.</p>
          <button type="submit" className="primary" disabled={busy} data-testid="login-submit">{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      )}
      {s.step === "device" && (
        <form onSubmit={submit("device", { deviceId: f.deviceId || s.devices?.[0]?.id })} aria-label="Choose a device">
          <fieldset className="seg-fs"><legend>Where should {where} send the code?</legend>
            {(s.devices || []).map((d, i) => (
              <label key={d.id}><input type="radio" name="device" checked={(f.deviceId || s.devices[0].id) === d.id} onChange={() => setF((x) => ({ ...x, deviceId: d.id }))} data-testid={`login-device-${i}`} /> {deviceName(d)}</label>
            ))}
          </fieldset>
          <button type="submit" className="primary" disabled={busy} data-testid="login-submit">{busy ? "Sending…" : "Send the code"}</button>
        </form>
      )}
      {s.step === "otp" && (
        <form onSubmit={submit("otp", { otp: f.otp })} aria-label="One-time code">
          <p data-testid="login-otp-where">{s.devices?.[0] ? <>A code was sent by {deviceName(s.devices[0])}.</> : "Enter the one-time code."}</p>
          <label className="field">One-time code<input value={f.otp} onChange={set("otp")} required autoFocus autoComplete="one-time-code" inputMode="numeric" spellCheck="false" data-testid="login-otp" /></label>
          <button type="submit" className="primary" disabled={busy} data-testid="login-submit">{busy ? "Checking…" : "Verify"}</button>
        </form>
      )}
      {s.step === "failed" && <p>This sign-in is over. Close this and press the sign-in button to start again.</p>}
      {err && <p className="err-text" role="alert" data-testid="login-error">{err}</p>}
      <div className="row"><button type="button" onClick={onClose} data-testid="login-cancel">{s.step === "failed" ? "Close" : "Cancel"}</button></div>
    </FloatingDialog>
  );
}
