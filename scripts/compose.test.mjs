// Live can act on a PingOne tenant: every published port must be bound to loopback on the host. Pattern from hostile-mcp.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// A small line parser (no YAML dependency): the list items under each `ports:` key.
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}
const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

test('docker-compose.yml publishes only on 127.0.0.1, mapping to the container port 5201', () => {
  const ports = publishedPorts(compose);
  assert.equal(ports.length, 1, 'exactly one published port');
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:(\$\{HOST_PORT:-5201\}|\d+):5201$/, `${p} must start with 127.0.0.1: and map to 5201`);
});
test('the parser flags an unbound or wildcard publish', () => {
  for (const bad of ['- "5201:5201"', '- "0.0.0.0:5201:5201"', '- 5201', '- "[::]:5201:5201"']) {
    const ports = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(ports.length, 1);
    assert.doesNotMatch(ports[0], /^127\.0\.0\.1:/);
  }
});
test('the container hardening stays: non-root, read-only, no capabilities, no secrets baked in', () => {
  assert.equal((dockerfile.match(/^FROM node:26-alpine/gm) || []).length, 2, 'both stages are Node 26');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose + dockerfile, /(SECRET|CLIENT_ID|ENV_ID|PASSWORD)\s*[:=]\s*\S/i, 'no tenant value or secret in the container files');
});
test('the container opts in to a non-loopback bind and the compose file does not publish it beyond loopback', () => {
  assert.match(dockerfile, /P1MCP_BIND=0\.0\.0\.0/);
  assert.match(compose, /P1MCP_BIND:\s*0\.0\.0\.0/);
  assert.match(dockerfile, /^ENV P1MCP_CONTAINER=1$/m, 'the image marks itself as the container so the Live bind guard accepts the wide bind');
  assert.match(compose, /P1MCP_CONTAINER:\s*"1"/);
});
test('Live is off in the container unless the owner passes it: the compose default is mock, and the image sets no mode', () => {
  assert.match(compose, /PINGONE_MCP_INSPECTOR_MODE:\s*\$\{PINGONE_MCP_INSPECTOR_MODE:-mock\}/);
  assert.doesNotMatch(dockerfile, /^\s*ENV\b.*PINGONE_MCP_INSPECTOR_MODE/m);
});
test('the compose file is Docker only: no k8s, no host mounts, no docker socket, no host network', () => {
  assert.doesNotMatch(compose, /network_mode|docker\.sock|privileged|\.\.?\//);
  assert.doesNotMatch(compose + dockerfile, /__IMAGE__|__SE_HOST__|kubectl/);
});
