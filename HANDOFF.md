# MFA Admin MCP LAB — Handoff

**Date:** 2026-11-16 · **Owner:** curtismu7 · **Status: WORKING — pi.flow sign-in, user-sign-in-only PingOne connections, audit as sent and login hint are merged and running; the live pi.flow sign-in is proven (86 tools); real getMfaSettings and a confirm-gated write (updateMfaDeviceAuthenticationPolicy, no change) were checked live 2026-11-15/16; PingFederate sign-in was removed 2026-11-16 (the hosted PingOne MCP refused a PF-issued token with 401), so the lab is PingOne sign-in only and no PF check is open.**

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

## 2026-11-15: the sign-in is pi.flow (supersedes every redirect/callback mention below)

The first real sign-in failed at the token exchange (`invalid_client: Unsupported authentication method`): the family's admin app is a confidential client and the lab's redirect login sent no secret. The owner asked for pi.flow (rule 16), so the sign-in is now PingOne's **native flow**: the page's own dialog (username and password, then a device choice and the one-time code), the server drives `/as/authorize?response_mode=pi.flow` → `/flows/{id}` → `/as/resume` → token endpoint as a **public client**. No redirect, no callback, no `returnTo`, no waiver (`docs/rule-16-waiver.md` is deleted).

- Setup creates its own public **native** app `MFA Admin MCP LAB sign-in` (done in the owner's environment 2026-11-15; PingOne refuses parentheses in an app name and `+` in a description). That app was later set aside: it gave only 2 tools (`listRoles`, `getRole`), and the saved connection **PingOne hosted MCP (pi.flow)** uses the environment's existing public app "PingOne MCP Server" instead (see "Proven" below; since #44 Setup uses that app as it is). The older **PingOne hosted MCP (set up)** card pointed at the confidential admin app and could not sign in; it was deleted.
- Measured on the real tenant with no credentials: the flow opens (`USERNAME_PASSWORD_REQUIRED`) and needs no worker Bearer token. Then proven by the owner the same day with the environment's existing "PingOne MCP Server" app: the real password step, the code redemption and the hosted MCP accepting the token (86 tools; see "Proven 2026-11-15" below and `docs/live-checks.md`). Not run: the lab's own `MFA Admin MCP LAB sign-in` app, which gave only 2 tools (`listRoles`, `getRole`).
- Mock sign-in: `mock.admin` / `mock-password` / code `123456` (pre-filled); `mock.nomfa` skips the code; `mock.multi` asks which device.

## 2026-11-15 (later): what changed after pi.flow, and what is left

Merged on `main` (lab PR numbers), all in the running container (the `AI-DEMO-Standalone` pin moves separately: read it with `git ls-tree origin/main standalone/mfa-admin-mcp-lab` there):

- **#30** pi.flow sign-in (above).
- **#36** A PingOne connection is a **user sign-in only**: the hosted PingOne MCP server takes an administrator's own sign-in, not a worker (`client_credentials`) token. Creating one with `auth: "worker"` or a client secret is refused (400); a worker connection saved by an older build is listed without its secret and refused on every call (409 `worker_unsupported`). The sign-in sends `resource=<MCP URL>` (RFC 8707). New connections default to the documented `mcp.pingone.<region>/admin/<envId>/mcp` shape (`api` stays selectable). In Mock the role comes from the account: `mock.viewer` sees 18 read tools, `mock.admin` all 33. Setup's Management worker stays and is used only for Management API calls, never the MCP.
- **#34** The Audit page shows tool arguments **exactly as sent**: no redaction by argument name (owner, 2026-11-15). Only this lab's own stored credentials are masked if one appears as a value. `audit.jsonl` (mode 600) can therefore hold whatever a call carried, including a secret typed into an argument. Caps: 50 keys, depth 6, strings 2000 characters.
- **#35** Optional **login hint** per connection: set on the Add connection form or on the connection card (**Save hint**; an empty value clears it). It is sent as `login_hint` on the authorize request and pre-fills the dialog's username. PingOne treats it as advisory (measured: 200, normal password step).
- **#37** A finished sign-in makes that connection the one in use, and Tools names the connection in use.

Running container image `…:latest` = `…:preset-hint`, built on the Air from `main` `abbb4be` (#57) and loaded into OrbStack; the container is created from the main checkout (project `mfa-admin-mcp-lab`, data volume `p1mcp-data`, the `worker.env` mount). Rollback tag `:pre-preset-hint` (the `:remove-pf` build); older `:pre-*` tags stay in `docker images`. Tokens live in memory, so a recreate signs you out. Since #44, Setup uses the environment's public "PingOne MCP Server" app as it is. Checked live 2026-11-15: Setup chose it and changed nothing, and a real `getMfaSettings` call answered.

**Proven 2026-11-15 (owner):** the hosted MCP accepts the lab's pi.flow token. The connection **PingOne hosted MCP (pi.flow)** uses the environment's existing public app "PingOne MCP Server", a redirect URI that app registers, and `resource=<MCP URL>`; Test connection listed 86 tools. A real `getMfaSettings` call answered (2026-11-15). A write through the confirm gate was checked live 2026-11-16 (403, 409 confirm_required, 409 args_hash_mismatch, then a no-change `updateMfaDeviceAuthenticationPolicy` accepted by PingOne). (PF login was removed 2026-11-16: the hosted PingOne MCP refused a PingFederate-issued token with HTTP 401.) Details: `docs/HANDOFF-2026-11-15.md` §0.

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
- Connections model: each connection = MCP server URL + auth (a PingOne user sign-in through
  pi.flow with PKCE, or a custom header credential) + writes-allowed flag. The confirm gate refuses
  write/destructive tool calls unless the in-use connection allows writes.
- PingOne hosted MCP endpoint shape: `mcp.pingone.{region}/admin/{envId}/mcp` is the documented
  default and answered on the real tenant (86 tools, 2026-11-15). The other shape
  (`api.pingone.{region}/v1/environments/{envId}/mcp`, from a skill) stays selectable and
  UNVERIFIED; see `docs/live-checks.md`.
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
