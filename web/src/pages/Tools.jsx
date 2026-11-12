import React, { useMemo, useState } from "react";
import HealthCard from "../components/HealthCard.jsx";
import ScanPanel from "../components/ScanPanel.jsx";
import { GROUPS, classWhy, groupTools } from "../lib/format.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import StoryPanel from "../story/StoryPanel.jsx";
import { usePresent } from "../present/Present.jsx";

export function ClassBadge({ t }) {
  return <span className={`badge badge--${t.class}`} title={classWhy(t)} data-testid="class-badge">{t.class}</span>;
}

export default function Tools({ conn, tools, loading, error, test, testBusy, now }) {
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("all");
  const { present } = usePresent();
  const groups = useMemo(() => groupTools(tools || [], q, cls), [tools, q, cls]);
  if (!conn) return <><h1>Tools</h1><p>Select or add a connection first.</p></>;
  const writesOff = !conn.allowWrites;
  const total = (tools || []).length;
  return (
    <>
      <h1>Tools</h1>
      <HealthCard conn={conn} test={test} busy={testBusy} now={now} />
      <ScanPanel key={conn.id} conn={conn} />
      <div className="card controls">
        <label className="field">Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or description" /></label>
        <label className="field">Safety class
          <select value={cls} onChange={(e) => setCls(e.target.value)}><option value="all">all</option><option value="read">read</option><option value="write">write</option><option value="destructive">destructive</option></select>
        </label>
        <p className="meta" role="status">{loading ? "Loading tools…" : `${total} tool${total === 1 ? "" : "s"} listed`}</p>
      </div>
      {writesOff && <p className="notice" data-state="ok" data-testid="writes-off">Writes are off: write and destructive tools are listed so you can see them, but calls to them are blocked.</p>}
      {error && <p className="err-text" role="alert">{error}</p>}
      {GROUPS.filter((g) => groups[g].length).map((g) => (
        <section key={g} aria-labelledby={`g-${g}`} className="group">
          <h2 id={`g-${g}`}>{g} <small>({groups[g].length})</small></h2>
          <ul className="plain tools">
            {groups[g].map((t) => (
              <li key={t.name} className="card tool">
                <div className="row between wrap">
                  <h3><a href={`#/tool/${encodeURIComponent(t.name)}`}><Untrusted text={t.name} /></a></h3>
                  <span className="row"><ClassBadge t={t} />{t.class !== "read" && writesOff && <span className="badge badge--lock">blocked: writes off</span>}</span>
                </div>
                <p className="meta"><Untrusted text={t.description || "(no description)"} /></p>
                <p className="why">Classed <strong>{t.class}</strong> {classWhy(t)}.</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!loading && total > 0 && GROUPS.every((g) => !groups[g].length) && <p>No tool matches.</p>}
      <StoryPanel mode="tool-list" present={present} />
    </>
  );
}
