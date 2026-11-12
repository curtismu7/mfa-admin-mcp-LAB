// Thin fetch wrapper. Returns { ok, status, json } and never throws on an HTTP error: the gate answers with 4xx
// bodies the UI needs (writes_disabled, confirm_required). Same-origin POSTs carry the browser's own Origin header.
async function send(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, json: { error: "unreachable", message: "This app's server is not reachable." } };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json };
}
export const get = (path) => send("GET", path);
export const post = (path, body = {}) => send("POST", path, body);
export const del = (path) => send("DELETE", path);
