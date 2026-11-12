import React from "react";

// Everything a tool server sends (names, descriptions, results, errors) is untrusted. It is only ever rendered as React
// text nodes, never as HTML, so markup in a payload is shown, not run. Pattern from hostile-mcp (Untrusted component).
export function Untrusted({ text, block = false, label }) {
  const Tag = block ? "pre" : "span";
  return <Tag className={`untrusted${block ? " untrusted--block" : ""}`} data-testid="untrusted" aria-label={label}>{String(text ?? "")}</Tag>;
}
