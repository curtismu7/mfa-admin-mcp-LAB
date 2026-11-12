import { useState } from "react";

// Runs a call through the gate. `doCall(extra)` posts the call (extra = {} first, then {confirm, argsHash, typedName}).
// A 409 confirm_required opens the dialog; everything else lands in `response` to be shown as-is.
export function useGatedCall() {
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState(null);
  const [gate, setGate] = useState(null);
  async function run(doCall, request) {
    setBusy(true); setResponse(null);
    const r = await doCall({});
    setBusy(false);
    if (r.status === 409 && r.json?.error === "confirm_required") { setGate({ ...r.json, doCall, request }); return; }
    setResponse({ ...r, request });
  }
  async function confirm(typedName) {
    const g = gate; setBusy(true);
    const r = await g.doCall({ confirm: true, argsHash: g.argsHash, typedName });
    setBusy(false); setGate(null);
    setResponse({ ...r, request: g.request });
  }
  return { busy, response, gate, run, confirm, cancel: () => setGate(null), clear: () => setResponse(null) };
}
