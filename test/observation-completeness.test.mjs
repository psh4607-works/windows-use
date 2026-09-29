import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopScriptProviderClient } from '../dist/provider.mjs';
import { observeQuery } from '../src/query.mjs';
import { waitFor } from '../src/wait-for.mjs';

function fixture({ errors, truncation, count = 1 } = {}) {
  const provider = new DesktopScriptProviderClient('windows', 'fixture.ps1', null);
  provider.callBridge = async () => ({ ok: true, snapshot: {
    snapshotId: 'fixture', windowId: 123, app: { name: 'Fixture', pid: 42 },
    treeLines: ['MSAA: 1 inaccessible nodes omitted'], observationErrors: errors, truncation,
    elements: Array.from({ length: count }, (_, index) => ({ index, name: 'Save', controlType: 'ControlType.Button', runtimeId: [42, index] }))
  } });
  const query = () => observeQuery(provider, { app: 'fixture', windowId: 123, name: 'Save' });
  return { provider, query };
}

test('provider and query preserve node/subtree omissions without claiming uniqueness', async () => {
  for (const code of ['uia_node_unavailable', 'uia_children_unavailable', 'msaa_node_unavailable', 'msaa_children_unavailable']) {
    const errors = [{ code, count: 2 }];
    const { provider, query } = fixture({ errors, truncation: { truncated: false, maxDepthReached: false } });
    const snapshot = await provider.snapshot({ app: 'fixture', windowId: 123, noScreenshot: true });
    assert.deepEqual(snapshot.snapshot.observationErrors, errors);
    const result = await query();
    assert.equal(result.query.matchCount, 1);
    assert.equal(result.query.complete, false);
    assert.equal(result.query.unique, false);
    assert.deepEqual(result.query.incompleteReasons, errors);
    assert.deepEqual(result.snapshot.observationErrors, errors);
    assert.equal(result.snapshot.treeText, undefined);
  }
});

test('complete observations distinguish zero, one and multiple matches; limits explain incompleteness', async () => {
  for (const count of [0, 1, 2]) {
    const result = await fixture({ errors: [], count }).query();
    assert.equal(result.query.complete, true);
    assert.equal(result.query.unique, count === 1);
    assert.equal(result.query.matchCount, count);
    assert.deepEqual(result.query.incompleteReasons, []);
  }
  for (const [flag, code] of [['truncated', 'tree_truncated'], ['maxDepthReached', 'max_depth_reached']]) {
    const result = await fixture({ truncation: { [flag]: true } }).query();
    assert.equal(result.query.complete, false);
    assert.equal(result.query.unique, false);
    assert.deepEqual(result.query.incompleteReasons, [{ code, count: 1 }]);
  }
});

test('omission metadata has only safe codes and counts, including unknown provider diagnostics', async () => {
  const { provider, query } = fixture({ errors: [
    { code: 'msaa_node_unavailable', count: 1, message: 'private-ui-label', value: 'private-value' },
    { code: 'private-provider-error', count: 'private-count' }
  ] });
  for (const result of [await provider.snapshot({ app: 'fixture', windowId: 123 }), await query()]) {
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    assert.deepEqual(result.snapshot.observationErrors, [
      { code: 'msaa_node_unavailable', count: 1 }, { code: 'accessibility_unavailable', count: 1 }
    ]);
  }
});

test('wait fails on incomplete real provider queries for element, value and changed conditions', async () => {
  for (const condition of ['element', 'value', 'changed']) {
    const { query } = fixture({ errors: [{ code: 'msaa_children_unavailable', count: 1 }] });
    const calls = [];
    await assert.rejects(waitFor({ session: 'wait', params: { app: 'fixture', name: 'Save', condition,
      ...(condition === 'value' ? { value: 'private-expected' } : {}) } }, {
      read: async request => {
        calls.push(request.command);
        return { ...(request.command === 'windows' ? { windows: [{ id: 123 }] } : await query()), accessEpoch: 'owner:0' };
      }
    }), error => {
      assert.equal(error.code, 'incomplete_observation');
      assert.match(error.message, /msaa_children_unavailable/);
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
    assert.deepEqual(calls, ['windows', 'query']);
  }
});

test('window waits reject partial snapshots and expose no successful observation', async () => {
  for (const [options, reason] of [
    [{ errors: [{ code: 'uia_children_unavailable', count: 1 }] }, 'uia_children_unavailable'],
    [{ truncation: { truncated: true } }, 'tree_truncated'],
    [{ truncation: { truncated: true, maxDepthReached: true } }, 'max_depth_reached']
  ]) {
    const { provider } = fixture(options);
    await assert.rejects(waitFor({ session: 'wait', params: { app: 'fixture', condition: 'window' } }, {
      read: async request => ({ ...(request.command === 'windows' ? { windows: [{ id: 123 }] }
        : await provider.snapshot({ app: 'fixture', windowId: 123 })), accessEpoch: 'owner:0' })
    }), error => {
      assert.equal(error.code, 'incomplete_observation');
      assert.match(error.message, /The window was found/);
      assert.doesNotMatch(error.message, /uniqueness/);
      assert.ok(error.message.includes(reason));
      return true;
    });
  }
});
