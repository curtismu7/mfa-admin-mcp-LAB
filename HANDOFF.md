# MFA Admin MCP LAB — Handoff

**Date:** 2026-11-14 · **Owner:** curtismu7 · **Status: WORKING — one fix shipped today, see "Today's fix".**

---

## What it is

A standalone lab for administering PingOne's MFA administration MCP tool set: MFA settings,
device-auth and FIDO passkey policies, notification policies, OATH tokens, and
email/phone/WhatsApp delivery settings. Tools carry safety classes (read / write / destructive)
behind a confirm gate; there is a metadata scan and an audit trail. Mock mode by default;
Live mode is owner-run.

- **Repo:** https://github.com/curtismu7/mfa-admin-mcp-LAB (dir name `mfa-admin-mcp-lab`)
- **Submodule of:** https://github.com/curtismu7/AI-DEMO-Standalone (`standalone/mfa-admin-mcp-lab`, pinned at `84be1ce`)
- **URL:** https://local.ping-devops.com:8443/mfa-admin-mcp/ (via the shared lab-proxy; NOT a bare loopback URL)
- **Container:** `mfa-admin-mcp-lab-mfa-admin-mcp-lab-1`, port 7815
- **Stack:** Node >=22, React (Vite) SPA + thin Express server, single compose service

## Today's fix (2026-11-13/14) — asset routing

**Symptom:** MFA Admin MCP LAB and the Demo Shelf both "opened" as the same app.

**Root cause:** the lab's Vite build used absolute asset paths (`/assets/...`). The shared
lab-proxy routes unmatched paths by the `lab` **cookie**, so the lab's JS/CSS requests were
served from whichever lab the browser had last entered — usually the shelf. Both tabs then
rendered the same bundle.

**Fix:** `base: "/mfa-admin-mcp/"` in `web/vite.config.js` (commit `6d3170e`, plus a follow-up
`84be1ce` re-vendoring TopMenu). Built dist and recreated the container; verified in a real
browser: shelf tab and lab tab render as distinct apps regardless of cookie state.

**Meta-repo pin bump:** `f7101f9` on `AI-DEMO-Standalone` main.

**Lesson for all labs:** any SPA served through the lab-proxy MUST set Vite `base` to its
sub-path (`/<lab-id>/`) or its absolute `/assets` fetches get routed to the wrong lab.

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

## Architecture notes

- One service; `server/src` is the Express API + MCP client, `web/src` the React SPA.
- The app serves `web/dist` at the `/mfa-admin-mcp/` base; Vite dev mode runs on 5202 with
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
