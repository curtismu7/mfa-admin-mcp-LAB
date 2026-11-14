# MFA Admin MCP LAB — Handoff

**Date:** 2026-11-14 · **Owner:** curtismu7 · **Status: WORKING — 17 PRs merged 2026-11-13→14 (see "Recent work"); sign-in wiring live-proven, final getMfaSettings call owner-run.**

---

## What it is

A standalone lab for administering PingOne's MFA administration MCP tool set: MFA settings,
device-auth and FIDO passkey policies, notification policies, OATH tokens, and
email/phone/WhatsApp delivery settings. Tools carry safety classes (read / write / destructive)
behind a confirm gate; there is a metadata scan and an audit trail. Mock mode by default;
Live mode is owner-run.

- **Repo:** https://github.com/curtismu7/mfa-admin-mcp-LAB (dir name `mfa-admin-mcp-lab`)
- **Submodule of:** https://github.com/curtismu7/AI-DEMO-Standalone (`standalone/mfa-admin-mcp-lab`, pin = the repo's current `main`; bump via the meta-repo)
- **URL:** https://local.ping-devops.com:8443/mfa-admin-mcp/ (via the shared lab-proxy; NOT a bare loopback URL)
- **Container:** `mfa-admin-mcp-lab-mfa-admin-mcp-lab-1`, port 7815
- **Stack:** Node 26 only (`engines`, `.nvmrc`, Dockerfile and CI all pin it), React (Vite) SPA + thin Express server, single compose service

## Recent work (2026-11-13→14, 17 PRs, all CI green)

1. **Review fix pass** (#1): rule-21 `restart: unless-stopped`, catalog id D132 aligned everywhere, honest test counts (server 93 + web 88 + scripts 36), one-port 7815 range.
2. **Live opt-in removed** (#2, owner decision): the Real button works out of the box; the bind (loopback or the container's `MFAADM_CONTAINER=1`) is the only guard. Mock stays the opening mode.
3. **Interactive sign-in through the lab-proxy** (#3, #16): the redirect port follows the browser's origin (`X-Forwarded-Host`); https callback URIs accepted (PingOne requires https for non-localhost); `https://local.ping-devops.com:8443/api/oauth/callback` registered on the family admin app.
4. **Working demos fixed** (#4–#7): container dials rewrite loopback → `host.docker.internal`; the netguard permits that alias; the banking preset now points at the shared `mcp-resource-server-LAB` on `127.0.0.1:8081` and mints a local test token (Bearer scheme added automatically); OpenSearch MCP comes up via AI-DEMO2's `--profile mcpgw` on 9900.
5. **Setup card — automatic tenant configuration** (#8–#10, #12, #14): paste nothing — the lab reads `~/.config/mfa-admin-mcp/worker.env` (0600, mounted read-only at `/config/worker.env`), verifies the environment via unauthenticated OIDC discovery, finds or creates the sign-in app, registers the callback (PUT-backs now PRESERVE `grantTypes`/`responseTypes` — omitting them nullifies them on PingOne), and saves the interactive connection. Live-proven against env `01d89b06…` (reused "Demo AI App - Admin Login").
6. **Test connection modal** (#13): results show in the shared FloatingDialog (verdict + tool count + class breakdown, or error class + message + hint). Only button-pressed tests open it.
7. **Fill-from-server suggestions** (#17): suggestable fields (`index*`, `userId/user`, `environmentId`) get a **Fill from server** button backed by `POST /api/connections/:id/suggest` — it finds a read-only lookup tool in the connection's catalog, runs it through the gate, and offers up to 50 values in a filterable datalist. `environmentId` is auto-prefilled from the connection. The Tools page explains when a list is empty (interactive connection not signed in).
8. **PingOne app repairs done live** (owner-approved): grants restored (TOKEN_EXCHANGE/REFRESH_TOKEN/AUTHORIZATION_CODE + responseTypes CODE after nullification), 16 redirect URIs, group restriction removed (access_denied for non-group users; role gating belongs to the signed-in user at the MCP server).

## Asset routing — superseding note

The `base: "/mfa-admin-mcp/"` fix below solved the wrong-tab problem but broke direct
serving (the e2e proved a blank page: the html pointed at `/mfa-admin-mcp/assets` on an
origin serving `/`). **The current build uses `base: "./"`** (relative), which is correct
at `/`, under the lab-proxy's `/mfa-admin-mcp/`, and direct on :7815. The e2e also probes
for a free port pair now — 7816 is held by `workload-identity-lab` on this machine.

Checked 2026-11-14 against the running container: with the cookie set to `demo-shelf`, the
lab's JS fetched through `/mfa-admin-mcp/assets/…` is byte-identical to the one served on
raw `:7815`, so the wrong-tab bug stays fixed. Open the **trailing-slash** URL (the one the
shelf links). The slashless `/mfa-admin-mcp` also works, but only because its own response
sets the `lab=mfa-admin-mcp` cookie before `./assets/…` (which then resolves to `/assets/…`)
is requested.

## Today's fix (2026-11-13/14) — asset routing (historical)

**Symptom:** MFA Admin MCP LAB and the Demo Shelf both "opened" as the same app.

**Root cause:** the lab's Vite build used absolute asset paths (`/assets/...`). The shared
lab-proxy routes unmatched paths by the `lab` **cookie**, so the lab's JS/CSS requests were
served from whichever lab the browser had last entered — usually the shelf. Both tabs then
rendered the same bundle.

**Fix (first attempt, since replaced by `base: "./"` — see the superseding note above):**
`base: "/mfa-admin-mcp/"` in `web/vite.config.js` (commit `6d3170e`; the TopMenu re-vendor
that followed is `0ce669a` on main). Built dist and recreated the container; verified in a
real browser: shelf tab and lab tab render as distinct apps regardless of cookie state.

**Meta-repo pin bump:** `f7101f9` on `AI-DEMO-Standalone` main.

**Lesson for all labs:** an SPA served through the lab-proxy must not fetch absolute
`/assets/…` URLs: the proxy routes those by the `lab` cookie, so they can land on another lab.
A fixed `base: "/<lab-id>/"` cures that but breaks direct serving on `/` (this lab's e2e
caught it as a blank page). This lab uses the relative `base: "./"`, which works at `/`, under
the proxy prefix and on the raw port; it relies on hash routing (`parseHash` in
`web/src/App.jsx`), so relative asset URLs stay valid on every page. Check a lab's routing
and run its e2e before copying either setting.

## Related fix today — lab-proxy bare-root + reload

Two meta-repo changes landed the same day (relevant because they explain URL/proxy behavior):

1. **Bare `/` now redirects to `/demo-shelf/`** and clears the `lab` cookie
   (`b610fa7`, corrected by `1bb6862`: pingone-lab stays http, pingfederate-lab https —
   verified against the live containers).
2. **`shared/lab-proxy/reload.sh`** (`bb27348`): the safe way to restart the proxy.
   `docker compose restart lab-proxy` is DISRUPTIVE — it drops the proxy's manually-attached
   lab compose networks and every lab 502s for up to 5 min until the watchdog re-attaches.
   Use `shared/lab-proxy/reload.sh` instead: it validates the config, recreates, re-attaches
   all ~92 lab networks in ~2s (one bulk `network inspect`), reloads nginx, and health-checks.

## Day-to-day operation

- **Shelf:** https://local.ping-devops.com:8443/demo-shelf/ — the lab shows "Ready"; Start/Stop
  buttons go through the shelf's start agent (port 4405, kept alive by the lab-proxy watchdog).
- **Direct start:** `cd standalone/mfa-admin-mcp-lab && docker compose up -d --build`
  (build compiles the Vite SPA into `web/dist`, which the server serves).
- **Mode:** Mock by default. Live mode connections (OpenSearch local, Banking local,
  PingOne hosted MCP) are configured in-app under Connections; secrets are write-only,
  stored server-side on this machine.

## Install on another machine

```bash
curl -fsSL https://raw.githubusercontent.com/curtismu7/mfa-admin-mcp-LAB/main/install.sh | bash
```

Needs Docker running (OrbStack or Docker Desktop) or Node 26+. It unpacks into `./mfa-admin-mcp-LAB`,
starts the lab in Mock mode and prints the URL, `http://127.0.0.1:7815/`. A machine without this Mac's
lab-proxy has no `local.ping-devops.com:8443` address; use the loopback URL there. Options and details:
README, "Install with one command".

## Architecture notes

- One service; `server/src` is the Express API + MCP client, `web/src` the React SPA.
- The app serves `web/dist` at `/` with relative asset URLs (`base: "./"`), so the same build
  also works under the lab-proxy's `/mfa-admin-mcp/` prefix; Vite dev mode runs on 5202 with
  `/api` proxied to 7815.
- Connections model: each connection = MCP server URL + auth (worker token, interactive
  PKCE sign-in, or custom credential) + writes-allowed flag. The confirm gate refuses
  write/destructive tool calls unless the in-use connection allows writes.
- PingOne hosted MCP endpoint shapes are UNVERIFIED — see `docs/live-checks.md` in the repo;
  two shapes exist (`api.pingone.{region}/v1/environments/{envId}/mcp` vs
  `mcp.pingone.{region}/admin/{envId}/mcp`) and tenant behavior has not been confirmed.
- The lab's automatic PingOne setup uses a Management worker app (client_credentials,
  Environment Admin) reading `~/.config/mfa-admin-mcp/worker.env` if present; otherwise
  credentials are pasted once and never stored.

## Watchdogs / self-healing (context for the operator)

`scripts/lab-proxy-watchdog.sh` (launchd, every 5 min): restarts exited compose containers
(except the skip list `~/.config/demo-kit/watchdog-skip`), keeps the shelf agent and shelf
container up, recreates the proxy when nginx.conf changed inside the container, and
re-attaches lab networks. If the proxy is ever restarted manually, run
`shared/lab-proxy/reload.sh` — do not just `docker compose restart`.

## Do NOT

- Do not hand-edit `web/dist` — it is built and gitignored.
- Do not route this lab through a raw `127.0.0.1:7815` URL in demos; always the proxy URL.
- Do not restart the lab-proxy with plain `docker compose restart` (see reload.sh above).
- Do not commit AI attribution lines (owner rule).
