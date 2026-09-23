import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopScriptProviderClient } from '../dist/provider.mjs';
import { executeRequest } from '../src/request.mjs';

test('built provider carries query identities and pinned HWND into a separate session action on both backends', async () => {
  for (const accessibility of ['uia', 'msaa']) {
    const stateDir = await mkdtemp(join(tmpdir(), 'wu-query-provider-'));
    let value = 'before';
    const calls = [];
    const providerFactory = () => {
      const provider = new DesktopScriptProviderClient('windows', 'fixture.ps1', null);
      provider.callBridge = async request => {
        calls.push(request);
        if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { windows: { list: true }, actions: { setValue: true } } } };
        if (request.tool === 'list_windows') return { ok: true, app: { name: 'fixture', pid: 42 }, windows: [{ id: 123, index: 0, title: 'Fixture', app: { name: 'fixture', pid: 42 } }] };
        assert.equal(request.windowId, 123);
        if (request.tool === 'set_value') {
          assert.deepEqual(request.element.runtimeId, [42, 88]);
          assert.equal(request.accessibility, accessibility);
          value = request.value;
        }
        return { ok: true, snapshot: { snapshotId: 'native-fixture', windowId: 123,
          app: { name: 'fixture', pid: 42 }, treeLines: [],
          elements: [{ index: 2, runtimeId: [42, 88], name: 'Editor', automationId: accessibility === 'uia' ? 'editor' : '',
            controlType: accessibility === 'uia' ? 'ControlType.Edit' : 'MSAA.42', actions: ['SetValue'], value, valueAvailable: true, isSensitive: false }] } };
      };
      return provider;
    };
    try {
      const result = await executeRequest({ command: 'query', session: 'query', params: { app: 'fixture', accessibility, name: 'Editor' } }, { stateDir, providerFactory });
      assert.equal(result.query.unique, true);
      assert.equal(result.query.matches[0].value, 'before');
      const action = await executeRequest({ command: 'set-value', session: 'query', observation: result.session.observation,
        params: { app: 'fixture', windowId: result.snapshot.window.id, elementIndex: result.query.matches[0].index, value: 'after' } }, { stateDir, providerFactory });
      assert.equal(action.action.verification.state, 'verified');
      assert.equal(calls.filter(call => call.tool === 'set_value').length, 1);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  }
});
