import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDesktop } from '../src/desktop.mjs';
const cli = fileURLToPath(new URL('../bin/windows-use.mjs', import.meta.url));
test('installed CLI exposes help without requiring Orca or a Windows desktop', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /windows-use/);
  assert.match(result.stdout, /--host/);
});

test('doctor uses exit status to distinguish a working desktop from a paused desktop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-cli-doctor-'));
  const desktop = await startDesktop({ directory, handler: async () => ({ apps: [] }) });
  const run = () => promisify(execFile)(process.execPath, [cli, 'doctor'], { env: { ...process.env, WINDOWS_USE_HOME: directory } });
  try {
    assert.equal(JSON.parse((await run()).stdout).result.desktop.ok, true);
    await desktop.setPaused(true);
    await assert.rejects(run(), error => error.code === 1 && JSON.parse(error.stdout).result.desktop.ok === false);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});
test('RPC rejects unknown operations with structured JSON and a nonzero exit', () => {
  const result = spawnSync(process.execPath, [cli, 'rpc'], { encoding: 'utf8', input: JSON.stringify({ command: 'delete-everything' }) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\{/, 'RPC must return structured JSON');
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.match(response.error.message, /Unknown command/);
});

test('doctor retains installation identity when the desktop registration is absent, including RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-no-server-'));
  try {
    for (const rpc of [false, true]) {
      const result = spawnSync(process.execPath, [cli, rpc ? 'rpc' : 'doctor'], {
        encoding: 'utf8', env: { ...process.env, WINDOWS_USE_HOME: directory },
        input: rpc ? JSON.stringify({ command: 'doctor' }) : undefined
      });
      const body = JSON.parse(result.stdout);
      assert.equal(body.ok, true, 'diagnostic response must survive a missing desktop');
      assert.equal(body.result.desktop.ok, false);
      assert.equal(body.result.identities.installation.integrity, 'verified');
      assert.equal(result.status, rpc ? 0 : 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
