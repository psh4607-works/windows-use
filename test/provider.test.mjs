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

test('desktop-wide windows retain native identity and relationship metadata', async () => {
  const provider = new DesktopScriptProviderClient('windows', 'fixture.ps1', null);
  const window = { id: 12, index: 0, title: 'Destination', app: { name: 'other', pid: 43 }, processInstance: 'start', className: 'Dialog', ownerWindowId: 10, rootOwnerWindowId: 10, isForeground: true };
  provider.callBridge = async request => {
    if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { windows: { list: true } } } };
    assert.equal(request.all, true);
    assert.equal(request.app, undefined);
    return { ok: true, windows: [window] };
  };
  const result = await provider.listWindows({ all: true });
  for (const field of ['processInstance', 'className', 'ownerWindowId', 'rootOwnerWindowId', 'isForeground']) assert.equal(result.windows[0][field], window[field]);
});

test('input binds to observed process instance and preserves outcome when source closes', async () => {
  const provider = new DesktopScriptProviderClient('windows', 'fixture.ps1', null);
  provider.callBridge = async request => {
    if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { actions: { performAction: true } } } };
    if (request.tool === 'get_app_state') return { ok: true, snapshot: { snapshotId: 'initial', app: { name: 'fixture', pid: 42 }, processInstance: 'start-a', windowTitle: 'Fixture', windowClassName: 'TestWindow', windowId: 12, elements: [{ index: 1, runtimeId: [1], actions: ['Invoke'] }], treeLines: [] } };
    assert.equal(request.expectedProcessInstance, 'start-a');
    assert.equal(request.expectedWindowTitle, 'Fixture');
    assert.equal(request.expectedWindowClassName, 'TestWindow');
    assert.equal(request.app, 'pid:42');
    return { ok: true, snapshot: null, action: { path: 'accessibility', actionName: 'Invoke', verification: { state: 'unverified', reason: 'window_changed' } } };
  };
  const first = await provider.snapshot({ app: 'fixture', windowId: 12 });
  assert.equal(first.snapshot.processInstance, 'start-a');
  const result = await provider.action('performSecondaryAction', { app: 'fixture', windowId: 12, elementIndex: 1, action: 'Invoke' });
  assert.equal(result.snapshot, null);
  assert.equal(result.action.verification.reason, 'window_changed');
  assert.equal(provider.snapshots.size, 0);
});

test('native pointer authorization is forwarded with the observed target', async () => {
  const provider = new DesktopScriptProviderClient('windows', 'fixture.ps1', null);
  provider.callBridge = async request => {
    if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { actions: { click: true } } } };
    if (request.tool === 'click') assert.equal(request.allowPointer, true);
    return { ok: true, snapshot: { snapshotId: 'initial', app: { name: 'fixture', pid: 42 }, processInstance: 'start', windowId: 12, elements: [], treeLines: [] } };
  };
  await provider.snapshot({ app: 'fixture', windowId: 12 });
  await provider.action('click', { app: 'fixture', windowId: 12, x: 10, y: 10, allowPointer: true });
});
