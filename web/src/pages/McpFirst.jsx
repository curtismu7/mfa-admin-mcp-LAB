import React from "react";

// Content comes from the pingone-mcp skill (~/.claude/skills/pingone-mcp/SKILL.md). Nothing here was checked by this
// tool against a live tenant, so the page says so (UNVERIFIED externally).
export default function McpFirst() {
  return (
    <>
      <h1>MCP first, Management API second</h1>
      <p className="notice" data-state="info" role="note">From the <code>pingone-mcp</code> skill. <strong>UNVERIFIED externally:</strong> this app has not checked any of it against a live PingOne tenant (see docs/live-checks.md).</p>
      <section className="card">
        <h2>Prefer the hosted MCP tools for</h2>
        <ul>
          <li>application, population and user reads</li>
          <li>user management: create, update, enable, disable, password and MFA actions</li>
          <li>DaVinci flow reads</li>
          <li>environment configuration updates</li>
        </ul>
      </section>
      <section className="card">
        <h2>Use the Management API directly for what MCP does not cover</h2>
        <ul>
          <li><code>createEnvironment</code>: not exposed through MCP.</li>
          <li>Resource servers and scopes: CRUD on <code>/resources</code> and <code>/resources/{"{id}"}/scopes</code>.</li>
          <li>Application grants: <code>/applications/{"{id}"}/grants</code> is a PUT that replaces the whole set, not a PATCH, on both MCP and REST.</li>
        </ul>
      </section>
      <section className="card">
        <h2>The fallback rule</h2>
        <p>On any MCP failure (5xx, a missing tool, an auth error), fall back to the direct Management API instead of retrying the MCP call in a loop. Treat MCP outages as routine.</p>
      </section>
      <section className="card">
        <h2>Conventions worth knowing</h2>
        <ul>
          <li>Tool names and parameters are camelCase. A snake_case parameter is silently wrong, not rejected; the Tool page warns about it.</li>
          <li>The tool list depends on the connecting identity's admin roles. A short list means missing roles, not a broken server.</li>
          <li>A <code>tools/call</code> has the shape <code>{"{ \"name\": \"<toolName>\", \"arguments\": { ... } }"}</code>. The reply may be plain JSON or one SSE frame.</li>
        </ul>
      </section>
    </>
  );
}
