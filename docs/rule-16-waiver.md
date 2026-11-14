# Rule 16 waiver: the interactive sign-in is a redirect login (owner decision, 2026-11-14)

Rule 16 of `STANDALONE-RULES.md` says login is pi.flow only, with no redirect login fallbacks. The one exception the rulebook writes down (16a) is poppy-agent-tester. **This lab's interactive connection signs an administrator in with an authorization-code + PKCE redirect, and the owner waived rule 16 for it on 2026-11-14.** The conformance gate has no check for rule 16, so this file is the record of the decision, not a CI exemption.

## What is covered

Only the sign-in of the **interactive** connection: `startLogin` and the token exchange in `server/src/auth.js`, and the login-start and callback routes in `server/src/app.js` (callback paths `/api/oauth/callback` and `/callback`).

Not covered, and not affected: Mock mode (it has no login at all), the worker connection (client credentials, no person signs in), and every other rule. Each other conformance rule must still pass.

## Why

The lab is a client of PingOne's hosted MFA administration MCP server, a tool surface that acts as the signed-in administrator. The interactive connection exists to obtain a delegated token for that administrator, so the lab sends the person to the authorization endpoint of the connection's identity provider and receives the code on its own callback. That provider is PingOne by default, or a PingFederate server when the connection's IdP toggle is set to PingFederate; the toggle changes which authorization server the same redirect flow talks to, not the flow, so it is covered here too. The lab does not host a sign-in page of its own, and the code is inherited from the pingone-mcp-inspector-LAB fork.

**UNVERIFIED:** that a pi.flow sign-in could replace it. No rewrite was attempted, and none can be proven here without a live tenant. Whether the hosted MCP server accepts a token from such a flow is not known. Live PingFederate sign-in is also UNVERIFIED (see `docs/live-checks.md`).

## Guards that stay in force

Each is pinned by a test in `server/test/auth.test.js` (the `interactive:` tests) or `server/test/api.test.js` (`interactive login over HTTP`).

- Authorization code with PKCE (S256), a `state` that is single use and expires after 5 minutes, and a `nonce`.
- The id_token is checked: RS256 or ES256 signature (ES256 for PingFederate) against the authorization server's published keys, `iss`, `aud`, `exp` and `nonce`.
- The redirect URI must be one of the two callback paths, carry no query or fragment, and use the port the page is served on; the callback is accepted only on the exact registered URI.
- Starting a login is same-origin only. Live stays behind the loopback-bind guard, and the netguard lets a connection reach only its own hosts.

## Do not extend

This waiver covers the one existing sign-in. No new page, connection type or login may add a redirect flow on the strength of it. If the lab moves to pi.flow, delete this file and the links to it in `README.md` and `CLAUDE.md`.
