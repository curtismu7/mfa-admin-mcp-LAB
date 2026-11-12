# Changelog

## 0.3.0 (unreleased): brought to the -LAB standard
- Answer the lab-proxy host name (fixes `bad_host` behind the family lab-proxy): `LAB_ALLOWED_HOSTS` (comma separated host names, loopback always works, unset = loopback only, a bad name refuses to start before the health timer starts and in the doctor) is added to the Host allowlist next to `P1MCP_ALLOWED_HOSTS`, which is unchanged. A write whose `Origin` equals the proxy's `X-Forwarded-Proto://X-Forwarded-Host` is accepted only when `Host` is a `LAB_ALLOWED_HOSTS` name. Compose defaults it to this app's proxy name.
- Fix pass after review: the typed-URL SSRF guard now unwraps IPv6 literals that carry an IPv4 address (IPv4-mapped, SIIT, NAT64, 6to4; Teredo refused) and also refuses 100.64.0.0/10, 192.0.0.0/24 and 198.18.0.0/15; the netguard also guards `dgram` `connect()` (self-test now 7 routes); the page always opens in Mock (the stored mode is no longer restored); Live refuses a non-loopback bind unless the image's `P1MCP_CONTAINER=1` is set; the banking preset defaults to `http://localhost:9901/mcp` with neutral labels.
- New repo `pingone-mcp-inspector-LAB` with a clean single-commit history, exported from the previous repo's `main` (no history carried over).
- Header **Mock / Live** toggle on every page, the mode shown (`Mode: mock|live`) and a banner that says the same mode. The old per-connection "mock demo" is the Mock side; real servers are the Live side. **Live is refused** (403 `live_refused`, and the toggle shows why) unless the owner sets `PINGONE_MCP_INSPECTOR_MODE=live`; the page opens in Mock either way. Old behaviour: any saved connection worked at once.
- `GET /api/info` (mode and which Live guards fail). `POST /api/reset`, `npm run reset`, a header Reset button that also restores the diagram boxes. `npm run smoke`.
- Runtime netguard with per-host permits; Live may reach only the hosts of the connection in use. A typed server URL must now be https (http only on loopback), carry no credentials and not be a literal private address.
- Settings: `~/Development/.env` (or `STANDALONE_ENV`), read only, three keys; the old repo `.env` loader is gone. The preset's environment id and region may come from there.
- Shared stylesheet vendored byte-for-byte; app CSS rewritten with tokens only (the old palette is gone); links styled as tabs; Theme is Auto / Light / Dark; breakpoints 600/900.
- Node 26 only (engines, `.nvmrc`, Dockerfile, CI on GitHub-hosted runners with forbidden-strings and gitleaks jobs); the env var `P1MCP_PORT` is now `PORT`.
- Talk track `docs/talk-track.md` generated from the stories (a test fails on drift); repo, shelf-entry and hooks tests; `docs/shelf-entry.json` has a portable composeFile.
- Removed: the repo-level `.env` loader and the absolute composeFile path. Not changed: the scan rules, the gate, the audit format.
- Rule 17: the Diagram page is drawn from diagram-studio/1 data (`server/diagrams/worker.json`, `interactive.json`) validated at startup and fetched by name (`GET /api/diagrams`, `GET /api/diagrams/:name`); the hand-built nodes and edges are gone from the page. Same boxes, arrows, text, positions and steps; the image copies the files; `npm run doctor` has a `diagrams` check; a malformed %-escape in a path now answers 400 instead of 500.
- Fixed on the way: a connection id such as `__proto__` is no longer found as a connection; unknown routes and bad JSON answer JSON; the Tools list reloads when a reset lands in the same React batch as a finished load.

## 0.2.0 (step PI2)

- Docker: `Dockerfile` (Node 22, non-root) and `docker-compose.yml` (127.0.0.1-only published port, read-only filesystem, no capabilities, `/data` volume); redirect base documented and checked against the container with `scripts/verify-running.mjs`.
- Scan: "Scan this server's tools" on the Tools page and `POST /api/connections/:id/scan`; rule table copied from `mcp-tools` (`server/src/scanner`). Flags a poisoned server, clean on the offline PingOne mock.
- Shelf entry `docs/shelf-entry.json` (D3), verified against a running demo-shelf (Ready).
- Learning Hub `content-pack.json` with generator, ajv validator and tests.
- Docs: security.md (rule to test table, checked by a test), architecture.md, classification.md (generated from the golden table, checked for staleness), expanded live-checks.md (checks, stop-if list, evidence template).
- `GET /api/health` now reflects a newly added or removed connection immediately instead of on the next 60 s poll.
- Offline mock: the `resetUserPassword` description was reworded, because the copied scanner rule read "Send a password" as credential collection (a false positive on this repo's own fixture).
- e2e: scan flows (clean mock, hostile stub) added.

## 0.1.0 (steps PI0 and PI1)

- Scaffold, MCP client, worker and interactive auth, safety gate and audit, offline mock, web UI, stories, diagram, browser e2e. See git history.
