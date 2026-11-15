// PiFlowSignInModal: redirect-free sign-in for an interactive PingOne connection. The authorize request opens a
// pi.flow (the server answers with a JSON flow instead of a redirect), this form posts the password to it, and the
// finished flow hands the code straight back — no hosted login page, no browser redirect. The password is sent once
// in one request body and is never stored, logged or shown. Steps this lab does not drive (MFA, device selection, a
// policy screen) return a message telling the visitor to use the redirect sign-in instead.
import React, { useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import FloatingDialog from "../floating-dialog/FloatingDialog.jsx";
import { Untrusted } from "../lib/Untrusted.jsx";

const FALLBACK = "pi_flow_step_unsupported";

/**
 * conn: the connection row. onDone(connectionId): called after a successful sign-in.
 * onClose(): close the dialog. idp: 'pingone' | 'pf' — which authorization server to open the flow on.
 */
export default function PiFlowSignInModal({ conn, idp = "pingone", onDone, onClose }) {
  const [state, setState] = useState(null); // the parked flow's state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(false); // true: this flow cannot be driven; offer the redirect
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(conn.offline ? "mock-admin" : "");
  const [showPw, setShowPw] = useState(false);
  const startedRef = useRef(false);

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

  const submit = async () => {
    if (!state || !password || busy) return;
    setBusy(true); setError("");
    try {
      const r = await api.post(`/api/connections/${conn.id}/login/pi-flow/credentials`, { state, username, password });
      if (!r.ok) {
        setError(r.json?.message || "That did not work.");
        if (r.json?.error === FALLBACK) setFallback(true);
        if (r.json?.error === "bad_state" || r.json?.error === "state_expired") setState(null);
        return;
      }
            setPassword("");
      onDone(r.json.connection);
    } finally { setBusy(false); }
  };

  const label = idp === "pf" ? "PingFederate" : "PingOne";
  return (
    <FloatingDialog
      isOpen
      onClose={onClose}
      title={`Sign in to ${label}`}
      ariaLabel={`Sign in to ${label}`}
      testId="piflow-signin"
      defaultWidth={440}
      defaultHeight={330}
      storageKey="mfaadm-piflow-signin"
    >
      <div className="piflow-signin">
        <p className="meta">
          Authorization code + PKCE with <code>response_mode=pi.flow</code> at {label}: the sign-in stays in this
          dialog (no redirect). The password is sent once, used only for the flow, never stored or shown.
          {conn.offline ? <> Mock credentials: <code>mock-admin</code> / <code>mock-password</code>.</> : null}
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
        {state ? (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label className="meta" htmlFor="piflow-user">Username</label>
            <input id="piflow-user" value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} data-testid="piflow-username" />
            <label className="meta" htmlFor="piflow-pw">Password</label>
            <div className="row">
              <input
                id="piflow-pw"
                type={showPw ? "text" : "password"}
                value={password}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
                data-testid="piflow-password"
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>{showPw ? "Hide" : "Show"}</button>
            </div>
            <div className="row">
              <button type="submit" className="primary" disabled={busy || !password} data-testid="piflow-submit">Sign in</button>
              <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </form>
        ) : (
          !error && <p className="meta">Opening the sign-in flow…</p>
        )}
      </div>
    </FloatingDialog>
  );
}
