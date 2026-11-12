#!/usr/bin/env node
// Real-browser run of the BUILT app against in-process stubs only: the mock demo connection (an in-process mock of the
// hosted PingOne MCP server) and the mock authorization server behind both the worker and the interactive login. No real
// PingOne tenant is contacted: the server runs under a netguard that records any non-loopback attempt (asserted empty),
// and the browser's requests are checked to stay on loopback. Screenshots go to .data/e2e-screenshots (git-ignored).
//   npm run build && node scripts/e2e.mjs        (E2E_PORT, default 5231; a second server without the Live opt-in runs on E2E_PORT+1)
// Pattern from hostile-mcp scripts/e2e.mjs (same author).
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, '.data', 'e2e-screenshots');
const port = Number(process.env.E2E_PORT) || 5231;
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
// A tiny stub MCP server that serves the poisoned tool list (loopback only), for the scan flow.
const hostileTools = JSON.parse(fs.readFileSync(path.join(root, 'server', 'test', 'fixtures', 'hostile-tools.json'), 'utf8')).tools;
const hostileStub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const m = JSON.parse(b || '{}'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: hostileTools } : {} })); }); });
await new Promise((r) => hostileStub.listen(0, '127.0.0.1', r));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingone-mcp-lab-e2e-'));
// STANDALONE_ENV points at a file that does not exist, so the run never reads the real shared settings file. Live is opted in for the
// first server only (the hostile-stub scan needs a saved Live connection to a loopback stub); the second server has no opt-in.
const missingEnv = path.join(dataDir, 'no-such.env');
const start = (p, extra, sub) => spawn(process.execPath, ['--import', './scripts/e2e-guard.mjs', 'server/src/index.js'], { cwd: root, env: { ...process.env, STANDALONE_ENV: missingEnv, PORT: String(p), P1MCP_DATA_DIR: path.join(dataDir, sub), E2E_GUARD_FILE: path.join(dataDir, `guard-${sub}.json`), ...extra }, stdio: 'ignore' });
delete process.env.PINGONE_MCP_INSPECTOR_MODE;
const server = start(port, { PINGONE_MCP_INSPECTOR_MODE: 'live' }, 'data');
const refusedPort = port + 1;
const refusedServer = start(refusedPort, {}, 'data-refused');
for (const p of [port, refusedPort]) for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${p}/api/health`)).ok) break; } catch { /* not up yet */ } await sleep(250); }
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  const external = []; const bodies = []; const errors = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (!/^(localhost|127\.0\.0\.1)$/.test(u.hostname) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  page.on('response', async (r) => { try { if (r.url().includes('/api/')) bodies.push(await r.text()); } catch { /* redirect or gone */ } });
  // The gate's own answers (401 interactive not signed in, 403 writes off / method refused, 409 confirm needed) log a browser console line by design.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|409)\b/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const go = async (h) => { await page.goto(`${base}/#/${h}`); await page.reload(); };
  const count = async () => Number((await page.getByTestId('tool-count').innerText()).trim());

  // Skip link, first load
  await go('connections');
  await page.keyboard.press('Tab');
  check((await page.evaluate(() => document.activeElement.textContent)) === 'Skip to content', 'the first Tab stop is the skip link');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.activeElement.id) === 'main', 'the skip link moves focus to the main region');
  // Rule 19 default: Real if configured, else Mock. This server has the owner's Live opt-in, so the page opens in Live; press Mock.
  await page.getByTestId('mode').filter({ hasText: 'Mode: live' }).waitFor();
  check((await page.getByTestId('banner').innerText()).startsWith('LIVE mode'), 'with the Live opt-in the page opens in Live (rule 19 default) and the banner says so');
  await page.getByRole('button', { name: 'Mock', exact: true }).click();
  await page.getByTestId('mode').filter({ hasText: 'Mode: mock' }).waitFor();
  check((await page.getByTestId('banner').innerText()).startsWith('MOCK mode, simulated'), 'with no connection the banner says Mock mode');
  check((await page.getByTestId('mode').innerText()) === 'Mode: mock', 'the mode chip says Mode: mock');

  // (a) mock demo worker connection, (b) health card
  await page.getByRole('button', { name: /Add mock demo \(worker/ }).click();
  await page.getByTestId('tool-count').waitFor();
  check((await page.getByTestId('banner').innerText()).includes('not a recording'), 'banner says the catalog is a sample, not a recording');
  check((await page.getByTestId('banner').innerText()).includes('Writes are off'), 'banner says writes are off');
  const viewerCount = await count();
  check(viewerCount === 8, `viewer role sees 8 tools (saw ${viewerCount})`);
  check((await page.getByTestId('health-card').innerText()).includes('missing admin roles'), 'health card carries the role hint');
  check((await page.getByTestId('identity').innerText()).includes('worker token set'), 'identity shows worker token set (no token value)');
  check(/\d+m \d\ds/.test(await page.getByTestId('expiry').innerText()), 'token expiry countdown is shown');
  await shot('1-connections-light');

  // the header toggle exists on every page and Live is allowed on this server
  for (const p of ['connections', 'tools', 'raw', 'audit', 'mcp-first', 'stories', 'diagram']) {
    await go(p);
    check(await page.getByTestId('mode-mock').count() === 1 && await page.getByTestId('mode-live').count() === 1 && (await page.getByTestId('banner').innerText()).startsWith('MOCK mode'), `the Mock / Live toggle, the mode and the banner are on /${p}`);
  }
  await go('connections');

  // (c) tools explorer, viewer
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  await page.getByRole('heading', { name: /^Applications/ }).waitFor();
  check((await page.getByTestId('class-badge').allInnerTexts()).every((t) => t === 'read'), 'viewer sees read tools only');
  check((await page.locator('a', { hasText: 'createUser' }).count()) === 0, 'no write tool is listed for the viewer');
  check(await page.getByRole('heading', { name: /^DaVinci/ }).count() === 1, 'DaVinci group present');
  await page.getByLabel('Search').fill('populations');
  check(await page.locator('.tool').count() === 1, 'search narrows the list');
  await page.getByLabel('Search').fill('');
  await shot('2-tools-viewer');

  // role switch -> admin
  await page.getByRole('link', { name: 'Connections' }).click();
  await page.getByRole('button', { name: 'admin', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="tool-count"]')?.textContent) > 8);
  const adminCount = await count();
  check(adminCount === 21, `admin role sees 21 tools (saw ${adminCount})`);
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  await page.getByRole('heading', { name: /^Users/ }).waitFor();
  const badges = await page.getByTestId('class-badge').allInnerTexts();
  check(badges.includes('write') && badges.includes('destructive'), 'admin list shows write and destructive badges');
  check(await page.getByTestId('writes-off').count() === 1, 'the visible writes-are-off state is shown');
  check(await page.getByText(/unknown verb in the name, so treated as a write/).count() >= 1, 'an unknown verb is explained as treated-as-write');

  // (d) tool page, read
  await page.locator('a', { hasText: /^listUsers$/ }).click();
  const envVal = await page.getByLabel(/^environmentId/).inputValue();
  check(envVal === '11111111-2222-4333-8444-555555555555', 'environmentId is prefilled from the connection');
  await page.getByRole('button', { name: 'JSON' }).click();
  await page.getByLabel(/Arguments \(JSON object\)/).fill('{"environment_id":"x","bogus":1}');
  check((await page.getByTestId('warnings').innerText()).includes('snake_case'), 'snake_case parameter warning shown');
  await page.getByLabel(/Arguments \(JSON object\)/).fill('{"environmentId":"11111111-2222-4333-8444-555555555555"}');
  await page.getByRole('button', { name: 'Form' }).click();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await page.getByTestId('call-view').waitFor();
  const read = await page.getByTestId('call-view').innerText();
  check(read.includes('sample.user') && read.includes('"method": "tools/call"'), 'read call ran directly; request and response shown');
  await shot('3-tool-read');

  // blocked write
  await page.goto(`${base}/#/tool/createUser`);
  await page.getByLabel(/^username/).fill('e2e.user');
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await page.getByRole('heading', { name: /Blocked: writes are off/ }).waitFor();
  check(await page.getByRole('dialog').count() === 0, 'a write with writes off is blocked, no dialog');
  await shot('4-write-blocked');

  // enable writes -> red banner -> confirm
  await page.getByRole('link', { name: 'Connections' }).click();
  await page.getByLabel(/Allow writes for this connection/).click();
  await page.getByText('WRITES ARE ENABLED').waitFor();
  await shot('5-writes-enabled');
  await page.goto(`${base}/#/tool/createUser`);
  await page.getByLabel(/^username/).fill('e2e.user');
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor();
  check((await dlg.getByTestId('confirm-args').innerText()).includes('e2e.user'), 'confirm dialog shows the exact arguments');
  check(/^[0-9a-f]{64}$/.test((await dlg.getByTestId('confirm-hash').innerText()).trim()), 'confirm dialog shows the args hash');
  await shot('6-confirm-write');
  await dlg.getByRole('button', { name: /Confirm and send/ }).click();
  await page.getByTestId('call-view').getByText('e2e.user').first().waitFor();
  check(true, 'confirmed write ran against the fake tenant');

  // destructive typed confirm
  await page.goto(`${base}/#/tool/deleteUser`);
  await page.getByLabel(/^userId/).fill('u2');
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await dlg.waitFor();
  const del = dlg.getByRole('button', { name: /Delete: confirm/ });
  check(await del.isDisabled(), 'destructive confirm is disabled until the name is typed');
  await dlg.getByLabel(/Type/).fill('deleteUse');
  check(await del.isDisabled(), 'a partial name keeps it disabled');
  await dlg.getByLabel(/Type/).fill('deleteUser');
  await shot('7-confirm-destructive');
  await del.click();
  await page.getByTestId('call-view').getByText(/deleted/).first().waitFor();
  check(true, 'typed destructive confirm ran');

  // audit
  await page.getByRole('link', { name: 'Audit' }).click();
  await page.getByTestId('audit-row').first().waitFor();
  const audit = await page.locator('main').innerText();
  check(audit.includes('blocked:writes_disabled') && audit.includes('createUser') && audit.includes('deleteUser') && audit.includes('ok'), 'audit shows the blocked call, the write and the delete');
  await shot('8-audit');

  // scan: the mock is clean, a custom connection to a hostile stub is flagged
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: "Scan this server's tools" }).click();
  await page.getByTestId('scan-summary').waitFor();
  check((await page.getByTestId('scan-summary').innerText()) === 'No findings', 'scan of the PingOne mock finds nothing');
  await shot('8a-scan-clean');
  await page.evaluate(async (url) => { await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'custom', label: 'hostile stub', url }) }); }, `http://127.0.0.1:${hostileStub.address().port}/mcp`);
  await page.getByRole('link', { name: 'Connections' }).click();
  await page.reload();
  await page.getByTestId('mode-live').click();
  // The toggle POSTs /api/mode and then reloads the data, so wait for the switch to land before checking it.
  await page.getByTestId('mode').filter({ hasText: 'Mode: live' }).waitFor({ timeout: 10_000 }).catch(() => {});
  await page.locator('[data-testid="conn-card"]', { hasText: 'Mock demo' }).first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  check((await page.getByTestId('mode').innerText()) === 'Mode: live' && (await page.getByTestId('banner').innerText()).startsWith('LIVE mode'), 'pressing Live (allowed here) shows Mode: live and the LIVE banner');
  check(await page.locator('[data-testid="conn-card"]', { hasText: 'Mock demo' }).count() === 0, 'in Live the mock demo is not listed');
  const useIt = async (card) => { const b = card.getByRole('button', { name: 'Use this connection' }); if (await b.count()) await b.click(); }; // the first connection of a mode is already in use
  await useIt(page.locator('[data-testid="conn-card"]', { hasText: 'hostile stub' }));
  check((await page.locator('[data-testid="conn-card"]', { hasText: 'hostile stub' }).getByRole('button', { name: 'In use' }).count()) === 1, 'the Live connection is in use');
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: "Scan this server's tools" }).click();
  await page.getByTestId('scan-findings').waitFor();
  const flagged = await page.getByTestId('scan-result').innerText();
  check(/MT-HI-001/.test(flagged) && /MT-EX-001/.test(flagged) && /high/.test(flagged), 'scan of the hostile stub flags hidden instructions and an off-box default');
  check(await page.locator('[data-testid="scan-result"] img, [data-testid="scan-result"] important').count() === 0, 'poisoned text is shown as inert text');
  await shot('8b-scan-hostile');
  await page.getByTestId('mode-mock').click();
  await page.getByTestId('mode').filter({ hasText: 'Mode: mock' }).waitFor({ timeout: 10_000 }).catch(() => {});
  check((await page.getByTestId('mode').innerText()) === 'Mode: mock', 'pressing Mock goes back');
  await page.getByRole('link', { name: 'Connections' }).click();
  await useIt(page.locator('[data-testid="conn-card"]', { hasText: /Mock demo|offline/i }).first());

  // raw console
  await page.getByRole('link', { name: 'Raw JSON-RPC' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByTestId('call-view').getByText(/listApplications/).first().waitFor();
  await page.getByLabel(/^Method/).fill('tools/call');
  await page.getByLabel(/Params/).fill('{"name":"disableUser","arguments":{"environmentId":"11111111-2222-4333-8444-555555555555","userId":"u1"}}');
  await page.getByRole('button', { name: 'Send' }).click();
  await dlg.waitFor();
  check(true, 'raw tools/call goes through the confirm gate');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.getByLabel(/^Method/).fill('sampling/createMessage');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('alert').getByText(/method_not_allowed/).waitFor();
  check(true, 'a non-free raw method is refused');
  await shot('9-raw');

  // MCP-first, stories, diagram
  await page.getByRole('link', { name: 'MCP first' }).click();
  await page.getByRole('heading', { name: /MCP first, Management API second/ }).waitFor();
  check(await page.getByText(/UNVERIFIED externally/).count() >= 1, 'MCP-first card labels itself UNVERIFIED externally');
  await page.getByRole('link', { name: 'Stories' }).click();
  await page.getByText('Why do I only see twelve tools?').waitFor();
  await page.getByLabel('Vertical').first().selectOption('banking');
  check((await page.locator('main').innerText()).includes('the bank'), 'banking pack re-skins the story');
  await shot('10-stories');
  await page.getByRole('link', { name: 'Diagram' }).click();
  await page.locator('.react-flow__node').first().waitFor();
  check(await page.locator('.react-flow__node').count() === 5, 'diagram has five boxes');
  const node = page.locator('.react-flow__node').nth(1);
  const before = await node.boundingBox();
  await page.mouse.move(before.x + 20, before.y + 20); await page.mouse.down(); await page.mouse.move(before.x + 20, before.y + 120, { steps: 8 }); await page.mouse.up();
  const after = await node.boundingBox();
  check(Math.abs(after.y - before.y) > 40, 'a box can be dragged');
  await page.getByLabel('Speed').selectOption('4');
  await page.getByRole('button', { name: 'Simulate' }).click();
  await page.getByTestId('caption').getByText(/Step 5 of 5/).waitFor({ timeout: 8000 });
  await shot('11-diagram');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  let reset = null; // Reset remounts the flow (positions and pan/zoom), so wait for the box to be laid out again
  for (let i = 0; i < 40; i++) { reset = await node.boundingBox().catch(() => null); if (reset && Math.abs(reset.y - before.y) < 6) break; await page.waitForTimeout(100); }
  check(!!reset && Math.abs(reset.y - before.y) < 6 && (await page.getByTestId('caption').innerText()).includes('Press Simulate'), 'Reset restores the box and the caption');
  await page.getByRole('button', { name: 'Present' }).click();
  check(await page.evaluate(() => document.documentElement.dataset.present) === '1', 'presenter mode turns on');
  await page.keyboard.press('Escape');

  // interactive login against the stub AS, browser follows the redirect and back
  await page.getByRole('link', { name: 'Connections' }).click();
  await page.getByRole('button', { name: /Add mock demo with sign-in/ }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/login=|#/, { timeout: 8000 }).catch(() => {});
  await page.getByTestId('tool-count').waitFor({ timeout: 8000 });
  check((await page.getByTestId('identity').innerText()).includes('signed in as mock-admin-user'), 'interactive: back from the stub AS, signed in as <sub>');
  check(!page.url().includes('code=') && !page.url().includes('login='), 'the callback query is cleaned from the address bar');
  check((await page.locator('[data-testid="conn-card"]').last().innerText()).includes('Sign out'), 'a Sign out button replaces Sign in');
  await shot('12-interactive');
  await page.getByRole('button', { name: /^Sign out/ }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  check(true, 'logout clears the session (Sign in is offered again)');

  // the header Reset: audit cleared, connections kept
  await page.getByTestId('reset').click();
  await page.getByTestId('live').getByText(/^Reset:/).waitFor();
  await go('audit');
  check(await page.getByTestId('audit-row').count() === 0, 'Reset cleared the audit history');
  await go('connections');
  check(await page.locator('[data-testid="conn-card"]').count() >= 1, 'Reset kept the saved connections');

  // a second server without the Live opt-in: the Live (Real) button is disabled with the reason, and the page stays in Mock
  const refusedPage = await ctx.newPage();
  const refusedBase = `http://localhost:${refusedPort}`;
  await refusedPage.goto(`${refusedBase}/#/connections`);
  await refusedPage.waitForFunction(() => document.querySelector('[data-testid="mode-live"]')?.title?.length > 0);
  const refusedTitle = (await refusedPage.getByTestId('mode-live').getAttribute('title')) || '';
  check(await refusedPage.getByTestId('mode-live').isDisabled() && refusedTitle.includes('owner-opt-in') && (await refusedPage.getByTestId('mode').innerText()) === 'Mode: mock', 'without the opt-in, Live is disabled with the reason and the page stays in Mock');
  const refusedInfo = await (await fetch(`${refusedBase}/api/info`)).json();
  const liveTry = await fetch(`${refusedBase}/api/connections`, { method: 'POST', headers: { 'content-type': 'application/json', origin: refusedBase }, body: JSON.stringify({ kind: 'custom', url: 'http://127.0.0.1:9/mcp' }) });
  check(refusedInfo.live.available === false && liveTry.status === 403, 'the API agrees: /api/info says Live is unavailable and a Live connection is refused (403)');
  await refusedPage.close();

  // a11y (axe) on each page, light then dark
  for (const p of ['connections', 'tools', 'audit', 'raw', 'mcp-first', 'stories', 'diagram']) {
    await go(p); await page.waitForTimeout(400);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    check(r.violations.length === 0, `axe light /${p}: ${r.violations.map((v) => `${v.id}(${v.nodes.length})`).join(', ') || 'no violations'}`);
  }
  await page.getByLabel('Theme').selectOption('dark');
  for (const p of ['connections', 'tools', 'stories']) {
    await go(p); await page.waitForTimeout(400);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    check(r.violations.length === 0, `axe dark /${p}: ${r.violations.map((v) => `${v.id}(${v.nodes.length})`).join(', ') || 'no violations'}`);
  }
  await go('connections'); await shot('13-connections-dark');
  await go('tools'); await shot('14-tools-dark');
  await page.getByLabel('Theme').selectOption('light');

  // narrow
  await page.setViewportSize({ width: 390, height: 800 });
  for (const p of ['connections', 'tools', 'audit', 'diagram']) {
    await go(p); await page.waitForTimeout(300);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal page scroll at 390px on /${p}`);
    await shot(`15-narrow-${p}`);
  }

  // secrets and tokens never reached the browser; nothing left loopback
  const all = bodies.join('\n') + await page.content();
  check(!/mock-at-|mock-rt-|demo-secret/.test(all), 'no token or client secret in any API body or the page');
  check(external.length === 0, `the browser made no non-loopback request (${external.length})`);
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  refusedServer.kill('SIGTERM');
  hostileStub.close();
  await sleep(500);
}
for (const sub of ['data', 'data-refused']) {
  let attempts = ['guard file missing'];
  try { attempts = JSON.parse(fs.readFileSync(path.join(dataDir, `guard-${sub}.json`), 'utf8')); } catch { /* keep the marker */ }
  check(Array.isArray(attempts) && attempts.length === 0, `the ${sub} server made zero non-loopback connection attempts (${JSON.stringify(attempts)})`);
}
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
