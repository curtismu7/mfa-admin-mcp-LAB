import React, { useEffect, useState } from "react";
import * as api from "../api.js";
import { Untrusted } from "../lib/Untrusted.jsx";

// Recorded tool lists. On a Live connection: record its tools/list (metadata only, no call) so the mock demo can
// list those tools. On the mock demo: say how many recorded tools are listed, that they answer with invented
// replies labelled synthetic, and offer to forget them.
export default function RecordedTools({ conn, onChanged }) {
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const load = async () => { const r = await api.get("/api/recorded-tools"); setCount(r.ok ? r.json.count : null); };
  useEffect(() => { setNote(""); setErr(""); load(); }, [conn.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn) {
    setBusy(true); setErr(""); setNote("");
    const r = await fn();
    setBusy(false);
    if (!r.ok) { setErr(r.json?.message || "That did not work."); return; }
    await load();
    return r.json;
  }
  const record = () => run(() => api.post(`/api/connections/${conn.id}/record-tools`)).then((j) => j && setNote(`Recorded ${j.kept} tool${j.kept === 1 ? "" : "s"}${j.skipped ? ` (${j.skipped} skipped: bad name or oversized schema)` : ""}. The mock demo now lists them.`));
  const forget = () => run(() => api.del("/api/recorded-tools")).then((j) => { if (j) { setNote(`Forgot ${j.removed} recorded tool${j.removed === 1 ? "" : "s"}.`); onChanged?.(); } });

  if (!conn.offline) {
    return (
      <div className="card" data-testid="recorded-tools">
        <div className="row wrap">
          <button type="button" onClick={record} disabled={busy} data-testid="record-tools">{busy ? "Recording…" : "Record this tool list for the mock demo"}</button>
          <small>Saves tool names, descriptions and argument schemas only; no tool is called. The mock demo then lists these tools with their safety class and answers each with an invented reply marked <code>synthetic: true</code>, until you record a real response as a fixture.</small>
        </div>
        {note && <p className="meta" role="status">{note}</p>}
        {err && <p className="err-text" role="alert"><Untrusted text={err} /></p>}
      </div>
    );
  }
  if (!count && !note) return null;
  return (
    <div className="card" data-testid="recorded-tools">
      {count > 0 && (
        <div className="row wrap">
          <p className="meta">{count} tool{count === 1 ? "" : "s"} recorded from Live servers {count === 1 ? "is" : "are"} listed here. They answer with invented replies marked <code>synthetic: true</code>; a recorded fixture replaces that with a real response.</p>
          <button type="button" onClick={forget} disabled={busy} data-testid="forget-recorded-tools">Forget recorded tools</button>
        </div>
      )}
      {note && <p className="meta" role="status">{note}</p>}
      {err && <p className="err-text" role="alert"><Untrusted text={err} /></p>}
    </div>
  );
}
