import React from "react";
import { pretty } from "../lib/format.js";
import FloatingDialog from "../floating-dialog/FloatingDialog";

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
            <p>By safety class: {test.byClass.read} read, {test.byClass.write} write, {test.byClass.destructive} destructive.</p>
          )}
          {!ok && (
            <div>
              {test.error && <p>Error: <code data-testid="test-error">{test.error}</code></p>}
              {test.message && <pre className="untrusted untrusted--block" data-testid="test-message">{pretty(test.message)}</pre>}
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
