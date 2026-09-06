import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRequest } from '../src/request.mjs';

test('separate CLI invocations preserve the observed element identity within one session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'windows-use-test-'));
  const calls = [];
  const providerFactory = () => ({
    snapshots: new Map(),
    async snapshot(params) {
      this.snapshots.set(params.app, { elements: [{ index: 4, runtimeId: [42, 7], actions: ['Invoke'] }], screenshotPngBase64: null });
      return { snapshot: { id: 'snapshot-1', treeText: '4 button Save' }, screenshot: null };
    },
    async action(method, params) {
      const element = this.snapshots.get(params.app)?.elements.find(item => item.index === params.elementIndex);
      assert.deepEqual(element?.runtimeId, [42, 7]);
      calls.push(method);
      return { snapshot: { id: 'snapshot-2' }, action: { verification: { state: 'unverified' } } };
    },
    shutdown() {}
  });
  try {
    const first = await executeRequest({ command: 'snapshot', session: 'task-a', params: { app: 'Notepad' } }, { stateDir, providerFactory });
    const result = await executeRequest({ command: 'click', session: 'task-a', observation: first.session?.observation, params: { app: 'Notepad', elementIndex: 4 } }, { stateDir, providerFactory });
    assert.deepEqual(calls, ['performSecondaryAction']);
    assert.equal(result.action.verification.state, 'unverified');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('failed actions invalidate observation tokens so uncertain input is not replayed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'windows-use-failure-'));
  let calls = 0;
  const providerFactory = () => ({
    snapshots: new Map(),
    async snapshot() { return { snapshot: { id: 'one' } }; },
    async action() { calls++; throw new Error('action timeout'); }, shutdown() {}
  });
  try {
    const observed = await executeRequest({ command: 'snapshot', session: 'a', params: { app: 'Notepad' } }, { stateDir, providerFactory });
    const request = { command: 'type-text', session: 'a', observation: observed.session.observation, params: { app: 'Notepad', text: 'hello' } };
    await assert.rejects(executeRequest(request, { stateDir, providerFactory }), /timeout/);
    await assert.rejects(executeRequest(request, { stateDir, providerFactory }), /snapshot/);
    assert.equal(calls, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('actions require a fresh observation belonging to the same session and app', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'windows-use-guard-'));
  let mutations = 0;
  let now = 1000;
  const providerFactory = () => ({
    snapshots: new Map(),
    async snapshot() { this.snapshots.set('app', { elements: [], screenshotPngBase64: 'sensitive-image' }); return { snapshot: { id: 'observed' } }; },
    async action() { mutations++; return { snapshot: { id: 'updated' } }; }, shutdown() {}
  });
  const deps = { stateDir, providerFactory, now: () => now };
  try {
    const observed = await executeRequest({ command: 'snapshot', session: 'a', params: { app: 'Notepad' } }, deps);
    const request = { command: 'click', session: 'a', observation: observed.session?.observation, params: { app: 'Notepad', elementIndex: 1 } };
    await assert.rejects(executeRequest({ ...request, observation: 'wrong' }, deps), /observation/i);
    await assert.rejects(executeRequest({ ...request, session: 'b' }, deps), /snapshot/i);
    await assert.rejects(executeRequest({ ...request, params: { app: 'Other', elementIndex: 1 } }, deps), /app/i);
    now += 120001;
    await assert.rejects(executeRequest(request, deps), /expired/i);
    assert.equal(mutations, 0);
    assert.doesNotMatch(await readFile(join(stateDir, 'a.json'), 'utf8'), /sensitive-image/);
    await assert.rejects(executeRequest({ ...request, session: '../escape' }, deps), /session/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('same-session concurrent operations are rejected before touching the desktop', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'windows-use-lock-'));
  try {
    await writeFile(join(stateDir, 'a.lock'), 'active');
    await assert.rejects(executeRequest({ command: 'snapshot', session: 'a', params: { app: 'Notepad' } }, {
      stateDir, providerFactory() { assert.fail('must not create provider while session is locked'); }
    }), /busy/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
