# PingOne MCP Inspector LAB

A standalone app that connects to PingOne's hosted MCP server (the admin plane) or any HTTP MCP server, lists its tools with a safety class, and calls them. Read-only by default. Mock by default; Live is owner-run.

Tier: Tester
Repo: https://github.com/curtismu7/pingone-mcp-inspector-LAB
Catalog: D3

> **Nothing here has been run against a real PingOne tenant.** Everything below was run against in-process stubs only: a mock of PingOne's authorization server and hosted MCP server, and a stub poisoned server. The header has a **Mock / Live** toggle and shows the mode; **Live is refused** until the owner opts in, and the banner on every tab, presenter mode included, names the mode. The owner-run checklist for a real tenant is [docs/live-checks.md](docs/live-checks.md).

## What is simulated

**Mock mode (the default, and the only mode that runs with no setup).** The mock demo talks to an in-process mock of PingOne's hosted MCP server and authorization server on this machine, with roles `viewer` and `admin` that gate the tool list. The tool catalog is an illustrative sample, not a recording, and its write tools change only an in-memory fake tenant. A stub poisoned server (in the tests and the e2e) exercises the scan. Nothing leaves this machine: a netguard refuses every non-loopback socket, DNS lookup, fetch and UDP send, and a test asserts zero attempts over a whole Mock session. The banner says the same.

**Live mode (owner-run).** The saved connection you use talks to a real server: your own PingOne environment (a worker application, or an interactive admin sign-in with authorization code + PKCE) or any HTTP MCP server you name. Live acts on that server with the credentials you saved. It is refused until the owner sets `PINGONE_MCP_INSPECTOR_MODE=live` (see "Mock and live modes"), and even then the netguard lets a connection reach only its own hosts. Not run against a real tenant here: the endpoint shape a tenant answers on, the scopes and consent of the interactive login, and the tool count for a fully privileged worker are UNVERIFIED.

Product source: earlier PingOne MCP work and the `pingone-mcp` skill. Only ideas and endpoint shapes were taken; the code here shares nothing with them.

## Run from a clone

Prerequisites: Node 26 or newer (`.nvmrc` says 26). Docker only for the Docker form.

```bash
git clone https://github.com/curtismu7/pingone-mcp-inspector-LAB.git
cd pingone-mcp-inspector-LAB
npm ci
npm run doctor      # node, mode, bind, data directory, port range, netguard self-test, free port
npm run build       # builds web/dist, which the server serves itself
npm start           # then open http://127.0.0.1:5201/
```

Mock mode needs no setup at all: no settings file, no account, no network. Open the page, press **Add mock demo (worker, viewer/admin switch)** on Connections, and try Tools, Raw JSON-RPC, Audit, Stories and Diagram. With no connection saved yet, `GET /api/health` answers `needs-setup` (the app works; it just has nothing to show).

```bash
curl -s http://127.0.0.1:5201/api/health
curl -s http://127.0.0.1:5201/api/info
npm run smoke       # the mock demo end to end against the running app, then removes what it made
```

Development: `npm run dev` starts the API (`node --watch`) and the Vite dev server on `127.0.0.1:5202`, which proxies `/api`. `npm run e2e` drives headless Chromium against the built UI and in-process stubs (needs `npm run build` first and `npx playwright install chromium`; set `E2E_CHROMIUM` to a Chromium binary if the pinned Playwright build is missing).

## Settings file

All standalone apps read one settings file, `~/Development/.env` (mode 600). `STANDALONE_ENV=/path/to/file` overrides the path. This app reads it with `util.parseEnv`, only reads it (never writes it), and takes only the keys below; every other key in the file is ignored and never enters the server's environment. A bare `MODE` is never read.

| Key | Required | What it does |
| --- | --- | --- |
| `PINGONE_MCP_INSPECTOR_MODE` | optional | `mock` (the default) keeps Live refused. `live` is the owner's opt-in that lets the header toggle go to Live. The page opens in Mock either way. Anything else stops the server with an error. |
| `PINGONE_ENVIRONMENT_ID` | optional | Default environment id for the "Add PingOne worker" preset (Live only). Not a secret. |
| `PINGONE_REGION` | optional | Default region (`com`, `eu`, `asia`, `ca`) for the same preset. |

No admin or worker credential belongs in this file, and none is read from it. The saved connections (including a worker client secret, which is write-only) live in the app's own owner-only folder (`.data`, or `P1MCP_DATA_DIR`; mode 700, files mode 600). The "Add PingOne worker" preset reads the worker's client id and secret from a separate local file outside the repo (`~/.config/pingone-mcp-inspector/worker.env`, or `P1MCP_WORKER_ENV_FILE`; see `.env.example`). `.env.example` lists every environment variable; the old repo-level `.env` loader is gone. The port is not in the settings file: apps keep their port defaults in code.

## Ports, and what to do if the port is taken

Ports: pingone-mcp-inspector listens on 5201 (set with PORT, default 5201).
Port range for this app: 5201-5249.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:5201 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.
   Those are taken by other demos or other tools.

Other ports this app uses, all inside 5201-5249: the Vite dev server on 5202 (`VITE_PORT`), `npm run e2e` on 5231 (`E2E_PORT`), and the Docker host port `HOST_PORT` (default 5201). The in-process mock listens on an ephemeral loopback port, and the tests use ephemeral ports. The port board lists the block 5200-5249 for another app (p1-third-party-exchange, which defaults to 5200); this app keeps the 5201 it already used. That overlap is for the owner to settle (UNVERIFIED).

## Mock and live modes

- The header has a **Mock / Live** toggle on every page (Connections, Tools, Raw JSON-RPC, Audit, MCP first, Stories, Diagram). It shows the mode as `Mode: mock` or `Mode: live`, and the banner above it says the same ("MOCK mode, simulated." or "LIVE mode, owner-run."). Nothing about the mode is remembered: every load, reload and new tab opens in Mock, and Live is entered by pressing the toggle (when the server allows it).
- **Mock** shows the mock demo connections. Everything in this README runs in Mock.
- **Live** shows the saved real-server connections, the one-click presets and the "Add a connection" form. Pressing Live when it is refused changes nothing and sends no request: the page shows which guard failed and stays in Mock. Live is allowed only when every guard passes: the owner opted in with `PINGONE_MCP_INSPECTOR_MODE=live` (in the settings file or the environment), and the server is bound to loopback. A non-loopback bind (`P1MCP_BIND`) passes the guard only inside the container image, which also sets `P1MCP_CONTAINER=1` (it is published on `127.0.0.1` only); on a host run, `P1MCP_BIND=0.0.0.0` with Live is refused as `loopback-bind`. `GET /api/info` lists the failing guards.
- A saved Live connection is refused with 403 `live_refused` on every network route while Live is refused, even if it is already in the file. Deleting it, locking its writes and signing out stay available.
- Live connection rules: the server URL must be https (http only on loopback), carry no credentials and not be a literal private, link-local, shared (100.64.0.0/10) or benchmark (198.18.0.0/15) address, including the same IPv4 address written as an IPv6 literal (`[::ffff:10.0.0.1]`, NAT64 `[64:ff9b::a00:1]`, 6to4); a PingOne region must be `com`, `eu`, `asia` or `ca` unless you opt in to another suffix. Redirects are not followed and replies are size and time capped. Writes are off for every new connection; a write needs the confirm gate (exact arguments and their hash), and a destructive call needs the tool name typed.
- **Presenter mode** (press `P`, or the Present button; `Esc` leaves it). It enlarges the text and shows a presenter bar. The toggle, the mode chip and the banner stay.
- **Reset** (header "Reset session") calls `POST /api/reset` and puts the page back to its start, including the diagram boxes.
- The theme picker (Auto / Light / Dark) only sets `data-theme`; the shared stylesheet does the rest.

## Health, doctor and reset

```bash
npm run doctor   # node 26, mode, data directory, bind, port range, netguard self-test, free port
npm run reset    # POST /api/reset on the running app
npm run smoke    # health, info, the mock demo end to end, Reset, against the running app
```

`GET /api/health` answers `demo-health/1` (`{ schema, at, state, runtime, demo: { id, name, version } }`), public, GET only, no detail; `runtime` is `offline` unless a Live connection is saved. `npm run doctor` prints one line per check and exits 1 on a failure. Reset clears the audit history, every token and half-finished sign-in, turns writes off on every connection and puts the mock's fake tenant back. It keeps the saved connections and their secrets (they are saved settings). The UI Reset also puts the diagram boxes back, which a script cannot do in a browser tab.

## Docker (optional)

```bash
HOST_PORT=5201 docker compose up --build -d    # OrbStack, never Docker Desktop
curl -s http://127.0.0.1:5201/api/health
docker compose down
```

The container publishes on `127.0.0.1` only (a test pins it), runs as the non-root `node` user with a read-only root filesystem, all capabilities dropped and a `/data` volume for the saved connections. The server binds `0.0.0.0` inside it only because `P1MCP_BIND` is set in the image, and `P1MCP_CONTAINER=1` (also set by the image) is what lets Live accept that bind. Live is off in the container unless you start it with `PINGONE_MCP_INSPECTOR_MODE=live` in your shell. For the interactive sign-in (Live), register `http://localhost:<HOST_PORT>/api/oauth/callback` on your OAuth application: the app refuses a redirect URI whose port differs from the port the page is served on. Check a running instance by content with `npm run verify-running -- http://localhost:5201 [--container <name>]` (mock stub only).

## Tests

```bash
npm test      # server (node:test, glob), web (vitest) and the script tests (node --test scripts/*.test.mjs)
```

On Node 26, with the counts from the last run in this repo: 79 server tests (node:test), 38 web tests (vitest) and 36 script tests (node:test), 153 in all, all passing. The Learning Hub pack is also checked against the hub's current schema (`content-pack.json` validates against `docs/content-pack.schema.json`, a copy of the kit's schema). Nothing in `npm test` reaches a real tenant: the server tests run under a recorder that fails a file on any non-loopback attempt.

## Troubleshooting

- **The port is taken, or "refusing to start: port-range".** See "Ports, and what to do if the port is taken". `PORT` must be inside 5201-5249.
- **`GET /` answers a JSON 404.** The UI is not built. Run `npm run build`, then restart.
- **Pressing Live does nothing but show a message.** That is the designed behaviour: Live is refused until `PINGONE_MCP_INSPECTOR_MODE=live` is set in `~/Development/.env` (or the environment), then restart the server.
- **A Live connection answers 403 `live_refused`.** Same cause. It was saved while Live was allowed; set the key again, or delete the connection.
- **The browser console shows 4xx lines after you press Test, Call or Sign in.** The gate's deliberate refusals (writes off, confirm needed, not signed in) are real HTTP 4xx answers, and the browser logs them. They are not errors. See "Safety notes" for the list.
- **Sign-in says the redirect URI is invalid.** It must be `http://localhost:<the port you open the page on>/api/oauth/callback`, exactly as registered on your OAuth application (Live only; UNVERIFIED against PingOne).

## Ownership

- Owner: the Ping demo-family owner (this repo is part of the `-LAB` family under the owner's `curtismu7` account).
- License: MIT, see `LICENSE`.
- Found a problem? Open an issue on the repo.

## What it does

- Connection kinds: `pingone` (region, your environment id, worker or interactive auth), `custom` (URL plus optional header), and a Raw JSON-RPC console on any connection. In Mock the only connection is the mock demo.
- Worker auth: your own worker application (`client_credentials`). Interactive auth: authorization code + PKCE S256 + state + nonce against the PingOne authorization server, using your OAuth application's client id and a pre-registered loopback redirect URI. The redirect goes to PingOne because that is this tool's connection to a third-party server; the app itself has no accounts.
- Every tool is classed read, write or destructive ([docs/classification.md](docs/classification.md)). Write and destructive calls are blocked until you turn on "allow writes" for the connection, then need `{confirm:true, argsHash}` for the exact arguments, and destructive ones also need the tool name typed. Every call is appended to a redacted audit log.
- Scan: "Scan this server's tools" (Tools page, `POST /api/connections/:id/scan`) runs the `mcp-tools` metadata rules over the tool list of any connection. It reads `tools/list` only and reports; it blocks nothing. A clean scan is not proof of safety.
- Tokens and client secrets stay server-side; the API shows `set` or `signed in as <sub>`.
- Diagram: a ReactFlow diagram (movable boxes, Simulate, Reset, speed) of the path from your browser through this app, the token endpoint and the hosted MCP server to the admin API, for the worker and the interactive sign-in. The two diagrams are diagram-studio/1 data in `server/diagrams/` (`worker.json`, `interactive.json`). The server checks both with a copy of the studio's validator when it starts (an invalid file stops it, and `npm run doctor` says so), serves the list at `GET /api/diagrams` and each file at `GET /api/diagrams/:name` (a fixed name list; any other name is a JSON 404 that does not echo it), and the page fetches the diagram by name. The Docker image copies `server/diagrams`.
- Stories: two talk tracks (S01 a short tool list, S02 a write needs a second look) with three vertical packs, shown on the Tools, Tool and Stories pages. The presenter script is [docs/talk-track.md](docs/talk-track.md), generated from them.

Safety notes: loopback bind (refused otherwise unless `P1MCP_BIND` is set), Host check, same-origin writes. A tenant's own tool results are shown as data; only this tool's own secrets are scrubbed from them. A `readOnlyHint:true` annotation is not honoured when the tool name starts with or contains a write or destructive verb, nor when the name has no recognised verb at all (unknown stays write). The deliberate 4xx answers are `live_refused` (403), `writes_disabled` (403), `method_not_allowed` (403), `confirm_required` and `args_hash_mismatch` (409), `typed_name_required` (409) and `login_required` (401). Unverified against a real tenant, by design of this build: the exact scopes and consent behaviour of the interactive login, the tool count for a fully privileged worker (the skill says about 60 to 70), which MCP endpoint shape a tenant answers on, whether the hosted server accepts a worker (client_credentials) token at all (sources disagree; see docs/live-checks.md item 2), and PingOne's redirect-URI rules for `http://localhost`.

## Known gaps and not done

- **The diagram viewer is this app's own.** Rule 17 is met in the data, not by embedding the studio's viewer: the boxes and arrows are diagram-studio/1 files, but `web/src/pages/Diagram.jsx` draws them with its own ReactFlow box (the studio's live-trace and custom-node viewer is not shared). Each arrow may carry an optional `handles` hint (which side slot it leaves and enters by); the studio's validator ignores it, and the page falls back to the sides that face each other without it. The data's groups are not used for colour: every box looks the same, as before.
- **Live was not run against a real tenant** in this repo (see the top of this file). Live is gated, not removed: the connection form, presets, worker and interactive auth are the old code. "Every page has a real and a mock version" is met by the toggle, with the live side refused until the owner opts in.
- **The SE k8s mock build is deferred (owner, 2026-10-31).** Docker is the only packaged form; there are no manifests or deploy scripts.
- **No per-workspace isolation.** Tester tier does not require it.
- **The PingOne worker preset reads a local credentials file** (`worker.env`, outside the repo and outside the shared settings file). Whether that fits the rule that worker credentials live only in the provisioning file is for the owner to decide (UNVERIFIED).
- **Catalog id D3** comes from the old repo's shelf entry; it is not re-checked against the catalog here.
- **The port block overlaps** another app's on the board (see Ports).
- **`npm run e2e` and the Playwright proof** are not part of `npm test` or CI.

## Docs

[security.md](docs/security.md) (each rule and the test that enforces it), [architecture.md](docs/architecture.md), [classification.md](docs/classification.md), [live-checks.md](docs/live-checks.md), [references.md](docs/references.md), [talk-track.md](docs/talk-track.md), [CHANGELOG.md](CHANGELOG.md).

## Packaging files

`content-pack.json` is the Learning Hub pack (`demo-content-pack/1`), generated by `npm run content-pack` (it also validates; do not hand-edit it). `docs/shelf-entry.json` is the Demo Shelf registry entry (port 5201, catalog id `D3`, a relative `composeFile`); `scripts/lib/shelf-registry-rules.mjs` is a copy of the shelf's validation rules, tested against the entry.

## Layout

```
server/src/     the app (see docs/architecture.md)
server/test/    node:test suites (glob), ephemeral ports
web/            React + Vite UI (vitest + testing-library tests); styles/standalone-ui.css is the vendored shared stylesheet
scripts/        doctor, reset, smoke, e2e, verify-running, content-pack and talk-track builders, compose/docs/repo/shelf/hooks tests
docs/           architecture, security, classification, live-checks, references, talk-track, schema, shelf entry
content/        terms.json, the source of the pack's glossary
Dockerfile, docker-compose.yml   loopback-only publish (OrbStack: HOST_PORT=5201 docker compose up --build -d)
```
