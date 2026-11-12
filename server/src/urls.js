// Endpoint shapes. Sources:
//  - MCP endpoint, style "api": https://api.pingone.{region}/v1/environments/{envId}/mcp  (pingone-mcp skill, SKILL.md).
//  - MCP endpoint, style "mcp-host": https://mcp.pingone.{region}/admin/{envId}/mcp  (AI-DEMO2 services/mcpPingOneHttpAdapter.js _mcpUrl).
//    The two sources differ; UNVERIFIED which one a given tenant answers on, so the style is a per-connection choice.
//  - Authorization server: https://auth.pingone.{region}/{envId}/as/{token|authorize}  (AI-DEMO2 routes/mcpPingOneAdminAuth.js).
//  - /jwks under the same base is the usual OIDC location: UNVERIFIED for PingOne by us.
// Verified region suffixes (skill): com, eu, asia, ca. Any other suffix is refused unless the operator opts in
// (connection field regionOther:true), because the region is spliced into the host that receives the worker secret
// (auth.pingone.<region>): a typo like com.xyz would send it to a host PingOne does not own.
export const VERIFIED_REGIONS = ['com', 'eu', 'asia', 'ca'];
const REGION_RE = /^[a-z]{2,6}(\.[a-z]{2,6})?$/;
const ENV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validRegion = (r, other = false) => VERIFIED_REGIONS.includes(String(r)) || (other === true && REGION_RE.test(String(r)));
export const validEnvId = (e) => ENV_RE.test(String(e));

export function asBase({ region, envId, offlineBase }) {
  return offlineBase ? `${offlineBase}/${envId}/as` : `https://auth.pingone.${region}/${envId}/as`;
}
export function mcpUrl({ region, envId, endpointStyle, offlineBase }) {
  if (offlineBase) return `${offlineBase}/mcp/${envId}`;
  return endpointStyle === 'mcp-host'
    ? `https://mcp.pingone.${region}/admin/${envId}/mcp`
    : `https://api.pingone.${region}/v1/environments/${envId}/mcp`;
}

// Hosts a saved live connection may reach: the token / authorization host and the MCP host for PingOne, or the one server URL the
// operator typed. The netguard hands out a permit for each of these only while an operation on that connection is in flight.
export function liveHosts(conn) {
  if (!conn || (conn.kind === 'pingone' && conn.offline)) return [];
  if (conn.kind === 'pingone') {
    return [`auth.pingone.${conn.region}`, new URL(mcpUrl({ region: conn.region, envId: conn.envId, endpointStyle: conn.endpointStyle })).hostname];
  }
  try { return [new URL(conn.url).hostname]; } catch { return []; }
}

// A typed server URL is refused when its host is a literal private, link-local, shared-address or unspecified address (an SSRF guard for
// literals only: a name that resolves to a private address is not caught, and the doctor says so). Loopback is allowed: the local MCP
// servers live there. An IPv6 literal that carries an IPv4 address (IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible, SIIT, NAT64 and 6to4)
// is unwrapped and judged by the IPv4 address it carries, because the kernel connects to that IPv4 address. The URL parser has already
// turned [::ffff:10.0.0.1] into [::ffff:a00:1], so the hex form is the one that matters.
const privateV4 = (a, b, c) =>
  a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
  || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));

// "a:b::c", "::ffff:1.2.3.4" -> eight 16-bit groups, or null when it is not an IPv6 literal.
function parseV6(h) {
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(':')) return null;
  let tail = [];
  let body = h;
  const dot = /(?:^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dot) {
    const o = dot.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    body = h.slice(0, h.length - dot[0].length + (dot[0].startsWith(':') ? 1 : 0)) || ':';
    if (body.endsWith(':') && !body.endsWith('::')) body = body.slice(0, -1) || ':';
  }
  const want = 8 - tail.length;
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const grp = (x) => (x === '' ? [] : x.split(':'));
  const head = grp(halves[0]); const rest = halves.length === 2 ? grp(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  let groups;
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else groups = head;
  if (groups.length !== want) return null;
  return [...groups.map((g) => parseInt(g, 16)), ...tail];
}

export function isPrivateLiteral(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) return privateV4(Number(m[1]), Number(m[2]), Number(m[3]));
  const g = parseV6(h);
  if (!g) return false;
  const v4 = (hi, lo) => privateV4(hi >> 8, hi & 255, lo >> 8);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1 is loopback, allowed like 127.0.0.1
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // fc00::/7, fe80::/10, fec0::/10
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:0:0/96 IPv4-mapped
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]); // ::ffff:0:0:0/96 SIIT
  if (g.slice(0, 6).every((x) => x === 0)) return v4(g[6], g[7]); // ::/96 IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 2002:AABB:CCDD::/48 carries the IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32 hides the IPv4 address: refuse
  return false;
}
