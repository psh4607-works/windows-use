import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopScriptProviderClient } from '../dist/provider.mjs';
import { executeRequest } from '../src/request.mjs';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';

const secret = 'SYNTHETIC_SECRET_DO_NOT_LOG';
const element = { index: 2, runtimeId: [42, 88], automationId: 'editor', actions: ['SetValue', 'Invoke'], value: '' };
function fixture({ before = element, after, rawAction, afterWindow = 123, fail = false } = {}) {
  const inputs = [];
  const providerFactory = () => {
    const provider = new DesktopScriptProviderClient('windows', 'fixture.ps1', null);
    provider.callBridge = async request => {
      if (request.tool === 'handshake') return { ok: true, capabilities: { supports: { actions: Object.fromEntries(['setValue', 'pressKey', 'typeText', 'hotkey', 'pasteText', 'performAction', 'click', 'scroll', 'drag'].map(key => [key, true])) } } };
      const input = request.tool !== 'get_app_state';
      if (input) { inputs.push(request); if (fail) throw new Error(`uncertain input: ${request.value ?? request.text ?? ''}`); }
      const elements = input && after ? after : [before];
      return { ok: true, action: input ? rawAction : undefined, snapshot: { app: { name: 'fixture', pid: 42 }, windowId: input ? afterWindow : 123, windowIndex: 0, elements, treeLines: elements.map(e => `${e.index} edit ${e.value}`) } };
    };
    return provider;
  };
  return { providerFactory, inputs };
}
const snapshot = session => ({ command: 'snapshot', session, params: { app: 'fixture' } });
const input = (session, observation, command = 'press-key', params = {}) => ({ command, session, observation, params: { app: 'fixture', key: 'Enter', ...params } });
async function context(t, options = {}, ipc = false) {
  const directory = await mkdtemp(join(tmpdir(), 'wu-safety-'));
  const stateDir = join(directory, 'state');
  const f = fixture(options);
  const execute = request => executeRequest(request, { stateDir, providerFactory: f.providerFactory });
  const desktop = ipc ? await startDesktop({ directory, handler: execute }) : null;
  t.after(async () => { await desktop?.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...f, stateDir, directory, desktop, run: ipc ? request => requestDesktop(request, { directory }) : execute };
}

test('sensitive set-value redacts verification, output and persisted observations', async t => {
  for (const metadata of [{ isSensitive: true }, {}]) {
    const c = await context(t, { before: { ...element, ...metadata, value: '[redacted]' } });
    const observed = await c.run(snapshot('a'));
    const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: secret }));
    assert.equal(JSON.stringify(result).includes(secret), false, 'input secret leaked in response');
    assert.equal(result.action.verification.state, 'unverified');
    assert.equal((await readFile(join(c.stateDir, 'a.json'), 'utf8')).includes(secret), false);
  }
});

test('explicit unobserved HWND is rejected through desktop IPC before dispatch', async t => {
  const c = await context(t, {}, true);
  const observed = await c.run(snapshot('a'));
  await assert.rejects(c.run(input('a', observed.session.observation, 'press-key', { windowId: 456 })), /fresh snapshot/i);
  assert.equal(c.inputs.length, 0);
});

test('replacement at the same index cannot verify set-value', async t => {
  const c = await context(t, { after: [{ ...element, runtimeId: [42, 99], automationId: 'other', value: 'requested-value' }] });
  const observed = await c.run(snapshot('a'));
  const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: 'requested-value' }));
  assert.equal(result.action.verification.state, 'unverified');
});

test('another session input invalidates observations through desktop IPC', async t => {
  const c = await context(t, {}, true);
  const a = await c.run(snapshot('a'));
  const b = await c.run(snapshot('b'));
  await c.run(input('b', b.session.observation));
  await assert.rejects(c.run(input('a', a.session.observation)), /fresh snapshot|stale|changed/i);
  assert.equal(c.inputs.length, 1);
});

test('metadata redacts raw native verification and echoed snapshot data', async t => {
  const c = await context(t, { before: { ...element, isSensitive: true }, after: [{ ...element, isSensitive: true, value: secret }], rawAction: { path: 'accessibility', verification: { state: 'verified', property: 'value', expected: secret, actualPreview: secret } } });
  const observed = await c.run(snapshot('a'));
  const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: secret }));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.action.verification.state, 'unverified');
  const saved = await readFile(join(c.stateDir, 'a.json'), 'utf8');
  assert.equal(saved.includes(secret), false);
  assert.ok(JSON.parse(saved).snapshots.every(([, s]) => s.elements[0].isSensitive === true));
});

test('identity verification rejects missing and ambiguous identities in UIA and MSAA', async t => {
  for (const runtimeId of [[42, 88], [-34, 123, 21, 0]]) {
    for (const after of [
      [{ ...element, runtimeId: undefined, value: 'public' }],
      [{ ...element, runtimeId: null, value: 'public' }],
      [3, 4].map(index => ({ ...element, index, runtimeId, value: 'public' }))
    ]) {
      const c = await context(t, { before: { ...element, runtimeId }, after });
      const observed = await c.run(snapshot('a'));
      const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: 'public' }));
      assert.equal(result.action.verification.state, 'unverified');
    }
  }
  const c = await context(t, { before: { ...element, runtimeId: undefined }, after: [3, 4].map(index => ({ ...element, index, runtimeId: undefined, value: 'public' })) });
  const observed = await c.run(snapshot('a'));
  assert.equal((await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: 'public' }))).action.verification.state, 'unverified');
});

test('all input paths reject an unobserved explicit window before native dispatch', async () => {
  const cases = [
    ['setValue', { elementIndex: 2, value: 'public' }], ['performSecondaryAction', { elementIndex: 2, action: 'Invoke' }],
    ['pressKey', { key: 'Enter' }], ['hotkey', { key: 'CTRL+A' }], ['typeText', { text: 'public' }], ['pasteText', { text: 'public' }],
    ['click', { x: 1, y: 1, clickCount: 1, mouseButton: 'left' }], ['scroll', { direction: 'down', pages: 1, x: 1, y: 1 }],
    ['drag', { fromX: 1, fromY: 1, toX: 2, toY: 2 }]
  ];
  for (const [method, params] of cases) {
    const f = fixture(); const provider = f.providerFactory();
    try {
      await provider.snapshot({ app: 'fixture' });
      await assert.rejects(provider.action(method, { app: 'fixture', windowId: 456, ...params }), /fresh snapshot/i);
      assert.equal(f.inputs.length, 0);
    } finally { provider.shutdown(); }
  }
});

test('window changes remain unverified even with identical element runtime IDs', async t => {
  for (const isSensitive of [false, true]) {
    const c = await context(t, { before: { ...element, isSensitive }, after: [{ ...element, isSensitive, value: 'public' }], afterWindow: 456,
      rawAction: { path: 'accessibility', verification: { state: 'unverified', reason: 'window_changed' } } });
    const observed = await c.run(snapshot('a'));
    const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: 'public' }));
    assert.equal(result.action.verification.state, 'unverified');
    assert.equal(result.action.verification.reason, 'window_changed');
  }
});

test('window change without native verification cannot borrow the new window value', async t => {
  const c = await context(t, { after: [{ ...element, value: 'public' }], afterWindow: 456 });
  const observed = await c.run(snapshot('a'));
  const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: 'public' }));
  assert.equal(result.action.verification.state, 'unverified');
  assert.equal(result.action.verification.reason, 'window_changed');
});

test('ordinary values including a literal redaction marker remain verifiable after reindexing', async t => {
  for (const value of ['public', '[redacted]']) {
    for (const runtimeId of [[42, 88], [-34, 123, 21, 0], undefined]) {
      const c = await context(t, { before: { ...element, runtimeId, isSensitive: false }, after: [{ ...element, index: 9, runtimeId, isSensitive: false, value }] });
      const observed = await c.run(snapshot('a'));
      const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value }));
      assert.equal(result.action.verification.state, 'verified');
      assert.equal(result.action.verification.actualPreview, value);
    }
  }
});

test('sensitive typing/paste responses and bridge errors do not echo input', async t => {
  for (const command of ['set-value', 'type-text', 'paste-text']) {
    for (const fail of [false, true]) {
      const c = await context(t, { before: { ...element, isSensitive: true }, after: [{ ...element, isSensitive: true, value: secret }], fail });
      const observed = await c.run(snapshot('a'));
      const request = input('a', observed.session.observation, command, command === 'set-value' ? { elementIndex: 2, value: secret } : { text: secret });
      if (fail) await assert.rejects(c.run(request), error => !error.message.includes(secret) && error.message.includes('[redacted]'));
      else {
        assert.equal(JSON.stringify(await c.run(request)).includes(secret), false);
        assert.equal((await readFile(join(c.stateDir, 'a.json'), 'utf8')).includes(secret), false);
      }
    }
  }
});

test('sensitivity after an identity loss still hides the requested value', async t => {
  const c = await context(t, { before: { ...element, isSensitive: false }, after: [{ ...element, runtimeId: [42, 99], isSensitive: true, value: '[redacted]' }] });
  const observed = await c.run(snapshot('a'));
  const result = await c.run(input('a', observed.session.observation, 'set-value', { elementIndex: 2, value: secret }));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.action.verification.state, 'unverified');
});

test('sensitive snapshot metadata suppresses unstructured summaries and pixels before output/cache', async () => {
  const provider = fixture({ before: { ...element, isSensitive: true, value: secret } }).providerFactory();
  const bridge = provider.callBridge;
  provider.callBridge = async request => {
    const result = await bridge(request);
    result.snapshot = { ...result.snapshot, selectedText: secret, focusedSummary: secret, screenshotPngBase64: 'synthetic-image' };
    return result;
  };
  try {
    const result = await provider.snapshot({ app: 'fixture', noScreenshot: false });
    assert.equal(result.screenshot, null);
    assert.equal(JSON.stringify(result).includes(secret), false);
    for (const snapshot of provider.snapshots.values()) {
      assert.equal(JSON.stringify(snapshot).includes(secret), false);
      assert.equal(snapshot.selectedText, null);
      assert.equal(snapshot.focusedSummary, null);
      assert.equal(snapshot.screenshotPngBase64, null);
      assert.equal(snapshot.elements[0].isSensitive, true);
    }
  } finally { provider.shutdown(); }
});
