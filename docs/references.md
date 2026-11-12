# References

Every PingOne or MCP behaviour this tool states comes from one of these. Anything else is labelled UNVERIFIED in the UI and in [live-checks.md](live-checks.md).

| Claim | Source |
| --- | --- |
| Hosted admin-plane MCP endpoint `https://api.pingone.{region}/v1/environments/{envId}/mcp`; regions `com`, `eu`, `asia`, `ca`; tool names and parameters are camelCase and a snake_case parameter is silently wrong; the tool list is gated by the caller's admin roles and a short list means missing roles; `tools/call` params are `{name, arguments}`; replies may be JSON or a single SSE frame; no `initialize` handshake is needed; worker `client_credentials` for unattended callers, OAuth for a human; Basic or a secret only at the token endpoint | the `pingone-mcp` skill (SKILL.md), read this session |
| Alternate endpoint shape `https://mcp.pingone.{region}/admin/{envId}/mcp`; the 401 body is always "Invalid authentication"; AI-DEMO2 measured that the hosted server accepted only tokens minted for PingOne's built-in client `pingone-mcp-server` (loopback redirect `http://localhost:<port>/callback`, scope `openid offline_access`), not an app it registered | AI-DEMO2 `demo_api_server/services/mcpPingOneHttpAdapter.js` (`_mcpUrl`, `_authDiagnosis`) and `routes/mcpPingOneAdminAuth.js` (`resolveLoopbackClientConfig`), read this session. The two endpoint shapes disagree; which one a tenant answers on is UNVERIFIED, so the connection has an `endpointStyle` choice |
| Authorization server `https://auth.pingone.{region}/{envId}/as/{authorize,token}`; refresh grant with `client_id` and no secret for a public client | same AI-DEMO2 files plus `services/pingoneMcpTokenService.js` |
| Defensive SSE parsing (last `data:` frame), 401 then refresh then retry once | AI-DEMO2 `mcpPingOneHttpAdapter.js` (`_extractJsonRpc`, `_send`) |
| HTTP MCP client shape, connection store (mode 600), redaction, loopback/Host/same-origin guards, confirm gate with argsHash | the `mcp-tools` repo (same author, MIT; not part of this repo), copied with a header comment in each file |
| Scanner rule table (hidden instructions, off-box defaults, credential harvesting, shadowing, unicode tricks) and its limits | `mcp-tools` `server/src/scanner/{rules,unicode,engine}.js`, copied with a header comment; poisoned fixture from its `server/test/fixtures/hostile-snapshot.json` |
| Learning Hub pack format `demo-content-pack/1` | the ID-JAG kit's `docs/content-pack.schema.json` (copied to `docs/`; the Learning Hub's current schema accepts this pack too, see README Tests), validator pattern from hostile-mcp `scripts/validate-content-pack.mjs` |
| Container shape, loopback-only publish test | hostile-mcp `Dockerfile`, `docker-compose.yml`, `scripts/compose.test.mjs` |
| Shelf registry entry | the demo-shelf repo's `docs/registry.md` (its validation rules are copied into `scripts/lib/shelf-registry-rules.mjs`) |
| Health contract `demo-health/1` | the demo-shelf repo's `docs/health-contract.md` |
| Fixture tool catalog | illustrative sample, not a recording; no real recording was found in AI-DEMO2 |
| Settings file, ports, Mock/Live toggle, netguard with permits, shared stylesheet, README and CSS standards | the standalone-family rulebooks (kept outside this repo) and the sibling `-LAB` repos `p1az-inspector-LAB` and `agent-gateway-inspector-LAB` (patterns copied, nothing imported) |

Fetch attempt: a PingOne regions documentation page returned HTTP 404 this session, so no region beyond the four in the skill is verified. Other lowercase suffixes are accepted and labelled UNVERIFIED.

Content pack sources: none are listed. No documentation URL was fetched in this build, and the only attempt (above) returned 404, so the pack's `sources` array is empty on purpose.
