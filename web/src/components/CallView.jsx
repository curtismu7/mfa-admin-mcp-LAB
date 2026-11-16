import React, { useEffect, useState } from "react";
import { HOT_TARGET, redactForDisplay } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import Json from "./JsonPane.jsx";

// The exact JSON-RPC request this app sends and the response it got back (redacted: sensitive-looking argument names
// are masked here, and the server has already scrubbed its own secrets from the reply). All text, never HTML.
// `record`: optional { can, onRecord, busy, note } — "Record as fixture" saves a real response for the mock to replay.
// `sample`: optional { tool } — after a successful call, a recorded fixture for this tool is fetched and shown
// automatically ("Sample JSON-RPC response"), so users see the recorded data without hunting for it.
export default function CallView({ response, record, sample }) {
  const [err, setErr] = useState("");
  const [fixture, setFixture] = useState(null);
  useEffect(() => {
    setFixture(null);
    if (!sample?.tool || !response?.ok) return;
    let alive = true;
    fetch(`/api/fixtures/${encodeURIComponent(sample.tool)}`)
      .then((r) => r.json())
      .then((f) => { if (alive && f) setFixture(f); })
      .catch(() => {});
    return () => { alive = false; };
  }, [sample?.tool, response?.ok]);
  if (!response) return null;
  const j = response.json || {};
  const blocked = !response.ok;
  const title = response.ok ? "Result" : j.error === "writes_disabled" ? "Blocked: writes are off" : `Refused or failed (${response.status || "no reply"})`;
  async function doRecord() {
    setErr("");
    try { await record.onRecord(j); } catch (e) { setErr(e?.message || "Could not record."); }
  }
  return (
    <section className="card" aria-live="polite" data-testid="call-view">
      <h3>{title}</h3>
      {blocked && <p className="err-text" role="alert">{j.error}: <Untrusted text={j.message} /></p>}
      {Array.isArray(j.warnings) && j.warnings.length > 0 && <ul className="warns">{j.warnings.map((w) => <li key={`${w.kind}${w.param}`}><Untrusted text={w.message} /></li>)}</ul>}
      <div className="cols">
        <div><h4>Request (as sent to the MCP server; id assigned by this app)</h4><Json value={redactForDisplay(response.request)} label="Request" testId="call-request" hot={["method", "name", ...HOT_TARGET]} /></div>
        <div><h4>Response (untrusted server text, shown inert)</h4><Json value={redactForDisplay(response.ok ? { jsonrpc: "2.0", result: j.result } : j)} label="Response" testId="call-response" hot={["class", "isError", "code", "message"]} /></div>
      </div>
      {fixture && (
        <div data-testid="sample-jsonrpc">
          <h4>Sample JSON-RPC response (recorded from a real server, {new Date(fixture.recordedAt).toLocaleDateString()})</h4>
          <Json value={redactForDisplay(fixture.result)} label="Sample response" testId="sample-response" hot={["isError", "code", "message"]} />
        </div>
      )}
      {record?.can && response.ok && (
        <div className="row wrap">
          <button type="button" onClick={doRecord} disabled={record.busy} data-testid="record-fixture">{record.busy ? "Recording…" : "Record as fixture"}</button>
          <small>The mock replays this real response for the same tool. Recording is per tool name, across every connection.</small>
        </div>
      )}
      {record?.note && <p className="meta" role="status">{record.note}</p>}
      {err && <p className="err-text" role="alert">{err}</p>}
    </section>
  );
}
