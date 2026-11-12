import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// Presenter mode, simplified from the ID-JAG kit (web/src/present/PresentMode.jsx, same author): bigger type, anything
// tagged data-admin-only hidden by CSS, key p toggles, Escape exits, optional fullscreen. The kit's step bar is left
// out: the talk-track panel already has its own steps here.
const KEY = "p1mcp.present";
const PresentCtx = createContext({ present: false, set: () => {} });
export const usePresent = () => useContext(PresentCtx);
const inField = (t) => !!t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");

export function PresentProvider({ children }) {
  const [present, setPresent] = useState(() => {
    try { if (new URLSearchParams(window.location.search).get("present") === "1") return true; } catch { /* no URL */ }
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  const set = useCallback((on) => {
    setPresent(on);
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not remembered */ }
    if (!on && document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
  }, []);
  useEffect(() => { if (present) document.documentElement.dataset.present = "1"; else delete document.documentElement.dataset.present; }, [present]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") { if (present) set(false); return; }
      if (!inField(e.target) && (e.key === "p" || e.key === "P")) set(!present);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present, set]);
  const value = useMemo(() => ({ present, set }), [present, set]);
  return <PresentCtx.Provider value={value}>{children}</PresentCtx.Provider>;
}

export function PresentToggle() {
  const { present, set } = usePresent();
  return <button type="button" aria-pressed={present} onClick={() => set(!present)} title="Presenter mode (p)">Present</button>;
}

export function PresentBar() {
  const { present, set } = usePresent();
  if (!present) return null;
  const fs = () => { if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {}); else document.documentElement.requestFullscreen?.()?.catch?.(() => {}); };
  return (
    <div className="present-bar" role="toolbar" aria-label="Presenter controls">
      <span>Presenter mode</span>
      <button type="button" onClick={fs} disabled={!document.documentElement.requestFullscreen}>Fullscreen</button>
      <button type="button" onClick={() => set(false)}>Exit (Esc)</button>
    </div>
  );
}
