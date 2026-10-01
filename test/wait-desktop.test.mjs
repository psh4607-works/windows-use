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

test('tracked reads stamp access epochs and reject stale epochs before touching the desktop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-read-epoch-'));
  let calls = 0;
  const desktop = await startDesktop({ directory, handler: async () => { calls++; return { windows: [] }; } });
  try {
    const request = { command: 'windows', trackAccess: true, params: { app: 'fixture' } };
    const first = await requestDesktop(request, { directory });
    assert.equal(first.accessEpoch, desktop.status().accessEpoch);
    await desktop.setPaused(true); await desktop.setPaused(false);
    await assert.rejects(requestDesktop({ ...request, accessEpoch: first.accessEpoch }, { directory }), error => error.code === 'desktop_paused');
    assert.equal(calls, 1);
    await assert.rejects(requestDesktop({ command: 'press-key', trackAccess: true }, { directory }), error => error.code === 'invalid_wait');
    for (const restoreWindow of [true, 1, 'yes', 'false', {}, null]) {
      await assert.rejects(requestDesktop({ command: 'snapshot', trackAccess: true, params: { restoreWindow } }, { directory }), error => error.code === 'invalid_wait');
    }
    assert.equal(calls, 1);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('tracked reads retain their epoch while an app is absent and reject pause during a read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-read-paused-'));
  let entered, release;
  const reading = new Promise(resolve => { entered = resolve; });
  const desktop = await startDesktop({ directory, handler: async request => {
    if (request.command === 'windows') throw Object.assign(new Error('missing fixture'), { code: 'app_not_found' });
    entered(); await new Promise(resolve => { release = resolve; });
    return { snapshot: { window: { id: 123 } } };
  } });
  try {
    const absent = await requestDesktop({ command: 'windows', trackAccess: true }, { directory });
    assert.deepEqual(absent.windows, []);
    assert.equal(absent.accessEpoch, desktop.status().accessEpoch);
    const pending = requestDesktop({ command: 'snapshot', trackAccess: true, accessEpoch: absent.accessEpoch }, { directory });
    const rejected = assert.rejects(pending, error => error.code === 'desktop_paused');
    await reading;
    const paused = desktop.setPaused(true);
    release(); await paused; await rejected;
  } finally { release?.(); await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a supported server reports mid-wait app disappearance as window_closed through real IPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-app-disappearance-'));
  let absent = false, windowReads = 0, queryReads = 0;
  const desktop = await startDesktop({ directory, handler: async request => {
    if (request.command === 'windows') {
      windowReads++;
      if (absent) throw Object.assign(new Error('fixture app not found'), { code: 'app_not_found' });
      return { windows: [{ id: 123 }] };
    }
    assert.equal(request.command, 'query'); queryReads++;
    return { snapshot: { window: { id: 123 } }, query: { matches: [], matchCount: 0, unique: false, complete: true } };
  } });
  try {
    await assert.rejects(waitFor({ command: 'wait-for', session: 'repro', params: { app: 'fixture', name: 'Ready' } }, {
      read: (request, options) => requestDesktop(request, { ...options, directory }),
      sleep: async () => { absent = true; }
    }), error => error.code === 'window_closed' && !/Update/.test(error.message));
    assert.equal(windowReads, 2); assert.equal(queryReads, 1);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('desktop inventory baselines survive input and reject foreign sessions and resumed desktop epochs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-inventory-'));
  let windows = [{ id: 1, app: { pid: 42 }, processInstance: 'start' }];
  const desktop = await startDesktop({ directory, handler: async request => request.command === 'windows' ? { windows, complete: true, observationErrors: [] } : {} });
  const read = request => requestDesktop(request, { directory });
  try {
    const baseline = await read({ command: 'windows', session: 'task', params: { all: true } });
    assert.equal(typeof baseline.inventory?.token, 'string');
    await read({ command: 'invoke', session: 'task', params: { app: 'fixture' } });
    windows = [...windows, { id: 2, app: { pid: 43 }, processInstance: 'new' }];
    const req = { command: 'windows', session: 'task', params: { all: true, afterInventory: baseline.inventory.token } };
    assert.deepEqual((await read(req)).windows.map(window => window.id), [2]);
    await assert.rejects(read({ ...req, session: 'other' }), error => error.code === 'invalid_inventory');
    await desktop.setPaused(true); await desktop.setPaused(false);
    await assert.rejects(read(req), error => error.code === 'invalid_inventory');
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('desktop inventory refuses incomplete baseline and later incomplete discovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-inventory-incomplete-'));
  let result = { windows: [], complete: false, observationErrors: [{ kind: 'enumeration' }] };
  const desktop = await startDesktop({ directory, handler: async () => result });
  const req = { command: 'windows', session: 'task', params: { all: true } };
  const read = request => requestDesktop(request, { directory });
  try {
    await assert.rejects(read(req), error => error.code === 'incomplete_observation');
    result = { windows: [], complete: true, observationErrors: [] };
    const baseline = await read(req);
    result = { windows: [], complete: false, observationErrors: [] };
    await assert.rejects(read({ ...req, params: { all: true, afterInventory: baseline.inventory.token } }), error => error.code === 'incomplete_observation');
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('inventory wait crosses process boundary through real broker without adopting old or unrelated windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-inventory-transition-'));
  const old = { id: 1, title: 'Destination', app: { pid: 42, name: 'Original' }, processInstance: 'first' };
  const destination = { id: 3, title: 'Destination', app: { pid: 44, name: 'Target' }, processInstance: 'third' };
  let windows = [old];
  const inputs = [];
  const desktop = await startDesktop({ directory, handler: async request => {
    if (request.command === 'windows') return { windows, complete: true, observationErrors: [] };
    if (request.command === 'invoke') { inputs.push(request); windows = [old, { ...old, id: 2, title: 'Unrelated', app: { pid: 43 }, processInstance: 'second' }, destination]; return {}; }
    assert.equal(request.command, 'snapshot');
    assert.equal(request.params.app, '44');
    assert.equal(request.params.windowId, 3);
    return { snapshot: { app: { pid: 44 }, window: { id: 3, title: 'Destination' }, processInstance: 'third' }, session: { id: 'task', observation: 'destination-token' } };
  } });
  const read = (request, options) => requestDesktop(request, { ...options, directory });
  try {
    const baseline = await read({ command: 'windows', session: 'task', params: { all: true } });
    await read({ command: 'invoke', session: 'task', params: { app: 'pid:42' } });
    const result = await waitFor({ command: 'wait-for', session: 'task', params: { condition: 'window', afterInventory: baseline.inventory.token, windowTitle: 'Destination' } }, { read });
    assert.equal(result.snapshot.app.pid, 44);
    assert.equal(result.session.observation, 'destination-token');
    assert.equal(inputs.length, 1);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('discovered window token can act immediately using the returned numeric PID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-inventory-action-'));
  const stateDir = join(directory, 'state');
  let windows = [], actions = 0;
  const { executeRequest } = await import('../src/request.mjs');
  const providerFactory = () => ({ snapshots: new Map(),
    async listWindows() { return { windows, complete: true, observationErrors: [] }; },
    async snapshot(params) {
      this.snapshots.set(params.app, { windowId: 3, app: { pid: 44 }, processInstance: 'started', elements: [] });
      return { snapshot: { app: { pid: 44 }, window: { id: 3, title: 'Destination' }, processInstance: 'started' } };
    },
    async action() { actions++; return { snapshot: null, action: { verification: { state: 'unverified' } } }; }, shutdown() {} });
  const desktop = await startDesktop({ directory, handler: request => executeRequest(request, { stateDir, providerFactory }) });
  const read = (request, options) => requestDesktop(request, { ...options, directory });
  try {
    const baseline = await read({ command: 'windows', session: 'task', params: { all: true } });
    windows = [{ id: 3, title: 'Destination', app: { pid: 44 }, processInstance: 'started' }];
    const found = await waitFor({ command: 'wait-for', session: 'task', params: { condition: 'window', afterInventory: baseline.inventory.token, windowTitle: 'Destination' } }, { read });
    await read({ command: 'press-key', session: 'task', observation: found.session.observation,
      params: { app: String(found.snapshot.app.pid), windowId: found.snapshot.window.id, key: 'Enter' } });
    assert.equal(actions, 1);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});
