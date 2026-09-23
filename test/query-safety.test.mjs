import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRequest } from '../src/request.mjs';

const query = session => ({ command: 'query', session, params: { app: 'fixture', name: 'Ready' } });
const snapshot = session => ({ command: 'snapshot', session, params: { app: 'fixture' } });
const press = (session, result) => ({ command: 'press-key', session, observation: result.session.observation,
  params: { app: 'fixture', key: 'Enter' } });

async function setup(t, capture = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wu-query-safety-'));
  const stateDir = join(directory, 'state');
  let inputs = 0;
  const providerFactory = () => ({ snapshots: new Map(), shutdown() {},
    async listWindows() { return { windows: [{ id: 123 }] }; },
    async snapshot() {
      await capture();
      this.snapshots.set('fixture', { windowId: 123, elements: [
        { index: 0, runtimeId: [1, 2], name: 'Ready', controlType: 'ControlType.Button', isSensitive: false }
      ] });
      return { snapshot: { window: { id: 123 } } };
    },
    async action() { inputs++; return {}; }
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { run: request => executeRequest(request, { stateDir, providerFactory }), stateDir, inputs: () => inputs };
}

test('query initializes versioned observations and does not revoke another session until input', async t => {
  const c = await setup(t);
  const a = await c.run(query('a'));
  const saved = JSON.parse(await readFile(join(c.stateDir, 'a.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(typeof saved.inputRevision, 'string');
  await c.run(query('b'));
  const b = JSON.parse(await readFile(join(c.stateDir, 'b.json'), 'utf8'));
  assert.equal(b.inputRevision, saved.inputRevision);
  await c.run(press('a', a));
  assert.equal(c.inputs(), 1);
});

test('query tokens participate in cross-session stale invalidation in both directions', async t => {
  const c = await setup(t);
  for (const [observe, otherObserve] of [[query, snapshot], [snapshot, query]]) {
    const a = await c.run(observe('a'));
    const b = await c.run(otherObserve('b'));
    await c.run(press('b', b));
    await assert.rejects(c.run(press('a', a)), /fresh snapshot|changed/i);
  }
  assert.equal(c.inputs(), 2);
});

test('a fresh query recovers invalid revision state and invalidates older observations', async t => {
  const c = await setup(t);
  const old = await c.run(query('old'));
  await writeFile(join(c.stateDir, '.input-revision.json'), '{broken');
  const fresh = await c.run(query('fresh'));
  await assert.rejects(c.run(press('old', old)), /fresh snapshot|changed/i);
  await c.run(press('fresh', fresh));
  assert.equal(c.inputs(), 1);
});

test('query capture holds the global observation lock against other session input', async t => {
  let enter, release, blocked = false;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const c = await setup(t, async () => { if (blocked) { enter(); await gate; } });
  const a = await c.run(query('a'));
  blocked = true;
  const pending = c.run(query('b')); await started;
  try { await assert.rejects(c.run(press('a', a)), /busy/i); }
  finally { release(); await pending; }
  assert.equal(c.inputs(), 0);
});
