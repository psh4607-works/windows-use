import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopScriptProviderClient } from '../dist/provider.mjs';
import { executeRequest } from '../src/request.mjs';

test('extracted Orca provider retains runtime identity and verifies set-value after a separate invocation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'wu-provider-'));
  let value = '';
  const requests = [];
  const snapshot = () => ({
    snapshotId: 'native-state', app: { name: 'Notepad', pid: 42 }, windowId: 123,
    windowBounds: { x: 0, y: 0, width: 100, height: 100 },
    elements: [{ index: 2, runtimeId: [42, 88], automationId: 'editor', actions: ['SetValue'], value }],
    treeLines: [`2 edit ${value}`]
  });
  const providerFactory = () => {
    const provider = new DesktopScriptProviderClient('windows', 'fixture-runtime.ps1', null);
    provider.callBridge = async request => {
      requests.push(request);
      if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { actions: { setValue: true } } } };
      if (request.tool === 'set_value') { assert.deepEqual(request.element.runtimeId, [42, 88]); assert.equal(request.windowId, 123); value = request.value; }
      return { ok: true, snapshot: snapshot() };
    };
    return provider;
  };
  try {
    const observed = await executeRequest({ command: 'snapshot', session: 'a', params: { app: 'Notepad' } }, { stateDir, providerFactory });
    const result = await executeRequest({ command: 'set-value', session: 'a', observation: observed.session.observation, params: { app: 'Notepad', elementIndex: 2, value: '안녕하세요' } }, { stateDir, providerFactory });
    assert.equal(result.action.verification.state, 'verified');
    assert.equal(result.action.verification.actualPreview, '안녕하세요');
    assert.equal(requests.filter(request => request.tool === 'set_value').length, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
