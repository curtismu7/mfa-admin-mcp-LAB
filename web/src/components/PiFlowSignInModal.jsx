// PiFlowSignInModal: redirect-free sign-in for an interactive PingOne connection. The authorize request opens a
// pi.flow (the server answers with a JSON flow instead of a redirect), this dialog drives the steps — password,
// then the MFA steps the flow asks for (device selection, one-time passcode) — and the finished flow hands the
// code straight back: no hosted login page, no browser redirect. The password and the passcode are sent once in
// one request body each and are never stored, logged or shown. A step this lab does not drive (a passkey, a
// policy screen) says so and points at the ordinary Sign in button, which keeps the redirect path as the fallback.
import React, { useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import FloatingDialog from "../floating-dialog/FloatingDialog.jsx";
import { Untrusted } from "../lib/Untrusted.jsx";

const FALLBACK = "pi_flow_step_unsupported";
const DEVICE_LABEL = { EMAIL: "Email", SMS: "SMS", VOICE: "Voice call", FIDO2: "Passkey" };
const deviceLabel = (d) => {
  const kind = DEVICE_LABEL[d.type] || d.type || "Device";
  return d.email ? `${kind} · ${d.email}` : d.phone ? `${kind} · ${d.phone}` : d.nickname ? `${kind} · ${d.nickname}` : kind;
};

/**
 * conn: the connection row (offline mock prefills mock-admin). onDone(connectionId): a successful sign-in.
 * onClose(): close the dialog. idp: 'pingone' | 'pf' — which authorization server to open the flow on.
 */
export default function PiFlowSignInModal({ conn, idp = "pingone", onDone, onClose }) {
  const [state, setState] = useState(null); // the parked flow's state (null = opening, done, or refused)
  const [step, setStep] = useState("password"); // password | otp | device
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(false);
  const [username, setUsername] = useState(conn.offline ? "mock-admin" : "");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPw, setShowPw] = useState(false);
  const startedRef = useRef(false);

  const run = async (path, body) => {
    setBusy(true); setError("");
    try {
      const r = await api.post(path, body);
      if (!r.ok) {
        setError(r.json?.message || "That did not work.");
        if (r.json?.error === FALLBACK) setFallback(true);
        if (["bad_state", "state_expired"].includes(r.json?.error)) { setState(null); setStep("password"); }
        return false;
      }
      if (r.json.step) { // the flow moved to an MFA step: park state, render what it asked for
        setState(r.json.state ?? state);
        setStep(r.json.step);
        setDevices(r.json.devices || []);
        setSelectedDeviceId(r.json.selectedDeviceId || (r.json.devices || [])[0]?.id || null);
        return false;
      }
      setPassword(""); setOtp("");
      onDone(r.json.connection);
      return true;
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (startedRef.current) return undefined;
    startedRef.current = true;
    (async () => {
      setBusy(true); setError("");
      try {
        const r = await api.post(`/api/connections/${conn.id}/login/pi-flow/start`, { idp });
        if (!r.ok) { setError(r.json?.message || "Could not start the sign-in."); setFallback(r.json?.error === FALLBACK); return; }
        setState(r.json.state);
      } finally { setBusy(false); }
    })();
    return undefined;
  }, [conn.id, idp]);

  const label = idp === "pf" ? "PingFederate" : "PingOne";
  const stepBody = () => {
    if (step === "device") {
      return (
        <div role="radiogroup" aria-label="Verification device" data-testid="piflow-devices">
          {devices.map((d) => (
            <button key={d.id} type="button" role="radio" aria-checked={d.id === selectedDeviceId}
              className={`btn${d.id === selectedDeviceId ? " primary" : ""}`} disabled={busy}
              data-testid={`piflow-device-${d.id}`}
              onClick={() => setSelectedDeviceId(d.id)}>
              {deviceLabel(d)}
            </button>
          ))}
          <div className="row">
            <button type="button" className="primary" disabled={busy || !selectedDeviceId} data-testid="piflow-device-go"
              onClick={() => run(`/api/connections/${conn.id}/login/pi-flow/device`, { state, deviceId: selectedDeviceId })}>
              Send the code
            </button>
          </div>
        </div>
      );
    }
    if (step === "otp") {
      return (
        <form onSubmit={(e) => { e.preventDefault(); run(`/api/connections/${conn.id}/login/pi-flow/otp`, { state, otp }); }}>
          <label className="meta" htmlFor="piflow-otp">One-time passcode</label>
          <input id="piflow-otp" value={otp} inputMode="numeric" autoComplete="one-time-code"
            onChange={(e) => setOtp(e.target.value)} data-testid="piflow-otp" />
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !otp.trim()} data-testid="piflow-otp-go">Verify</button>
          </div>
        </form>
      );
    }
    return (
      <form onSubmit={(e) => { e.preventDefault(); run(`/api/connections/${conn.id}/login/pi-flow/credentials`, { state, username, password }); }}>
        <label className="meta" htmlFor="piflow-user">Username</label>
        <input id="piflow-user" value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} data-testid="piflow-username" />
        <label className="meta" htmlFor="piflow-pw">Password</label>
        <div className="row">
          <input id="piflow-pw" type={showPw ? "text" : "password"} value={password} autoComplete="off" spellCheck={false}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); run(`/api/connections/${conn.id}/login/pi-flow/credentials`, { state, username, password }); } }}
            data-testid="piflow-password" />
          <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>{showPw ? "Hide" : "Show"}</button>
        </div>
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !password} data-testid="piflow-submit">Sign in</button>
        </div>
      </form>
    );
  };

  return (
    <FloatingDialog
      isOpen
      onClose={onClose}
      title={`Sign in to ${label}`}
      ariaLabel={`Sign in to ${label}`}
      testId="piflow-signin"
      defaultWidth={440}
      defaultHeight={360}
      storageKey="mfaadm-piflow-signin"
    >
      <div className="piflow-signin">
        <p className="meta">
          Authorization code + PKCE with <code>response_mode=pi.flow</code> at {label}: the sign-in stays in this
          dialog (no redirect). Each value you type is sent once, used only for the flow, never stored or shown.
          {conn.offline && step === "password" ? <> Mock accounts (password <code>mock-password</code>): <code>mock-admin</code> signs straight through, <code>mock-mfa</code> asks for the passcode 424242, <code>mock-two</code> offers a device choice.</> : null}
        </p>
        {error && (
          <p className="err-text" role="alert">
            <Untrusted text={error} />
            {fallback && (
              <>
                {" "}Close this dialog and use the ordinary <strong>Sign in</strong> button, which hands you to {label}&apos;s hosted login page.
              </>
            )}
          </p>
        )}
        {state ? stepBody() : !error && <p className="meta">Opening the sign-in flow…</p>}
      </div>
    </FloatingDialog>
  );
}
