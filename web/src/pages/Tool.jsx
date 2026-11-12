import React, { useEffect, useMemo, useState } from "react";
import * as api from "../api.js";
import CallView from "../components/CallView.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import { useGatedCall } from "../components/useGatedCall.js";
import { classWhy, pretty, warnArgs } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import { usePresent } from "../present/Present.jsx";
import StoryPanel from "../story/StoryPanel.jsx";
import { ClassBadge } from "./Tools.jsx";

const show = (v) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
function coerce(type, text) {
  if (text === "") return undefined;
  if (type === "number" || type === "integer") { const n = Number(text); return Number.isNaN(n) ? text : n; }
  if (type === "object" || type === "array") { try { return JSON.parse(text); } catch { return text; } }
  return text;
}

function Fields({ schema, args, setArgs }) {
  const props = schema?.properties || {};
  const names = [...Object.keys(props), ...Object.keys(args).filter((k) => !(k in props))];
  const required = new Set(schema?.required || []);
  const put = (k, v) => setArgs((a) => { const n = { ...a }; if (v === undefined) delete n[k]; else n[k] = v; return n; });
  if (!names.length) return <p>This tool takes no parameters.</p>;
  return names.map((k) => {
    const p = props[k]; const type = p?.type;
    const label = <>{k}{required.has(k) && <abbr title="required"> *</abbr>}{!p && <span className="badge badge--lock">not in schema</span>}</>;
    const hint = p?.description && <small><Untrusted text={p.description} /></small>;
    if (p?.enum) return <label className="field" key={k}>{label}<select value={show(args[k])} onChange={(e) => put(k, e.target.value || undefined)}><option value="">(unset)</option>{p.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}</select>{hint}</label>;
    if (type === "boolean") return <label className="field" key={k}>{label}<select value={args[k] === undefined ? "" : String(args[k])} onChange={(e) => put(k, e.target.value === "" ? undefined : e.target.value === "true")}><option value="">(unset)</option><option value="true">true</option><option value="false">false</option></select>{hint}</label>;
    if (type === "object" || type === "array") return <label className="field" key={k}>{label} (JSON)<textarea rows={3} value={typeof args[k] === "string" ? args[k] : args[k] === undefined ? "" : pretty(args[k])} onChange={(e) => put(k, coerce(type, e.target.value))} spellCheck="false" />{hint}</label>;
    return <label className="field" key={k}>{label}<input type={type === "number" || type === "integer" ? "number" : "text"} value={show(args[k])} onChange={(e) => put(k, coerce(type, e.target.value))} spellCheck="false" autoComplete="off" />{hint}</label>;
  });
}

export default function Tool({ conn, tools, name }) {
  const tool = (tools || []).find((t) => t.name === name);
  const { present } = usePresent();
  const initial = useMemo(() => (conn?.kind === "pingone" && tool?.inputSchema?.properties?.environmentId ? { environmentId: conn.envId } : {}), [conn, tool]);
  const [args, setArgs] = useState(initial);
  const [mode, setMode] = useState("form");
  const [text, setText] = useState("{}");
  const [parseErr, setParseErr] = useState("");
  const g = useGatedCall();
  useEffect(() => { setArgs(initial); setMode("form"); g.clear(); }, [name, conn?.id, tool?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!conn) return <><h1>Tool</h1><p>Select a connection first.</p></>;
  if (!tool) return <><h1>Tool</h1><p>This identity does not see a tool called <Untrusted text={name} />. The list is gated by role. <a href="#/tools">Back to the tools</a></p></>;

  const current = () => { if (mode === "form") return args; try { const v = JSON.parse(text); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("arguments must be a JSON object"); return v; } catch (e) { return e; } };
  const live = current();
  const warnings = live instanceof Error ? [] : warnArgs(tool.inputSchema, live);
  function toggle(next) {
    if (next === mode) return;
    if (next === "json") { setText(pretty(args)); setParseErr(""); setMode("json"); return; }
    const v = current();
    if (v instanceof Error) { setParseErr(`Fix the JSON before switching: ${v.message}`); return; }
    setArgs(v); setParseErr(""); setMode("form");
  }
  function call() {
    const a = current();
    if (a instanceof Error) { setParseErr(a.message); return; }
    setParseErr("");
    g.run((extra) => api.post(`/api/connections/${conn.id}/call`, { tool: tool.name, arguments: a, ...extra }), { jsonrpc: "2.0", method: "tools/call", params: { name: tool.name, arguments: a } });
  }
  return (
    <>
      <p><a href="#/tools">All tools</a></p>
      <h1><Untrusted text={tool.name} /> <ClassBadge t={tool} /></h1>
      <p className="meta"><Untrusted text={tool.description || "(no description)"} /></p>
      <p className="why">Classed <strong>{tool.class}</strong> {classWhy(tool)}.{tool.class !== "read" && (conn.allowWrites ? " Writes are on for this connection, so a call shows a confirm dialog first." : " Writes are off for this connection, so a call is blocked.")}</p>
      <section className="card" aria-labelledby="form-h">
        <div className="row between wrap">
          <h2 id="form-h">Arguments</h2>
          <span className="seg" role="group" aria-label="Input mode">
            <button type="button" aria-pressed={mode === "form"} onClick={() => toggle("form")}>Form</button>
            <button type="button" aria-pressed={mode === "json"} onClick={() => toggle("json")}>JSON</button>
          </span>
        </div>
        {mode === "form"
          ? <Fields schema={tool.inputSchema} args={args} setArgs={setArgs} />
          : <label className="field">Arguments (JSON object)<textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck="false" /></label>}
        {parseErr && <p className="err-text" role="alert">{parseErr}</p>}
        {warnings.length > 0 && <ul className="warns" data-testid="warnings">{warnings.map((w) => <li key={`${w.kind}${w.param}`}><strong>{w.kind === "missing" ? "Missing" : "Warning"}:</strong> {w.message}</li>)}</ul>}
        <button type="button" className="primary" onClick={call} disabled={g.busy}>{g.busy ? "Calling…" : "Call"}</button>
      </section>
      <CallView response={g.response} />
      {g.gate && <ConfirmDialog tool={tool.name} gate={g.gate} busy={g.busy} onConfirm={g.confirm} onCancel={g.cancel} />}
      <StoryPanel mode="gate" present={present} />
    </>
  );
}
