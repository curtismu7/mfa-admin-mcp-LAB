# Live checks (owner-run, UNVERIFIED by us)

Nothing in this repo has talked to a real PingOne tenant. Run these yourself, with a tenant you own, and record the result using the evidence template at the end. Use a **throwaway** environment if you can: the last check performs a real write.

## Before you start

- Your own environment id, region, a worker application (client id, secret) with the least roles you can, and optionally an OAuth application with a pre-registered loopback redirect URI. None of these are ever committed; you type them into a connection.
- Run the app (`npm start`, or `HOST_PORT=5201 docker compose up --build -d`). Open `http://localhost:5201`.
- Writes stay **off** until check 12.

## Checks

1. Which MCP endpoint shape answers: `api.pingone.<region>/v1/environments/<envId>/mcp` (skill) or `mcp.pingone.<region>/admin/<envId>/mcp` (AI-DEMO2). Try both via the connection's endpoint style.
2. Worker auth: does a Worker application's `client_credentials` token work against the hosted MCP at all? AI-DEMO2's adapter header says it was rejected with 401 (audience mismatch, measured 2026-08-30); the skill says Worker auth is supported. They disagree.
3. Interactive auth: which client id the hosted server accepts (AI-DEMO2 measured only the built-in `pingone-mcp-server`), and whether an app you register with a loopback redirect is refused.
4. Redirect-URI rules for `http://localhost:<port>/...`: whether PingOne matches the path exactly, whether `127.0.0.1` is accepted, and whether the port must be registered. This tool accepts the callback only on `/api/oauth/callback` or `/callback` of its own port.
5. Scopes and consent: this tool requests `openid offline_access` (copied from AI-DEMO2); what consent screen appears and what roles the token carries is unverified. It also requires an `id_token` (to check the nonce); if the AS returns none, sign-in fails by design.
6. Tool count: the skill says about 60-70 tools for a fully privileged Worker (AI-DEMO2 measured 73-78 for an admin user). The "short list" hint triggers under 40.
7. JWKS location `<as>/jwks`, used to verify the id_token signature.
8. Whether tool annotations (`readOnlyHint`, `destructiveHint`) are present on the real server. If absent, every classification is the name heuristic.
9. The interactive Sign in button against a real tenant (redirect to PingOne's authorization server and back to `http://localhost:<port>/api/oauth/callback`). The browser round trip was driven only against this repo's stub authorization server.
10. The UI's role hint (a list under 40 tools) and the "about 60-70 tools" note are from the skill and have not been compared with a live count.
11. One read call: on the Tools page call a read tool such as `listApplications` (UNVERIFIED that this exact name exists on your tenant; use whatever the list shows). Expect a result and an `ok` row in the Audit page.
12. One gated write on a throwaway object (only after checks 1 to 10): turn on "allow writes" for the connection (the red banner appears), call a create tool for a throwaway object (for example a test population or application, named so you can recognise it), read the exact arguments in the confirm dialog, confirm, then verify in the PingOne console that it exists. Delete it in the console, or with the destructive-gated tool (type the tool name), and turn "allow writes" off again.
13. The scan on the real tool list: press "Scan this server's tools". Record the count of findings and whether any is a false positive on real PingOne wording.
14. Redirect base when containerised: with `HOST_PORT=5299 docker compose up -d`, the redirect URI to register is `http://localhost:5299/api/oauth/callback`. The container stub flow passed (`scripts/verify-running.mjs`); against PingOne it is UNVERIFIED.

## Stop if

- The connection banner says **real server** and you do not recognise the environment id, or it is a tenant you do not own or are not allowed to change.
- Any tool you did not expect appears as **read** but its name or description says it changes something (the classification is a heuristic; a mislabelled read tool would run without a gate). Stop, do not call it, and record its name.
- A token, client secret or authorization code appears anywhere in the page, a log or the audit log (that is a bug in this tool; stop and report it).
- PingOne shows an unexpected consent screen, asks for scopes you did not intend, or the sign-in lands on an address other than the loopback redirect URI.
- A call returns 401/403 repeatedly: do not loop; fall back to the Management API (MCP-first rule).
- Your tenant has more than a throwaway object at risk in check 12.

## Evidence template (no secrets)

Copy into your notes or a PR comment. Never paste a token, a client secret, an authorization code, or a full environment id (the first 8 characters are enough).

```
Date / who:
App version and commit (git rev-parse --short HEAD):
Run mode: host / container (HOST_PORT=...)
Environment id (first 8 chars only), region:
Endpoint style that answered: api / mcp-host / neither
Worker auth (check 2): works / 401 / other (status only, no body)
Interactive auth (checks 3-5, 9): client id kind (built-in / own app: say which, no id), redirect URI form used (localhost / 127.0.0.1), result, scopes shown on the consent screen, id_token returned (yes/no)
Tool count per identity (check 6): worker=__, interactive admin=__, short-list hint shown (yes/no)
Annotations present (check 8): readOnlyHint yes/no, destructiveHint yes/no
Read call (check 11): tool name, ok / error code
Gated write (check 12): tool name, blocked while writes off (yes/no), confirm dialog showed the right arguments (yes/no), object appeared in PingOne (yes/no), cleaned up (yes/no)
Scan (check 13): findings count, any false positives (rule ids only)
Anything surprising:
```



## Result of item 2 (2026-10-21, one tenant, by the owner's standalone worker)
A worker (client_credentials) token IS accepted by the hosted MCP server: 82 tools listed. That tenant answered only on the `mcp-host` shape (`https://mcp.pingone.<region>/admin/<env>/mcp`); the `api` shape returned 400 "must be sent to its custom domain". One tenant only: not a general guarantee. The one-click PingOne preset defaults to `mcp-host` (PINGONE_ENDPOINT_STYLE overrides).
