import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, access, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';
import { loadSettings, saveSettings } from '../src/settings.mjs';
import { callBroker } from '../src/broker.mjs';

// Force a real filesystem failure in observation cleanup without replacing
// setPaused. Existing authenticated clients can still reach the IPC listener.
function createStateDirectoryBlocker(directory) {
  const moved = `${directory}.moved`;
  let wasMoved = false;
  return { moved, config: null,
    async block() {
      this.config = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8'));
      await rename(directory, moved);
      wasMoved = true;
      await writeFile(directory, 'Not a directory');
      if (process.platform !== 'win32') this.config.endpoint = join(moved, 'desktop.sock');
    },
    async restore() {
      if (!wasMoved) return;
      await rm(directory, { force: true });
      await rename(moved, directory);
      wasMoved = false;
    }
  };
}

test('tray host persists pause, handles commands, and shuts down the broker on parent EOF', async () => {
  const module = await import('../src/managed-host.mjs').catch(() => ({}));
  assert.equal(typeof module.runManagedHost, 'function', 'tray host lifecycle is required');
  const directory = await mkdtemp(join(tmpdir(), 'wu-managed-'));
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  let run;
  try {
    run = module.runManagedHost({ directory, input, output,
      start: options => startDesktop({ ...options, handler: async () => ({ apps: [] }) }) });
    const ready = JSON.parse((await lines.next()).value);
    assert.equal(ready.event, 'ready');
    assert.equal(ready.result.status.state, 'running');
    input.write(JSON.stringify({ id: 1, command: 'pause' }) + '\n');
    const paused = JSON.parse((await lines.next()).value);
    assert.equal(paused.id, 1);
    assert.equal(paused.result.status.state, 'paused');
    assert.equal((await loadSettings(directory)).paused, true);
    await assert.rejects(requestDesktop({ command: 'apps' }, { directory }), /paused/i);
    input.write(JSON.stringify({ id: 2, command: 'resume' }) + '\n');
    assert.equal(JSON.parse((await lines.next()).value).result.status.state, 'running');
    assert.equal((await loadSettings(directory)).paused, false);
    input.end();
    await run;
    await assert.rejects(access(join(directory, 'server.json')), { code: 'ENOENT' });
  } finally { input.end(); await run; output.end(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed pause save still revokes the real desktop and can be explicitly resumed', async () => {
  const { runManagedHost } = await import('../src/managed-host.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-pause-save-failure-'));
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  const run = runManagedHost({ directory, input, output,
    save: async (path, settings) => {
      if (settings.paused) throw new Error('Disk full');
      return saveSettings(path, settings);
    },
    start: options => startDesktop({ ...options, handler: async () => ({ apps: [] }) })
  });
  try {
    await lines.next();
    input.write(JSON.stringify({ id: 1, command: 'pause' }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.ok, false);
    await assert.rejects(requestDesktop({ command: 'apps' }, { directory }), error => error.code === 'desktop_paused');
    assert.match(reply.error.message, /Disk full/);
    assert.match(reply.error.message, /restart.*resume/i);
    input.write(JSON.stringify({ id: 2, command: 'status' }) + '\n');
    const status = JSON.parse((await lines.next()).value).result;
    assert.equal(status.settings.paused, true);
    assert.equal(status.status.state, 'paused');
    input.write(JSON.stringify({ id: 3, command: 'resume' }) + '\n');
    assert.equal(JSON.parse((await lines.next()).value).result.status.state, 'running');
    assert.deepEqual(await requestDesktop({ command: 'apps' }, { directory }), { apps: [] });
  } finally { input.end(); await run; output.end(); await rm(directory, { recursive: true, force: true }); }
});

test('failed resume compensation preserves the original failure message', async () => {
  const { runManagedHost } = await import('../src/managed-host.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-rollback-failure-'));
  await saveSettings(directory, { ...await loadSettings(directory), paused: true });
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  const run = runManagedHost({ directory, input, output,
    save: async () => { throw new Error('Disk full'); },
    start: async () => ({ status: () => ({ state: 'paused' }), close: async () => {},
      setPaused: async value => { if (value) throw new Error('Observation cleanup failed'); } })
  });
  try {
    await lines.next();
    input.write(JSON.stringify({ id: 1, command: 'resume' }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /Disk full/);
    assert.match(reply.error.message, /Observation cleanup failed/);
    assert.equal((await loadSettings(directory)).paused, true);
  } finally { input.end(); await run; output.end(); await rm(directory, { recursive: true, force: true }); }
});

for (const saveFails of [false, true]) {
  test(`real pause cleanup failure still revokes IPC (save also fails: ${saveFails})`, async () => {
    const { runManagedHost } = await import('../src/managed-host.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'wu-pause-cleanup-failure-'));
    const input = new PassThrough(), output = new PassThrough();
    const lines = createInterface({ input: output })[Symbol.asyncIterator]();
    let blocked;
    const run = runManagedHost({ directory, input, output,
      save: async (path, settings) => {
        if (!saveFails) await saveSettings(path, settings);
        // Retain both owned paths before any filesystem mutation can fail.
        blocked = createStateDirectoryBlocker(path);
        await blocked.block();
        if (saveFails) throw new Error('Disk full');
        return settings;
      },
      start: options => startDesktop({ ...options, handler: async () => ({ apps: [] }) })
    });
    try {
      await lines.next();
      input.write(JSON.stringify({ id: 1, command: 'pause' }) + '\n');
      const reply = JSON.parse((await lines.next()).value);
      assert.equal(reply.ok, false, 'real observation cleanup must fail');
      if (saveFails) assert.match(reply.error.message, /Disk full; Pausing also failed:/);
      assert.ok(reply.error.message.includes(directory), 'cleanup failure must identify the blocked state directory');
      assert.match(reply.error.message, /\b(?:ENOTDIR|ENOENT|EPERM|EACCES|EBUSY)\b/, 'failure must be a filesystem error');
      await assert.rejects(callBroker({ command: 'apps' }, blocked.config), error => error.code === 'desktop_paused');
      input.write(JSON.stringify({ id: 2, command: 'status' }) + '\n');
      const view = JSON.parse((await lines.next()).value).result;
      assert.equal(view.status.state, 'paused');
      assert.equal(view.settings.paused, true);
    } finally {
      try { await blocked?.restore(); }
      finally {
        input.end();
        try { await run; }
        finally {
          output.end();
          await Promise.all([directory, blocked?.moved].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
        }
      }
    }
  });
}

test('real resume rollback cleanup failure still revokes previously granted IPC access', async () => {
  const { runManagedHost } = await import('../src/managed-host.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-real-rollback-failure-'));
  await saveSettings(directory, { ...await loadSettings(directory), paused: true });
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  let blocked;
  const run = runManagedHost({ directory, input, output,
    save: async path => { blocked = createStateDirectoryBlocker(path); await blocked.block(); throw new Error('Disk full'); },
    start: options => startDesktop({ ...options, handler: async () => ({ apps: [] }) })
  });
  try {
    await lines.next();
    input.write(JSON.stringify({ id: 1, command: 'resume' }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /Disk full; Restoring pause also failed:/);
    assert.ok(reply.error.message.includes(directory), 'cleanup failure must identify the blocked state directory');
    assert.match(reply.error.message, /\b(?:ENOTDIR|ENOENT|EPERM|EACCES|EBUSY)\b/, 'failure must be a filesystem error');
    await assert.rejects(callBroker({ command: 'apps' }, blocked.config), error => error.code === 'desktop_paused');
    assert.equal((await loadSettings(blocked.moved)).paused, true);
    input.write(JSON.stringify({ id: 2, command: 'status' }) + '\n');
    const view = JSON.parse((await lines.next()).value).result;
    assert.equal(view.status.state, 'paused');
    assert.equal(view.settings.paused, true);
  } finally {
    try { await blocked?.restore(); }
    finally {
      input.end();
      try { await run; }
      finally {
        output.end();
        await Promise.all([directory, blocked?.moved].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
      }
    }
  }
});

test('a new tray process honors a saved pause before accepting any desktop request', async () => {
  const { runManagedHost } = await import('../src/managed-host.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-persist-'));
  const settings = await loadSettings(directory);
  await saveSettings(directory, { ...settings, paused: true });
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  const run = runManagedHost({ directory, input, output,
    start: options => startDesktop({ ...options, handler: async () => { throw new Error('Must not reach the desktop'); } }) });
  try {
    assert.equal(JSON.parse((await lines.next()).value).result.status.state, 'paused');
    await assert.rejects(requestDesktop({ command: 'apps' }, { directory }), error => error.code === 'desktop_paused');
  } finally { input.end(); await run; output.end(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed resume never persists permission to run on the next launch', async () => {
  const { runManagedHost } = await import('../src/managed-host.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-resume-failure-'));
  await saveSettings(directory, { ...await loadSettings(directory), paused: true });
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  const run = runManagedHost({ directory, input, output, start: async () => ({
    status: () => ({ state: 'paused' }),
    setPaused: async value => { if (!value) throw new Error('Cannot clear previous observations'); },
    close: async () => {}
  }) });
  try {
    await lines.next();
    input.write(JSON.stringify({ id: 1, command: 'resume' }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.ok, false);
    assert.equal((await loadSettings(directory)).paused, true, 'a failed resume must remain paused on disk');
  } finally { input.end(); await run; output.end(); await rm(directory, { recursive: true, force: true }); }
});

test('pause persists before applying and failed resume persistence rolls back access', async () => {
  const { runManagedHost } = await import('../src/managed-host.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-state-order-'));
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  let state = 'running';
  const events = [];
  const run = runManagedHost({ directory, input, output,
    save: async (path, settings) => {
      events.push(`persist:${settings.paused}`);
      if (!settings.paused) throw new Error('Disk full');
      return saveSettings(path, settings);
    },
    start: async () => ({
      status: () => ({ state }),
      setPaused: async value => { events.push(`access:${value}`); state = value ? 'paused' : 'running'; },
      close: async () => {}
    })
  });
  try {
    await lines.next();
    input.write(JSON.stringify({ id: 1, command: 'pause' }) + '\n');
    assert.equal(JSON.parse((await lines.next()).value).ok, true);
    assert.deepEqual(events, ['persist:true', 'access:true']);
    events.length = 0;
    input.write(JSON.stringify({ id: 2, command: 'resume' }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /Disk full/);
    assert.equal(state, 'paused');
    assert.equal((await loadSettings(directory)).paused, true);
    assert.deepEqual(events, ['access:false', 'persist:false', 'access:true']);
  } finally { input.end(); await run; output.end(); await rm(directory, { recursive: true, force: true }); }
});
