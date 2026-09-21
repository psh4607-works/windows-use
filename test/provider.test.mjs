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

test('indexed keyboard actions keep the observed HWND after windows are reordered', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'wu-window-'));
  let windows = [123, 456];
  const inputs = [];
  const providerFactory = () => {
    const provider = new DesktopScriptProviderClient('windows', 'fixture-runtime.ps1', null);
    provider.callBridge = async request => {
      if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { actions: { pressKey: true } } } };
      const windowId = request.windowId ?? windows[request.windowIndex];
      if (!windows.includes(windowId)) throw new Error('windowNotFound');
      if (request.tool === 'press_key') inputs.push(windowId);
      return { ok: true, snapshot: {
        snapshotId: 'native-state', app: { name: 'fixture', pid: 42 },
        windowId, windowIndex: windows.indexOf(windowId), elements: [], treeLines: []
      } };
    };
    return provider;
  };
  try {
    const observed = await executeRequest({ command: 'snapshot', session: 'a', params: { app: 'fixture', windowIndex: 0 } }, { stateDir, providerFactory });
    windows.reverse();
    const result = await executeRequest({ command: 'press-key', session: 'a', observation: observed.session.observation, params: { app: 'fixture', windowIndex: 0, key: 'Enter' } }, { stateDir, providerFactory });
    assert.deepEqual(inputs, [123]);
    windows = [456];
    await assert.rejects(executeRequest({ command: 'press-key', session: 'a', observation: result.session.observation, params: { app: 'fixture', windowIndex: 0, key: 'Enter' } }, { stateDir, providerFactory }), /windowNotFound/);
    assert.deepEqual(inputs, [123]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('indexed actions without an observed HWND are rejected before dispatch', async () => {
  for (const windowId of [undefined, null]) {
    const provider = new DesktopScriptProviderClient('windows', 'fixture-runtime.ps1', null);
    const inputs = [];
    provider.callBridge = async request => {
      if (request.tool !== 'get_app_state') inputs.push(request.tool);
      return { ok: true, snapshot: {
        snapshotId: 'native-state', app: { name: 'fixture', pid: 42 },
        windowId, windowIndex: 0, elements: [], treeLines: []
      } };
    };
    await assert.rejects(provider.action('pressKey', { app: 'fixture', windowIndex: 0, key: 'Enter' }), /fresh snapshot/);
    await provider.snapshot({ app: 'fixture', windowIndex: 0 });
    await assert.rejects(provider.action('pressKey', { app: 'fixture', windowIndex: 0, key: 'Enter' }), /fresh snapshot/);
    await assert.rejects(provider.action('pressKey', { app: 'fixture', key: 'Enter' }), /fresh snapshot/);
    assert.deepEqual(inputs, []);
    provider.shutdown();
  }
});
