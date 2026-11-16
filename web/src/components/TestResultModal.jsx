import React from "react";
import FloatingDialog from "../floating-dialog/FloatingDialog";
import Json from "./JsonPane.jsx";
import { Untrusted } from "../lib/Untrusted.jsx";
import { ClassBadge } from "../pages/Tools.jsx";

const CLASSES = ["read", "write", "destructive"];

// The "Test connection" result, as a modal: the verdict up front, then what the
// server answered (tool counts, error class and message) in the same frame.
// The frame is the shared FloatingDialog (modal, movable, resizable); Escape
// and the title-bar close both dismiss it. Nothing here is a secret.
export default function TestResultModal({ conn, test, busy, onClose }) {
  if (!test) return null;
  const ok = test.ok === true;
  const heading = `${ok ? "Connected" : "Test failed"}: ${conn?.label || "connection"}`;
  return (
    <FloatingDialog isOpen onClose={onClose} title={heading} ariaLabel={heading} footer={null} className="confirm-dialog"
      testId="test-result" storageKey="mfa-admin-mcp.test-result" defaultWidth={576} defaultHeight={null} minHeight={200}>
      {busy && <p role="status">Testing…</p>}
      {!busy && (
        <>
          <p data-testid="test-verdict" role="status">{ok
            ? <>Connected. The server listed <strong data-testid="test-count">{test.toolCount}</strong> tools.</>
            : <>The connection did not work.</>}</p>
          {ok && test.byClass && (
            <p data-testid="test-totals">Total <strong>{test.toolCount}</strong>: {test.byClass.read} read, {test.byClass.write} write, {test.byClass.destructive} destructive.</p>
          )}
          {ok && Array.isArray(test.tools) && test.tools.length > 0 && (
            <div className="test-tools" data-testid="test-tools" role="region" aria-label="Tools the server listed" tabIndex={0}>
              {CLASSES.map((cls) => {
                const items = test.tools.filter((t) => t.class === cls);
                return items.length === 0 ? null : (
                  <section key={cls} data-testid={`test-tools-${cls}`}>
                    <h3>{cls} ({items.length})</h3>
                    <ul>{items.map((t) => <li key={t.name}><Untrusted text={t.name} /> <ClassBadge t={t} /></li>)}</ul>
                  </section>
                );
              })}
            </div>
          )}
          {!ok && (
            <div>
              {test.error && <p>Error: <code data-testid="test-error">{test.error}</code></p>}
              {test.message && <Json value={test.message} label="Server message" testId="test-message" />}
              {test.hint && <p className="hint">{test.hint}</p>}
            </div>
          )}
          {ok && test.expectedNote && <p className="hint">{test.expectedNote}</p>}
          <div className="row">
            <button type="button" className="primary" autoFocus onClick={onClose} data-testid="test-close">Close</button>
          </div>
        </>
      )}
    </FloatingDialog>
  );
}
