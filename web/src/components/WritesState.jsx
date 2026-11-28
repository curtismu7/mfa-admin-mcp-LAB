import React from "react";

// Under the header, on every page and in presenter mode: the state that must never be missed, writes on (alert) or off, and, in Live, which connection is in use.
// The Real-or-mock modal (App.jsx MODE_LINES) says Mock or Real; the Mode chip and the toggle keep showing it after the modal is closed.
export default function WritesState({ mode, conn }) {
  return (
    <div data-testid="writes-state">
      {mode === "live" && <p className="notice" data-state="ok" role="status" data-testid="in-use">{conn ? `In use: ${conn.label}.` : "No Live connection is selected yet: add one on Connections."}</p>}
      {conn && (conn.allowWrites
        ? <p className="notice" data-state="bad" role="alert"><strong>WRITES ARE ENABLED</strong> for {conn.label}. Write and destructive calls can run after you confirm them{mode === "live" ? ", on the real server above" : " (against the in-memory fake tenant)"}.</p>
        : <p className="notice" data-state="ok" role="status">Writes are off. Read tools run; write and destructive tools are blocked.</p>)}
    </div>
  );
}
