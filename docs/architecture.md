# Architecture

One Node 26 ESM process (Express) serves the JSON API and the built web app (React + Vite, hash routes). Everything that holds a secret is in the server; the browser only ever sees `set` / `signed in as <sub>`.

```
browser  --same-origin-->  server (loopback)  --Bearer-->  hosted PingOne MCP server  (or any HTTP MCP server)
   ^                          |  gate + audit
   |                          +--code+PKCE, resource=<MCP URL>-->  PingOne token / authorization endpoint
   +-- sign-in flow (the admin's own sign-in: this server drives PingOne's native flow, pi.flow, step by step; no redirect)
```

The same picture is the app's Diagram page (ReactFlow: movable boxes, Simulate, Reset, speed). Its boxes and arrows are not in the page: they are diagram-studio/1 data (`server/diagrams/interactive.json`), checked when the server starts and fetched by name from `GET /api/diagrams/:name`.

## Server (`server/src`)

| File | Job |
| --- | --- |
| `app.js` | Routes, the gate wiring, scan route, static web app. |
| `diagrams.js`, `diagramStudioValidate.js` | Loads `server/diagrams/*.json` (diagram-studio/1) from a fixed name list, validates each with a copy of the studio's validator, and refuses to start on a bad file. Serves them by name. |
| `store.js` | Connections file (mode 600, dir 700). Secrets write-only; `publicView` strips them. A PingOne connection is interactive only (a worker or a client secret is refused at create) and defaults to the documented `mcp-host` endpoint. |
| `auth.js` | The admin's own sign-in, pi.flow (native flow: code + PKCE, nonce, iss, aud, jwks check; password / device / code steps; `resource=<MCP URL>`, RFC 8707, for PingOne); refresh; logout. No worker path: the hosted MCP server takes a user sign-in. A worker connection saved by an older build is refused (`worker_unsupported`). Tokens live in memory only. |
| `mcpClient.js` | HTTP MCP client: JSON or one SSE frame, size cap, no redirects, 401 then refresh then retry once. |
| `classify.js` | read / write / destructive, annotations then name heuristic, unknown = write. |
| `gate.js` | `decide()` (writes off, confirm, argsHash, typed name) and the audit log (`audit.jsonl`: arguments as sent, only the lab's own stored credentials masked). |
| `scanner/` | Metadata rules copied from `mcp-tools` (`rules.js`, `unicode.js`, `engine.js`). Reads `tools/list`; reports only. |
| `mock.js` | In-process stand-in for PingOne's authorization server (pi.flow, authorization code and refresh grants only) and hosted MCP server, role-gated catalog: the role rides on the signed-in mock account (`mock.viewer` sees read tools, `mock.admin` and the others see all). Illustrative sample, not a recording; write tools change an in-memory fake tenant. |
| `config.js`, `settings.js` | The mode guards (`liveGuards`, `liveRefusal`): Live is refused only when the bind is non-loopback without the container opt-in (owner decision 2026-11-13: no env opt-in; the Real button works out of the box). The shared settings file (`~/Development/.env`, or `STANDALONE_ENV`) read through `util.parseEnv`, three keys only. |
| `netguard.js` | Runtime guard installed when the server starts: refuses every non-loopback socket, DNS lookup, fetch, UDP send and UDP connect. A saved Live connection takes a short-lived permit for each of its own hosts (`urls.js` `liveHosts`) while one operation runs. Mock needs none. |
| `setup.js` | The Setup card: a Management worker token (from `worker.env` or pasted once) used only against the Management API to find or create the lab's public sign-in application. It never calls the MCP server. |
| `security.js`, `redact.js`, `urls.js`, `validate.js`, `health.js`, `doctor.js` | Loopback/Host/same-origin guards; scrubbing; endpoint shapes and the typed-URL rules; camelCase argument warnings; `demo-health/1`; preflight. |

## Web (`web/src`)

The header holds the Mock / Live toggle (the page always opens in Mock and remembers no mode; `GET /api/info` says whether Live is allowed), the `Mode:` chip, Reset, Present and the theme picker, with the mode banner above them on every page. The toggle decides which saved connections a page works with: the mock demo in Mock, real servers in Live. Pages: Connections (wizard, mock demo), Tools (health card, scan panel, grouped list), Tool (form from the input schema, confirm dialog), Raw JSON-RPC, Audit, MCP first, Stories (two: S01 short tool list, S02 a write needs a second look, with vertical packs), Diagram. Presenter mode toggles with `p`.

## Mock mode

A connection with `offline:true` points its token and MCP URLs at the in-process mock instead of PingOne, so the same client, auth and gate code runs. The mock starts lazily on the first offline request. Every other saved connection is Live: `app.js` refuses it (403 `live_refused`) before any request unless the Live guards pass. The mock demo is a user sign-in like a real connection: the presenter signs in through the same pi.flow dialog, and the role comes from the account (`mock.viewer`: read tools; `mock.admin`: every tool). To change the role, sign out and sign in as the other account. The page tests a mock demo on first load only when it is already signed in.

## Packaging and integration

- `Dockerfile`, `docker-compose.yml`: Node 26, non-root, loopback-only published port, `/data` volume.
- `docs/shelf-entry.json`: entry for the demo shelf (catalog id D132, portable composeFile), health at `/api/health`.
- `content-pack.json`: Learning Hub pack, generated by `scripts/build-content-pack.mjs`, validated with ajv against `docs/content-pack.schema.json` (a copy of the ID-JAG kit's schema). The hub repo is not touched.
- Patterns are copied with a header comment, never imported across repos: `mcp-tools` (client, store, redact, gate, security, scanner rules), `hostile-mcp` (netguard, inert text, e2e shape, content-pack tooling), the ID-JAG kit (story engine, schema), `demo-shelf` (health contract).
