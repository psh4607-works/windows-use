import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';
import { waitFor } from '../src/wait-for.mjs';

test('access epochs change on pause-resume and restart without exposing broker credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-wait-epoch-'));
  let desktop = await startDesktop({ directory, handler: async () => ({}) });
  try {
    const before = await requestDesktop({ command: 'status' }, { directory });
    assert.equal(typeof before.accessEpoch, 'string');
    await desktop.setPaused(true); await desktop.setPaused(false);
    assert.notEqual((await requestDesktop({ command: 'status' }, { directory })).accessEpoch, before.accessEpoch);
    await desktop.close();
    desktop = await startDesktop({ directory, handler: async () => ({}) });
    assert.notEqual(desktop.status().accessEpoch, before.accessEpoch);
    assert.equal(desktop.status().token, undefined);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a wait releases the broker between polls so other reads and pause can complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-wait-fairness-'));
  let enteredSleep, releaseSleep;
  const sleeping = new Promise(resolve => { enteredSleep = resolve; });
  const desktop = await startDesktop({ directory, handler: async request => {
    if (request.command === 'windows') return { windows: [{ id: 123 }] };
    if (request.command === 'query') return { snapshot: { window: { id: 123 } }, query: { matches: [], matchCount: 0, unique: false, complete: true } };
    if (request.command === 'apps') return { apps: [] };
    assert.fail('wait sent an input command');
  } });
  let pending;
  try {
    pending = waitFor({ command: 'wait-for', session: 'wait', params: { app: 'fixture', name: 'Ready' } }, {
      read: (request, options) => requestDesktop(request, { ...options, directory }),
      sleep: () => { enteredSleep(); return new Promise(resolve => { releaseSleep = resolve; }); }
    });
    const rejected = assert.rejects(pending, error => error.code === 'desktop_paused');
    await sleeping;
    assert.equal((await requestDesktop({ command: 'status' }, { directory })).activeRequests, 0);
    assert.deepEqual(await requestDesktop({ command: 'apps' }, { directory }), { apps: [] });
    await desktop.setPaused(true);
    releaseSleep();
    await rejected;
  } finally { releaseSleep?.(); await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});
