import React from "react";

// The banner names the mode the header toggle shows, on every page and in presenter mode, and says what is simulated (rule 2).
// Under it: the state that must never be missed, writes on (alert) or off.
export function bannerText(mode, conn) {
  if (mode === "mock") {
    return "MOCK mode, simulated. An in-process mock of PingOne's hosted MCP server and authorization server answers on this machine. The tool catalog is an illustrative sample, not a recording, and its write tools change only an in-memory fake tenant. Nothing leaves this machine.";
  }
  const where = conn ? ` In use: ${conn.label}.` : " No Live connection is selected yet: add one on Connections.";
  return `LIVE mode, owner-run. Calls go to the real server of the connection you use, with the credentials you saved, and act on it.${where} UNVERIFIED against a real tenant: whether the hosted PingOne server accepts a worker token, and which endpoint shape a tenant answers on (docs/live-checks.md).`;
}

export default function Banner({ mode, conn }) {
  return (
    <div data-testid="banner">
      <p className="banner" role="note" data-state={mode === "live" ? "live" : "mock"}>{bannerText(mode, conn)}</p>
      {conn && (conn.allowWrites
        ? <p className="notice" data-state="bad" role="alert"><strong>WRITES ARE ENABLED</strong> for {conn.label}. Write and destructive calls can run after you confirm them{mode === "live" ? ", on the real server above" : " (against the in-memory fake tenant)"}.</p>
        : <p className="notice" data-state="ok" role="status">Writes are off. Read tools run; write and destructive tools are blocked.</p>)}
    </div>
  );
}
