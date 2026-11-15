# Live checks (owner-run, UNVERIFIED by us)

Nothing in this repo has talked to a real PingOne tenant. Run these yourself, with a tenant you own, and record the result using the evidence template at the end. Use a **throwaway** environment if you can: the last check performs a real write.

## Before you start

- Your own environment id, region, a worker application (client id, secret) with the least roles you can, and optionally a public native OAuth application (the Setup card creates one) for the interactive sign-in. None of these are ever committed; you type them into a connection.
- Run the app (`npm start`, or `HOST_PORT=7815 docker compose up --build -d`). Open `http://localhost:7815`.
- Writes stay **off** until check 12.

## Checks

1. Which MCP endpoint shape answers: `api.pingone.<region>/v1/environments/<envId>/mcp` (skill) or `mcp.pingone.<region>/admin/<envId>/mcp` (AI-DEMO2). Try both via the connection's endpoint style.
2. Worker auth: does a Worker application's `client_credentials` token work against the hosted MCP at all? AI-DEMO2's adapter header says it was rejected with 401 (audience mismatch, measured 2026-08-30); the skill says Worker auth is supported. They disagree.
3. Interactive auth: which client id the hosted server accepts (AI-DEMO2 measured only the built-in `pingone-mcp-server`), and whether a token from your own public native app (minted through pi.flow) is refused.
4. The placeholder redirect URI (`http://localhost/mfa-admin-mcp-lab/pi-flow`): PingOne requires one on the application and names it in the authorize and token requests, but pi.flow never redirects to it, so nothing is served there. Measured: see "Result of the pi.flow switch" below.
5. Scopes and consent: this tool requests `openid offline_access` (copied from AI-DEMO2); what consent screen appears and what roles the token carries is unverified. It also requires an `id_token` (to check the nonce); if the AS returns none, sign-in fails by design.
6. Tool count: the skill says about 60-70 tools for a fully privileged Worker (AI-DEMO2 measured 73-78 for an admin user). The "short list" hint triggers under 40.
7. JWKS location `<as>/jwks`, used to verify the id_token signature.
8. Whether tool annotations (`readOnlyHint`, `destructiveHint`) are present on the real server. If absent, every classification is the name heuristic.
9. The interactive P1 login button against a real tenant: the dialog (username and password, then the SMS or email code PingOne sends, a device choice if the account has several) and the token exchange. Driven only against this repo's mock authorization server so far; the real sign-in needs the owner's credentials and phone. A sign-on policy that asks for a passkey or an external sign-in is refused with the reason (there is no redirect fallback).
9b. The "PF login" button (offered on a connection created with Authorization server = PingFederate, whose base URL is required; the offline mock simulates one; there is no default host): with an OAuth application on your PingFederate instance (PKCE enabled, a public client, pi.flow / native flow enabled), sign in should open the flow at `<pf-base>/as/authorization.oauth2` (response_mode=pi.flow), drive it at `<pf-base>/pf-ws/authn/flows/<id>` (vendor content types and the `X-XSRF-Header` CSRF header, as the family's own driver does), redeem at `<pf-base>/as/token.oauth2` and verify the id_token against `<pf-base>/pf/JWKS`. The PingFederate step shapes are copied from a working family driver and proven only against this repo's mock and a stub. The id_token issuer must equal `<pf-base>/as` (PF's issuer setting must match; UNVERIFIED against a real PF). PF commonly signs with RS256 or ES256 — the tool accepts RS256/384/512 and ES256/384/512 (raw r||s signatures, as JWS defines them) from the published JWKS and refuses any other algorithm; the ES256 path is proven against a locally signed token, not a real PF. The MCP endpoint still points at PingOne; UNVERIFIED that PingOne's hosted MCP accepts a PingFederate-issued token (audience mapping).
10. The UI's role hint (a list under 40 tools) and the "about 60-70 tools" note are from the skill and have not been compared with a live count.
11. One read call: on the Tools page call a read tool such as `listApplications` (UNVERIFIED that this exact name exists on your tenant; use whatever the list shows). Expect a result and an `ok` row in the Audit page.
12. One gated write on a throwaway object (only after checks 1 to 10): turn on "allow writes" for the connection (the red banner appears), call a create tool for a throwaway object (for example a test population or application, named so you can recognise it), read the exact arguments in the confirm dialog, confirm, then verify in the PingOne console that it exists. Delete it in the console, or with the destructive-gated tool (type the tool name), and turn "allow writes" off again.
13. The scan on the real tool list: press "Scan this server's tools". Record the count of findings and whether any is a false positive on real PingOne wording.
14. Containerised: the sign-in has no callback, so the published port does not matter for it. The container stub flow passes (`scripts/verify-running.mjs`); against PingOne it is UNVERIFIED.

## Stop if

- The connection banner says **real server** and you do not recognise the environment id, or it is a tenant you do not own or are not allowed to change.
- Any tool you did not expect appears as **read** but its name or description says it changes something (the classification is a heuristic; a mislabelled read tool would run without a gate). Stop, do not call it, and record its name.
- A token, client secret or authorization code appears anywhere in the page, a log or the audit log (that is a bug in this tool; stop and report it).
- The sign-in asks for a step the dialog cannot show (a passkey, an external identity provider), the token request answers `invalid_client` (the application is confidential), or PingOne refuses to open the flow (the message names the HTTP status and reason).
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
Interactive auth (checks 3-5, 9): client id kind (built-in / own app: say which, no id), steps the dialog showed (password / device / code), result, id_token returned (yes/no)
Tool count per identity (check 6): worker=__, interactive admin=__, short-list hint shown (yes/no)
Annotations present (check 8): readOnlyHint yes/no, destructiveHint yes/no
Read call (check 11): tool name, ok / error code
Gated write (check 12): tool name, blocked while writes off (yes/no), confirm dialog showed the right arguments (yes/no), object appeared in PingOne (yes/no), cleaned up (yes/no)
Scan (check 13): findings count, any false positives (rule ids only)
Anything surprising:
```



## Result of item 2 (2026-10-21, one tenant, by the owner's standalone worker)
A worker (client_credentials) token IS accepted by the hosted MCP server: 82 tools listed. That tenant answered only on the `mcp-host` shape (`https://mcp.pingone.<region>/admin/<env>/mcp`); the `api` shape returned 400 "must be sent to its custom domain". One tenant only: not a general guarantee. The one-click PingOne preset defaults to `mcp-host` (PINGONE_ENDPOINT_STYLE overrides).

## Result of item 4 (2026-11-13, one tenant, by the owner's session)
Superseded 2026-11-15: the sign-in is now pi.flow (see the last section), so there is no callback. As measured then, for the redirect login through the lab proxy (verified up to the authorize hop):
- The hosted MCP endpoint shape that answers is `mcp-host` (`https://mcp.pingone.<region>/admin/<env>/mcp`) — consistent with the 2026-10-21 result above.
- The interactive connection's `login/start` returns a real `auth.pingone.com` authorize URL (PKCE S256, state, nonce) with `redirect_uri=http://localhost:8443/api/oauth/callback`; the browser's port is taken from `X-Forwarded-Host` behind the shared lab-proxy.
- The Setup card's `check` reaches the real environment (unauthenticated OIDC discovery) and `apply` reuses an existing app that already carries the callback (`created: false`, app name returned, secret never echoed).
- Worker (`client_credentials`) tokens against the Management API work for setup (app create/update); the hosted-MCP worker question stays as measured on 2026-10-21 (accepted on that tenant, 82 tools).
- NOT yet run: the actual browser sign-in and a real `getMfaSettings` call (owner-run; needs the owner's credentials).

## Result of item 5 (2026-11-13, one tenant, by the owner's session)
Two measured PingOne behaviours that bit during interactive sign-in setup:
1. A full PUT that omits `grantTypes`/`responseTypes` NULLIFIES them server-side; the app then refuses `response_type=code` with `unsupported_response_type`. Fixed in the lab's setup route (only truly read-only fields are skipped); the family admin app was restored by hand.
2. An app with `accessControl: { type: 'ANY_GROUP', groups: [...] }` refuses sign-in with `access_denied: User does not have appropriate group memberships` for anyone outside the group. For the setup flow the app's access control is left unset (everyone) — role gating happens via the signed-in user's admin roles at the MCP server, not at the app.

## Result of the pi.flow switch (2026-11-15, one tenant, by the owner's session)
The first live sign-in (redirect login through the lab proxy) failed at the token exchange: PingOne answered `401 invalid_client: Unsupported authentication method`, because the family's admin sign-in application is a confidential client and the lab sent no secret. The lab now signs in with PingOne's native flow (pi.flow) as a public client. Measured against the real environment, with no credentials sent:
- Setup created the application `MFA Admin MCP LAB sign-in` (NATIVE_APP, OpenID Connect, authorization code + refresh token, response type CODE, token endpoint authentication NONE, PKCE S256 required, one redirect URI: the placeholder). PingOne refused the first attempt: an application **name** may contain only letters, numbers, spaces and `/ . ' _ -` (no parentheses), and a **description** may not contain `$ + < = > ^ ` | ~`. The old Setup had never created an application live (it reused one), so this had not shown.
- `GET /as/authorize?...&response_mode=pi.flow` with that application (public client, PKCE S256, nonce, the placeholder redirect URI, scope `openid offline_access`) answers `200` `application/hal+json` with a flow id (a UUID), `status: USERNAME_PASSWORD_REQUIRED`, `resumeUrl` and a `usernamePassword.check` link. It set **no** session cookie. The lab sends a `Cookie` header only when the server has set one.
- `GET /flows/{id}` answers `200` with no `Authorization` header and no cookie, and a step posted in the wrong state answers `400 REQUEST_FAILED` / `CONSTRAINT_VIOLATION`, not `401`: **no worker Bearer token is needed** to drive an end-user flow (a worker token appears in the devdocs sample apps for their own reasons).
- NOT yet run: the real password step, the SMS code, the code redemption (`/as/resume`, then the token endpoint), the id_token checks and whether the hosted MCP server accepts the resulting token (owner-run; needs the owner's credentials and phone).
