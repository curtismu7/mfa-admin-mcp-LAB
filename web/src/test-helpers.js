import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// The real diagram-studio/1 files the server serves, so the web tests render the same data the app does.
const DIAGRAMS = Object.fromEntries(["worker", "interactive"].map((n) => [n, JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "diagrams", `${n}.json`), "utf8"))]));

export const ENV = "11111111-2222-4333-8444-555555555555"; // placeholder, not a tenant
export const TOOLS = [
  { name: "getMfaSettings", description: "Environment MFA settings", inputSchema: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"] }, class: "read", classSource: "name", area: "mfa" },
  { name: "listFidoPolicies", description: "List FIDO passkey policies", inputSchema: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"] }, class: "read", classSource: "name", area: "fido" },
  { name: "listNotificationPolicies", description: "List notification policies", inputSchema: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"] }, class: "read", classSource: "name", area: "notification" },
  { name: "listOathTokens", description: "List OATH tokens", inputSchema: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"] }, class: "read", classSource: "name", area: "oath" },
  { name: "getEmailDeliverySettings", description: "Email delivery settings <img src=x onerror=alert(1)>", inputSchema: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"] }, class: "read", classSource: "name", area: "email" },
  { name: "createFidoPolicy", description: "Create a FIDO policy", inputSchema: { type: "object", properties: { environmentId: { type: "string" }, name: { type: "string" } }, required: ["environmentId", "name"] }, class: "write", classSource: "name", area: "fido" },
  { name: "deleteFidoPolicy", description: "Delete a FIDO policy", inputSchema: { type: "object", properties: { environmentId: { type: "string" }, policyId: { type: "string" } }, required: ["environmentId", "policyId"] }, class: "destructive", classSource: "annotation", area: "fido" },
  { name: "syncTenantWidgets", description: "unknown verb", inputSchema: { type: "object", properties: {} }, class: "write", classSource: "unknown", area: "tenant" },
];
export const conn = (o = {}) => ({ id: "c1", kind: "pingone", label: "Mock demo", offline: true, region: "com", envId: ENV, auth: "worker", clientId: "viewer-demo", clientSecret: "set", allowWrites: false, auth_status: { token: "set", expiresAt: Date.now() + 125_000 }, ...o });

// A tiny fake of this app's API. `calls` records every request; handlers can be overridden per test.
export const LIVE_OK = { available: true, failed: [], needs: [] };
export const LIVE_REFUSED = { available: false, failed: ["loopback-bind"], needs: ["the server must be bound to loopback"] };
export function fakeApi({ conns = [conn()], tools = TOOLS, audit = [], handlers = {}, live = LIVE_OK, defaults = { envId: null, region: null } } = {}) {
  const state = { conns: structuredClone(conns), calls: [], audit };
  const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  let serverMode = "mock";
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || "GET"; const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, url, body });
    const key = `${method} ${url.replace(/c1|c2/, ":id")}`;
    if (handlers[key]) return handlers[key](body, state, json);
    switch (key) {
      case "GET /api/info": return json(200, { mode: serverMode, source: serverMode, modes: ["mock", "live"], realAvailable: live.available, realReason: live.available ? null : "refused", live });
      case "POST /api/mode":
        if (body.source === "real" && !live.available) return json(409, { error: "real_not_available", message: "Live is refused: loopback-bind." });
        serverMode = body.source; return json(200, { source: serverMode, realAvailable: live.available, realReason: null });
      case "POST /api/reset": return json(200, { ok: true, cleared: ["audit"], kept: ["connections"] });
      case "GET /api/setup/defaults": return json(200, defaults);
      case "GET /api/connections": return json(200, { connections: state.conns });
      case "POST /api/connections": { const c = conn({ id: "c2", ...body, offline: body.offline === true, clientSecret: body.clientSecret ? "set" : undefined, allowWrites: false, auth_status: {} }); state.conns.push(c); return json(201, c); }
      case "POST /api/connections/:id/test": return json(200, { ok: true, toolCount: tools.length, byClass: { read: 5, write: 2, destructive: 1 }, hint: "A short list usually means missing admin roles.", fixture: "illustrative sample, not a recording" });
      case "GET /api/connections/:id/tools": return json(200, { count: tools.length, tools });
      case "POST /api/connections/:id/settings": state.conns[0].allowWrites = body.allowWrites; return json(200, state.conns[0]);
      case "GET /api/diagrams": return json(200, { diagrams: Object.values(DIAGRAMS).map((d) => ({ name: d.id, title: d.title })) });
      case "GET /api/diagrams/worker": return json(200, DIAGRAMS.worker);
      case "GET /api/diagrams/interactive": return json(200, DIAGRAMS.interactive);
      case "GET /api/audit": return json(200, { entries: state.audit });
      default: return json(404, { error: "not_found", message: `unhandled ${key}` });
    }
  });
  return state;
}
