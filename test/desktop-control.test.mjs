import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';

test('pause rejects desktop requests while status remains readable and resume restores access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-pause-'));
  let calls = 0;
  const desktop = await startDesktop({ directory, handler: async () => ({ calls: ++calls }) });
  try {
    assert.equal(typeof desktop.setPaused, 'function', 'desktop owner must support pause');
    await desktop.setPaused(true);
    for (const command of ['apps', 'snapshot', 'set-value']) {
      await assert.rejects(requestDesktop({ command }, { directory }), error => error.code === 'desktop_paused');
    }
    const status = await requestDesktop({ command: 'status' }, { directory });
    assert.equal(status.state, 'paused');
    assert.equal(status.activeRequests, 0);
    assert.equal(status.token, undefined);
    assert.equal(status.endpoint, undefined);
    assert.equal(calls, 0);
    await desktop.setPaused(false);
    assert.deepEqual(await requestDesktop({ command: 'apps' }, { directory }), { calls: 1 });
    await assert.rejects(requestDesktop({ command: 'resume' }, { directory }), /Unknown command/);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('managed restart reclaims a dead registration but never overwrites a live owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-recover-'));
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.once('exit', resolve));
  const config = { endpoint: 'old-unused-endpoint', token: 'old-token', pid: dead.pid };
  await writeFile(join(directory, 'server.json'), JSON.stringify(config));
  await writeFile(join(directory, 'recovery.lock'), 'abandoned by a killed recovery process');
  let desktop;
  try {
    desktop = await startDesktop({ directory, recoverStale: true, handler: async () => ({}),
      acquireRecovery: async () => async () => {} }).catch(error => ({ error }));
    assert.equal(typeof desktop.close, 'function', 'managed restart must recover a confirmed-dead owner');
    const owned = await readFile(join(directory, 'server.json'), 'utf8');
    await assert.rejects(startDesktop({ directory, recoverStale: true }), /existing|owner/i);
    assert.equal(await readFile(join(directory, 'server.json'), 'utf8'), owned);
  } finally { if (desktop?.close) await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt owner registration is preserved and reports how to recover safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-corrupt-owner-'));
  const path = join(directory, 'server.json');
  try {
    await writeFile(path, '{"pid":');
    await assert.rejects(startDesktop({ directory, recoverStale: true }), error => {
      assert.ok(error.message.includes(path));
      assert.match(error.message, /Close.*Windows Use.*back up/i);
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), '{"pid":');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('doctor verifies desktop enumeration and reports a paused desktop without attempting UI access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-doctor-'));
  let calls = 0;
  const desktop = await startDesktop({ directory, handler: async request => { assert.equal(request.command, 'apps'); calls++; return { apps: [{ id: 1 }] }; } });
  try {
    const result = await requestDesktop({ command: 'doctor' }, { directory }).catch(error => ({ error: error.message }));
    assert.equal(result.desktop?.ok, true, 'doctor must exercise the desktop provider');
    assert.equal(calls, 1);
    await desktop.setPaused(true);
    const paused = await requestDesktop({ command: 'doctor' }, { directory });
    assert.equal(paused.desktop.ok, false);
    assert.equal(paused.state, 'paused');
    assert.equal(calls, 1);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pause invalidates saved observations and a new desktop cannot reuse a previous owner observation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-observations-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir);
  await writeFile(join(stateDir, 'old-session.json'), '{}');
  let desktop;
  try {
    desktop = await startDesktop({ directory, handler: async () => ({}) });
    assert.deepEqual(await readdir(stateDir), [], 'starting an owner must invalidate old observations');
    await writeFile(join(stateDir, 'session.json'), '{}');
    await desktop.setPaused(true);
    await desktop.setPaused(false);
    assert.deepEqual(await readdir(stateDir), [], 'resume requires a new snapshot');
  } finally { await desktop?.close(); await rm(directory, { recursive: true, force: true }); }
});
