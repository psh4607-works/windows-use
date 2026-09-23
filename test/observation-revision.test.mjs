import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker, callBroker } from '../src/broker.mjs';
import { randomUUID } from 'node:crypto';
import { executeRequest } from '../src/request.mjs';
import { lockObservations } from '../src/observation-revision.mjs';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';

const snap = session => ({ command: 'snapshot', session, params: { app: 'fixture' } });
const press = (session, observed) => ({ command: 'press-key', session, observation: observed.session.observation, params: { app: 'fixture', key: 'Enter' } });
const stale = /fresh snapshot|stale|changed|before acting/i;
async function setup(t, { fail = false, delay } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wu-revision-'));
  const stateDir = join(directory, 'state');
  let inputs = 0;
  const providerFactory = () => ({ snapshots: new Map(), shutdown() {},
    async snapshot() { if (delay) await delay('snapshot'); return { snapshot: { id: 'fixture' } }; },
    async action() { inputs++; if (delay) await delay('input'); if (fail) throw new Error('uncertain input'); return { snapshot: { id: 'fixture' } }; },
    async listApps() { return { apps: [] }; }, async listWindows() { return { windows: [] }; }, async capabilities() { return {}; }
  });
  const run = request => executeRequest(request, { stateDir, providerFactory });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { run, directory, stateDir, inputs: () => inputs };
}

test('direct boundary revokes other sessions even when native input fails', async t => {
  const c = await setup(t, { fail: true });
  const a = await c.run(snap('a')), b = await c.run(snap('b'));
  await assert.rejects(c.run(press('b', b)), /uncertain input/);
  await assert.rejects(c.run(press('a', a)), stale);
  assert.equal(c.inputs(), 1);
});

test('legacy/malformed session and revision state fail closed until a fresh snapshot', async t => {
  const c = await setup(t);
  for (const mutation of [saved => { delete saved.inputRevision; }, saved => { saved.inputRevision = null; }, saved => { delete saved.expiresAt; }, saved => { saved.snapshots = {}; }]) {
    const a = await c.run(snap('a'));
    const path = join(c.stateDir, 'a.json'); const saved = JSON.parse(await readFile(path, 'utf8'));
    mutation(saved); await writeFile(path, JSON.stringify(saved));
    await assert.rejects(c.run(press('a', a)), stale);
  }
  const a = await c.run(snap('a'));
  await writeFile(join(c.stateDir, '.input-revision.json'), '{broken');
  await assert.rejects(c.run(press('a', a)), stale);
  const fresh = await c.run(snap('a')); await c.run(press('a', fresh));
  assert.equal(c.inputs(), 1);
});

test('pure queries and snapshots preserve observations; restoring focus revokes them', async t => {
  const c = await setup(t);
  const a = await c.run(snap('a'));
  await c.run(snap('b'));
  for (const command of ['apps', 'windows', 'capabilities']) await c.run({ command, params: { app: 'fixture' } });
  await c.run(press('a', a));
  const b = await c.run(snap('b'));
  await c.run({ ...snap('c'), params: { app: 'fixture', restoreWindow: true } });
  await assert.rejects(c.run(press('b', b)), stale);
});

test('direct executions cannot overlap snapshot capture and input', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let block = false;
  const c = await setup(t, { delay: async kind => { if (block && kind === 'snapshot') { entered(); await gate; } } });
  const a = await c.run(snap('a'));
  block = true;
  const pending = c.run(snap('b')); await started;
  try { await assert.rejects(c.run(press('a', a)), /busy/i); }
  finally { release(); await pending; }
  assert.equal(c.inputs(), 0);
});

test('IPC validates a queued token at execution, and pause/resume/restart revoke tokens', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const c = await setup(t, { delay: async kind => { if (kind === 'input') { entered(); await gate; } } });
  let desktop = await startDesktop({ directory: c.directory, handler: c.run });
  const run = request => requestDesktop(request, { directory: c.directory });
  try {
    const a = await run(snap('a')), b = await run(snap('b'));
    const first = run(press('b', b)); await started;
    const queued = assert.rejects(run(press('a', a)), stale);
    release(); await first; await queued;
    assert.equal(c.inputs(), 1);
    const beforePause = await run(snap('a'));
    await desktop.setPaused(true); await desktop.setPaused(false);
    await assert.rejects(run(press('a', beforePause)), stale);
    const beforeRestart = await run(snap('a'));
    await desktop.close(); desktop = await startDesktop({ directory: c.directory, handler: c.run });
    await assert.rejects(run(press('a', beforeRestart)), stale);
    const fresh = await run(snap('a')); await run(press('a', fresh));
    assert.equal(c.inputs(), 2);
  } finally { release(); await desktop.close(); }
});

test('missing and structurally corrupt revision files require a fresh snapshot', async t => {
  const c = await setup(t);
  const path = join(c.stateDir, '.input-revision.json');
  for (const contents of [null, 'null', '[]', '{"version":1,"revision":0}']) {
    const observed = await c.run(snap('a'));
    if (contents === null) await rm(path); else await writeFile(path, contents);
    await assert.rejects(c.run(press('a', observed)), stale);
    const fresh = await c.run(snap('a')); await c.run(press('a', fresh));
  }
});

async function childRequest(c, request) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { executeRequest } from ${JSON.stringify(new URL('../src/request.mjs', import.meta.url).href)};
    const providerFactory = () => ({ snapshots: new Map(), shutdown() {},
      async snapshot() { return {}; }, async action() { return { dispatched: true }; } });
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    try { process.stdout.write(JSON.stringify(await executeRequest(JSON.parse(data), { stateDir: process.argv[1], providerFactory }))); }
    catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
  `, c.stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error))); });
  child.stdin.end(JSON.stringify(request)); await exit; return JSON.parse(output);
}

test('input revisions survive separate Node invocations and active locks exclude other processes', async t => {
  let release, entered, block = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const c = await setup(t, { delay: async kind => { if (block && kind === 'snapshot') { entered(); await gate; } } });
  const a = await c.run(snap('a'));
  const b = await childRequest(c, snap('b'));
  assert.equal((await childRequest(c, press('b', b))).dispatched, true);
  await assert.rejects(c.run(press('a', a)), stale);
  block = true; const pending = c.run(snap('b')); await started;
  try { assert.match((await childRequest(c, snap('c'))).error, /busy/); }
  finally { release(); await pending; }
});

test('pause never removes a direct execution lock or allows its pre-pause tokens to replay', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const c = await setup(t, { delay: async kind => { if (kind === 'input') { entered(); await gate; } } });
  const desktop = await startDesktop({ directory: c.directory, handler: c.run });
  try {
    const a = await c.run(snap('a')); const pending = c.run(press('a', a)); await started;
    await assert.rejects(desktop.setPaused(true), /busy/);
    await assert.rejects(requestDesktop(snap('c'), { directory: c.directory }), /paused/);
    release(); const after = await pending;
    await desktop.setPaused(false);
    await assert.rejects(c.run(press('a', after)), stale);
  } finally { release(); await desktop.close(); }
});

test('an already admitted IPC request rechecks revision after preceding input finishes', async t => {
  let release, entered, admitted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const admission = new Promise(resolve => { admitted = resolve; });
  const c = await setup(t, { delay: async kind => { if (kind === 'input') { entered(); await gate; } } });
  const a = await c.run(snap('a')), b = await c.run(snap('b'));
  const config = { endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\wu-revision-${randomUUID()}` : join(c.directory, 'queue.sock'), token: randomUUID() };
  const broker = await startBroker({ ...config, prepare: request => {
    if (request.session === 'a') admitted();
    return () => c.run(request);
  } });
  try {
    const first = callBroker(press('b', b), config); await started;
    const second = assert.rejects(callBroker(press('a', a), config), stale);
    await admission; release(); await first; await second;
    assert.equal(c.inputs(), 1);
  } finally { release(); await broker.close(); }
});

test('an abandoned global lock fails closed without deleting existing observations', async t => {
  const c = await setup(t);
  const a = await c.run(snap('a'));
  const path = join(c.stateDir, 'a.json'); const saved = await readFile(path, 'utf8');
  const lock = `${c.stateDir}.input.lock`; await writeFile(lock, 'abandoned fixture lock');
  await assert.rejects(c.run(press('a', a)), /busy/);
  await assert.rejects(startDesktop({ directory: c.directory, handler: c.run }), /busy/);
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.equal(await readFile(lock, 'utf8'), 'abandoned fixture lock');
  await rm(lock);
  const desktop = await startDesktop({ directory: c.directory, handler: c.run });
  try { await assert.rejects(c.run(press('a', a)), stale); }
  finally { await desktop.close(); }
});

test('a close error releases the global lock path and preserves the error', async t => {
  const c = await setup(t);
  const release = await lockObservations(c.stateDir, { openFile: async (...args) => {
    const handle = await open(...args);
    return { close: async () => { await handle.close(); throw new Error('fixture close failure'); } };
  } });
  await assert.rejects(release(), /fixture close failure/);
  const releaseNext = await lockObservations(c.stateDir);
  await releaseNext();
});
