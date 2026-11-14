# CLAUDE.md

MFA Admin MCP LAB (Tier: Tester, catalog D132, port 7815). A fork of pingone-mcp-inspector-LAB focused on PingOne's MFA administration MCP tool set: connects to the hosted PingOne MCP server (or any HTTP MCP server), lists tools with a safety class (read / write / destructive), calls them behind a confirm gate, scans the tool metadata, keeps a redacted audit log. The mock catalog is the MFA administration tool set (environment MFA settings, device-authentication and FIDO policies, notification policies, OATH tokens, email/phone/WhatsApp delivery settings) plus a small general-admin sample. Mock (the in-process mock demo) is the default; Live is owner-run and gated by the loopback-bind guard only (owner decision 2026-11-13: no env opt-in). Details: [README.md](README.md), [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md). Presenter script: [docs/talk-track.md](docs/talk-track.md).

## Commands (from package.json)

```bash
npm ci
npm test             # server (node --test test/*.test.js) + web (vitest) + scripts/*.test.mjs
npm run build        # builds web/dist, served by the server itself
npm start            # http://127.0.0.1:7815/  (PORT to change)
npm run dev          # API with --watch, Vite on 5202
npm run doctor       # node 26, mode, data dir, bind, port range, netguard self-test, free port (PORT=7815 to dodge a running copy)
npm run reset        # POST /api/reset on the running app
npm run smoke        # the mock demo end to end against the running app (removes what it made)
npm run e2e          # headless Chromium on 5231; build first (E2E_CHROMIUM=<binary> if the Playwright build is missing)
npm run content-pack # regenerates and validates content-pack.json (do not hand-edit it)
npm run talk-track   # regenerates docs/talk-track.md from the stories (a test fails on drift)
```

Docker (OrbStack, never Docker Desktop): `HOST_PORT=7815 docker compose up --build -d` (publishes `127.0.0.1:` only). Node 26 only.

`install.sh` is the one-command install for another machine (the curl one-liner is in the README; `scripts/install.test.mjs` pins it). The compose file pins `name: mfa-admin-mcp-lab`, so testing it on a machine that already runs this lab recreates that lab's container unless you set `COMPOSE_PROJECT_NAME` to something else.

## Rules that bite here

- **Mock / Live toggle in the header on every page**, the mode shown (`Mode: mock|live`) and the banner saying the same mode, presenter mode included. The page always opens in Mock (nothing about the mode is remembered). **Live is refused** unless the bind is loopback (a non-loopback `MFAADM_BIND` counts only with the image's `MFAADM_CONTAINER=1`; owner decision 2026-11-13: no env opt-in, the Real button works out of the box): `server/src/config.js` guards, `GET /api/info`, 403 `live_refused` in `app.js` on every network route for a non-mock connection. Do not add a path that lets Live bind wide. Never read a bare `MODE`, never `process.env.MODE`.
- **Zero outbound in Mock.** `server/src/netguard.js` (installed by `index.js`) refuses every non-loopback socket, DNS lookup, fetch, UDP send and UDP connect; a Live operation holds a permit for the hosts of its own connection only (`urls.js` `liveHosts`, `withPermits` in `app.js`). Tests run under the recorder in `server/test/netguard.js` and assert zero attempts.
- **Secrets are write-only.** Client secrets, tokens and the custom header value are never returned, logged or audited (`store.js` `publicView`, `redact.js`). Reset keeps connections but turns writes off.
- **Settings.** `~/Development/.env` (or `STANDALONE_ENV`) is READ ONLY, through `util.parseEnv`, three keys only (`settings.js`). No per-app `.env` is loaded. Admin and worker credentials never go in it. Owner-approved exception (2026-11-14): the rulebook's per-app `.env` beside the compose file is not used here. This lab reads that shared file for three non-secret keys, and the setup card reads the worker credentials from `~/.config/mfa-admin-mcp/worker.env` (`MFAADM_WORKER_ENV_FILE`; mounted read-only, never in the repo).
- **Loopback only.** Bind `127.0.0.1`; keep the Host check and the same-origin write check (`security.js`) in front of every route. Docker publishes `127.0.0.1:` only. A typed URL is https (http on loopback only), no credentials, no literal private address (IPv4, and IPv6 literals that carry an IPv4 address, are judged by `isPrivateLiteral` in `urls.js`).
- **The interactive sign-in is a redirect login (auth code + PKCE), a waived exception to rule 16** (owner, 2026-11-14): [docs/rule-16-waiver.md](docs/rule-16-waiver.md). Do not add another redirect login on the strength of it; the guards listed there stay.
- **CSS standard.** `web/src/styles/standalone-ui.css` is vendored byte-for-byte from `~/Development/AI-DEMO-Standalone/shared/standalone-ui.css` (never edit it) and loads before `app.css`. App CSS: tokens only, no colour literals, no `prefers-color-scheme`, no `!important`, no italics, breakpoints 600/900 only. Check: `bash ~/Development/AI-DEMO-Standalone/scripts/check-css.sh .`
- **No identifiers from other projects.** Test fixtures use `11111111-2222-4333-8444-555555555555` and `.example` / `.invalid` hosts. The forbidden-strings scan must print 0: `git log -p --all | grep -cF -f ~/.config/demo-kit/forbidden-strings.txt`. Never print or copy that file. gitleaks runs in `.githooks/pre-commit`; do not bypass it.
- **Test scripts use globs, never directories** (`node --test test/*.test.js`). Never parse `node:test` stdout: use the exit code.
- **Never use `crypto.generateKeyPairSync('ec')` or async `generateKeyPair` for EC** (SIGABRT on Node 20 in CI); RSA (the mock's keys) is fine. A repo test greps for it.
- **Product claims are UNVERIFIED unless sourced.** Nothing was run against a real PingOne tenant. The mock catalog is an illustrative sample, not a recording.
- The diagram is diagram-studio/1 data (rule 17): `server/diagrams/worker.json` and `interactive.json`, validated at startup by `server/src/diagrams.js` (copy of the studio validator in `diagramStudioValidate.js`; never import across repos), served by `GET /api/diagrams[/:name]` from a fixed name list, fetched by name in `web/src/pages/Diagram.jsx`. Do not hand-build nodes or edges in the page; edit the JSON (a test pins the layout and step counts). The Dockerfile must `COPY server/diagrams`. Rule 5 stays: movable boxes, Simulate, Reset (also restores positions, from the header Reset too), speed.
- No k8s manifests, no SE build, no hosted mode (deferred by the owner, 2026-10-31); a repo test pins that.

## Where the safety claims are pinned

- `server/test/mode.test.js`, `runtimeguard.test.js`, `netguard.test.js`: Live refused, the guards, the settings reader, the runtime netguard and its permits, zero outbound.
- `server/test/api.test.js`, `hostile.test.js`, `auth.test.js`, `mcpClient.test.js`, `scan.test.js`: the gate, secrets never returned, hostile servers, OAuth, the client, the scan.
- `server/test/reset.test.js`: Reset clears run state and keeps connections.
- `web/src/App.test.jsx`: the header toggle on every page, the banner, the refusal message, Reset, inert server text, presenter mode.
- `scripts/repo.test.mjs`: README standard, CSS standard, CI, no k8s/MODE/EC keygen, Live gated by the bind only. `scripts/compose.test.mjs`: loopback-only container publish. `scripts/docs.test.mjs`: docs match the code. `scripts/shelf-entry.test.mjs`, `content-pack.test.mjs`, `talk-track.test.mjs`, `hooks.test.mjs`.

## Shelf and content pack

- Edit `content/terms.json`, then `npm run content-pack`. Catalog id D132 appears in the shelf entry, the pack and the README; a test pins all three.
- The shelf entry is `docs/shelf-entry.json` (port 7815, relative `composeFile`); `scripts/lib/shelf-registry-rules.mjs` is a copy of the shelf's rules. Change the port or id only with the shelf owner.
- Run check-drift, check-css and conformance by hand: `bash ~/Development/AI-DEMO-Standalone/scripts/check-drift.sh .`, `node ~/Development/demo-kit-base/scripts/conformance.mjs . --new`.
