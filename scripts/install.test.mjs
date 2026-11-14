// install.sh pins: safe to pipe into bash, stops cleanly with no Docker or Node 26, and the docs show the same one-liner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = new URL('../install.sh', import.meta.url).pathname;
const src = fs.readFileSync(script, 'utf8');
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ONE_LINER = 'curl -fsSL https://raw.githubusercontent.com/curtismu7/mfa-admin-mcp-LAB/main/install.sh | bash';
const which = (name) => spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();

test('install.sh is executable, parses, stops on errors, and runs only from its last line so a truncated download runs nothing', () => {
  assert.ok(fs.statSync(script).mode & 0o111, 'executable bit');
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'bash -n');
  assert.match(src, /^set -euo pipefail$/m);
  assert.equal(src.trimEnd().split('\n').pop(), 'main "$@"');
  assert.doesNotMatch(src, /\bsudo\b|rm -rf/, 'no privilege escalation, no recursive delete');
});

test('with no Docker and no Node 26 it stops with a message and creates nothing', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mfaadm-bin-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mfaadm-work-'));
  try {
    for (const tool of ['curl', 'tar']) fs.symlinkSync(which(tool), path.join(bin, tool));
    const r = spawnSync('/bin/bash', [script], { cwd: work, env: { PATH: bin }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Docker/);
    assert.match(r.stderr, /Node 26/);
    assert.deepEqual(fs.readdirSync(work), [], 'nothing downloaded or created');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a HOST_PORT that is not a number is refused before anything runs', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mfaadm-work-'));
  try {
    const r = spawnSync('/bin/bash', [script], { cwd: work, env: { PATH: process.env.PATH, HOST_PORT: '78;15' }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /HOST_PORT must be a number/);
    assert.deepEqual(fs.readdirSync(work), []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('the README and HANDOFF show the one-line install, and it names this repo\'s own script', () => {
  assert.ok(src.includes(ONE_LINER), 'the script header');
  assert.ok(read('README.md').includes(ONE_LINER), 'README');
  assert.ok(read('HANDOFF.md').includes(ONE_LINER), 'HANDOFF');
});
