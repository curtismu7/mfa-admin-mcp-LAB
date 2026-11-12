// Pure helpers for the UI. No tokens or secrets pass through here: the API never returns them.

export const CLASS_WHY = {
  annotation: "from the server's own annotation",
  name: "guessed from the tool name (heuristic)",
  unknown: "unknown verb in the name, so treated as a write (conservative default)",
};
export const classWhy = (t) => CLASS_WHY[t.classSource] || CLASS_WHY.name;

export const GROUPS = ["Applications", "Populations", "Users", "DaVinci", "Environment", "Other"];
export function groupOf(tool) {
  if (/davinci|flow/i.test(tool.name)) return "DaVinci";
  const a = String(tool.area || "").toLowerCase();
  if (a === "application") return "Applications";
  if (a === "population") return "Populations";
  if (a === "user") return "Users";
  if (a === "environment") return "Environment";
  return "Other";
}
export function groupTools(tools, query = "", cls = "all") {
  const q = query.trim().toLowerCase();
  const out = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const t of tools) {
    if (cls !== "all" && t.class !== cls) continue;
    if (q && !`${t.name} ${t.description}`.toLowerCase().includes(q)) continue;
    out[groupOf(t)].push(t);
  }
  return out;
}

const camel = (s) => s.replace(/_+([a-z0-9])/gi, (_, c) => c.toUpperCase());
// Same rules as server/src/validate.js, so the form can warn while typing. Warnings only; they never block.
export function warnArgs(schema, args) {
  const out = [];
  const props = schema && typeof schema === "object" ? schema.properties : null;
  if (!props || typeof props !== "object" || !args || typeof args !== "object") return out;
  for (const k of Object.keys(args)) {
    if (k in props) continue;
    const alt = camel(k);
    if (k.includes("_") && alt in props) out.push({ param: k, kind: "snake_case", message: `"${k}" is snake_case; this server uses camelCase. Did you mean "${alt}"? A wrong-case name is silently ignored.` });
    else if (schema.additionalProperties !== true) out.push({ param: k, kind: "unknown", message: `"${k}" is not a parameter of this tool; it will probably be ignored.` });
  }
  for (const r of Array.isArray(schema.required) ? schema.required : []) if (!(r in args)) out.push({ param: r, kind: "missing", message: `required parameter "${r}" is missing.` });
  return out;
}

const SENSITIVE = /secret|password|passwd|token|credential|api[-_]?key|authorization/i;
export function redactForDisplay(v, depth = 0) {
  if (depth > 6) return "[deep]";
  if (Array.isArray(v)) return v.map((x) => redactForDisplay(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "[redacted]" : redactForDisplay(x, depth + 1)]));
  return v;
}
export const pretty = (v) => JSON.stringify(v, null, 2);

export function countdown(expiresAt, now) {
  const s = Math.floor((expiresAt - now) / 1000);
  if (!(s > 0)) return "expired";
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The exact redirect URI to register on the OAuth application: this page's own loopback port. */
export const redirectUriFor = (loc = window.location) => `http://localhost:${loc.port || "80"}/api/oauth/callback`;

export const DEMO_ENV_ID = "11111111-2222-4333-8444-555555555555"; // placeholder, not a tenant
/** The mock demo: a PingOne connection that talks to the in-process mock. Every other saved connection is Live. */
export const isMockConn = (c) => Boolean(c) && c.kind === "pingone" && c.offline === true;
export const isReal = (c) => Boolean(c) && !isMockConn(c);
