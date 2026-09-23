import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRequest } from '../src/request.mjs';

const elements = [
  { index: 3, runtimeId: [1, 3], controlType: 'ControlType.Button', name: 'Save', automationId: 'save', value: '', actions: ['Invoke'] },
  { index: 4, runtimeId: [1, 4], controlType: 'ControlType.Button', name: 'Save', automationId: 'save-copy', actions: ['Invoke'] }
];
async function fixture(run, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'wu-query-'));
  const calls = [];
  const providerFactory = () => ({ snapshots: new Map(),
    async listWindows() { return { windows: [{ id: 123 }] }; },
    async snapshot(params) {
      calls.push(['snapshot', params]);
      const raw = { windowId: 123, elements, ...overrides };
      this.snapshots.set('fixture', raw);
      return { snapshot: { id: 'fresh', window: { id: raw.windowId }, treeText: 'not part of query output', truncation: raw.truncation } };
    },
    async action(method, params) { calls.push([method, params]); assert.deepEqual(this.snapshots.get('fixture').elements[0].runtimeId, [1, 3]); return {}; },
    shutdown() {}
  });
  const query = params => executeRequest({ command: 'query', session: 'find', params: { app: 'fixture', ...params } }, { stateDir, providerFactory });
  try { await run({ query, calls, stateDir, providerFactory }); }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('query AND-matches exact native metadata in a fresh pinned observation usable by an action', async () => {
  await fixture(async ({ query, calls, stateDir, providerFactory }) => {
    const found = await query({ role: 'ControlType.Button', name: 'Save', automationId: 'save' });
    assert.equal(found.query.matchCount, 1);
    assert.equal(found.query.unique, true);
    assert.equal(found.query.matches[0].index, 3);
    assert.equal(calls[0][1].windowId, 123);
    assert.equal(found.snapshot.treeText, undefined);
    assert.equal(typeof found.session.observation, 'string');
    await executeRequest({ command: 'click', session: 'find', observation: found.session.observation,
      params: { app: 'fixture', windowId: 123, elementIndex: found.query.matches[0].index } }, { stateDir, providerFactory });
    assert.equal(calls[1][0], 'performSecondaryAction');
  });
});

test('query reports ambiguity and incomplete trees without claiming a unique target', async () => {
  await fixture(async ({ query, calls }) => {
    const found = await query({ name: 'Save' });
    assert.equal(found.query.matchCount, 2);
    assert.equal(found.query.unique, false);
    assert.equal((await query({ name: 'save' })).query.matchCount, 0);
    assert.ok(calls.every(([method]) => method === 'snapshot'));
  });
  await fixture(async ({ query }) => {
    const found = await query({ automationId: 'save' });
    assert.equal(found.query.unique, false);
    assert.equal(found.query.complete, false);
  }, { truncation: { truncated: true } });
});

test('query rejects unsupported metadata and unsafe options before any snapshot', async () => {
  await fixture(async ({ query, calls }) => {
    for (const params of [{}, { name: '' }, { name: 7 }, { role: 'ControlType.Button', windowIndex: 0 },
      { name: 'Save', restoreWindow: true }, { name: 'Save', windowId: 0 },
      { automationId: 'save', accessibility: 'msaa' }]) {
      await assert.rejects(query(params), error => ['invalid_query', 'unsupported_selector'].includes(error.code));
    }
    assert.equal(calls.length, 0);
  });
});

test('query redacts sensitive metadata and preserves native MSAA roles without inventing AutomationId', async () => {
  await fixture(async ({ query }) => {
    const found = await query({ role: 'ControlType.Edit' });
    assert.equal(found.query.matches[0].sensitive, true);
    assert.equal(found.query.matches[0].value, null);
    assert.doesNotMatch(JSON.stringify(found), /secret-value|secret-name|secret-id/);
  }, { elements: [{ index: 1, controlType: 'ControlType.Edit', name: 'secret-name', automationId: 'secret-id', value: 'secret-value', sensitive: true }] });
  await fixture(async ({ query }) => {
    const found = await query({ role: 'MSAA.42', accessibility: 'msaa' });
    assert.equal(found.query.matches[0].automationId, null);
    assert.equal(found.query.matches[0].role, 'MSAA.42');
    assert.equal(found.query.matches[0].value, null);
  }, { elements: [{ index: 1, controlType: 'MSAA.42', name: 'PIN', value: '[redacted]', automationId: '' }] });
});

test('query distinguishes unsupported, empty, and truncated values using explicit native metadata', async () => {
  await fixture(async ({ query }) => {
    const { matches } = (await query({ role: 'ControlType.Edit' })).query;
    assert.equal(matches[0].value, null);
    assert.equal(matches[1].value, '');
    assert.equal(matches[2].valueTruncated, true);
  }, { elements: [
    { index: 0, controlType: 'ControlType.Edit', value: '', valueAvailable: false },
    { index: 1, controlType: 'ControlType.Edit', value: '', valueAvailable: true },
    { index: 2, controlType: 'ControlType.Edit', value: 'abc...', valueAvailable: true, valueTruncated: true }
  ] });
});

test('query never silently ignores action/wait options or accepts an unverified window target', async () => {
  await fixture(async ({ query }) => {
    for (const params of [{ name: 'Save', value: '' }, { name: 'Save', condition: 'changed' }, { name: 'Save', elementIndex: 3 }]) {
      await assert.rejects(query(params), error => error.code === 'invalid_query');
    }
    await assert.rejects(query({ name: 'Save', windowId: 456 }), error => error.code === 'invalid_observation');
  });
});

test('explicit false sensitivity markers preserve ordinary literal redaction text', async () => {
  await fixture(async ({ query }) => {
    const found = (await query({ role: 'ControlType.Edit' })).query.matches[0];
    assert.equal(found.sensitive, false);
    assert.equal(found.value, '[redacted]');
  }, { elements: [{ index: 1, controlType: 'ControlType.Edit', value: '[redacted]', valueAvailable: true, isSensitive: false }] });
});
