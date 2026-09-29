import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';
import { startBroker } from '../src/broker.mjs';
import { randomUUID } from 'node:crypto';

test('build manifest distinguishes same-version payloads and detects changed skill bytes', async () => {
  const api = await import('../src/build-identity.mjs').catch(() => ({}));
  assert.equal(typeof api.writeBuildManifest, 'function', 'reproducible build manifest is required');
  const root = await mkdtemp(join(tmpdir(), 'wu-build-'));
  try {
    await mkdir(join(root, 'skills/windows-use'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"@psh4607/windows-use","version":"0.2.0"}');
    await writeFile(join(root, 'skills/windows-use/SKILL.md'), 'query and wait-for');
    const a = await api.writeBuildManifest(root);
    assert.deepEqual(await api.writeBuildManifest(root), a, 'build must not depend on time');
    assert.equal((await api.readBuildIdentity(root)).integrity, 'verified');
    await writeFile(join(root, 'skills/windows-use/SKILL.md'), 'different skill');
    const dirty = await api.readBuildIdentity(root);
    assert.equal(dirty.integrity, 'mismatch');
    const b = await api.writeBuildManifest(root);
    assert.equal(a.version, b.version);
    assert.notEqual(a.buildId, b.buildId);
    assert.notEqual(a.skillSha256, b.skillSha256);
    assert.ok(!JSON.stringify(b).includes(root));
    await writeFile(join(root, 'skills/.DS_Store'), 'finder');
    await assert.rejects(api.writeBuildManifest(root), /excluded.*payload/i);
    await rm(join(root, 'skills/.DS_Store'));
    for (const name of ['with space', 'plus+', 'at@', '한글']) {
      const path = join(root, 'skills', name);
      await writeFile(path, 'payload');
      await assert.rejects(api.writeBuildManifest(root), /unsupported.*name/i);
      await rm(path);
    }
    const manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8'));
    manifest.files['../../outside'] = '0'.repeat(64);
    await writeFile(join(root, 'build-manifest.json'), JSON.stringify(manifest));
    assert.equal((await api.readBuildIdentity(root)).integrity, 'invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed broker diagnostics are distinguished from an unavailable desktop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-invalid-diagnostic-'));
  const config = { endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\wu-invalid-${randomUUID()}` : join(directory, 'invalid.sock'), token: 'fixture', pid: process.pid };
  let response = null;
  const broker = await startBroker({ ...config, handler: async () => response });
  try {
    await writeFile(join(directory, 'server.json'), JSON.stringify(config));
    for (response of [null, false, 42, 'invalid', []]) {
      const report = await requestDesktop({ command: 'doctor' }, { directory });
      assert.equal(report.desktop.code, 'invalid_response');
      assert.equal(report.desktop.ok, false);
      assert.equal(report.identities.installation.integrity, 'verified');
      await assert.rejects(requestDesktop({ command: 'status' }, { directory }), { code: 'invalid_response' });
    }
  } finally { await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('server identity is pinned at start and disk drift blocks native work', async () => {
  const api = await import('../src/build-identity.mjs').catch(() => ({}));
  assert.equal(typeof api.readBuildIdentity, 'function', 'build identity is required');
  const initial = await api.readBuildIdentity();
  const directory = await mkdtemp(join(tmpdir(), 'wu-id-server-'));
  let disk = initial, calls = 0;
  const desktop = await startDesktop({ directory, identityReader: async () => disk, handler: async () => ({ calls: ++calls }) });
  try {
    const first = await requestDesktop({ command: 'doctor' }, { directory });
    assert.equal(first.identities.server.buildId, initial.buildId);
    assert.equal(first.identities.installation.buildId, initial.buildId);
    disk = { ...initial, buildId: 'f'.repeat(64) };
    const status = await requestDesktop({ command: 'status' }, { directory });
    assert.equal(status.identities.server.buildId, initial.buildId);
    const report = await requestDesktop({ command: 'doctor' }, { directory });
    assert.equal(report.desktop.ok, false);
    assert.equal(report.desktop.code, 'restart_required');
    await assert.rejects(requestDesktop({ command: 'apps' }, { directory }), { code: 'restart_required' });
    assert.equal(calls, 1);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('server fences a request when restart or pause changed the preflight identity', async () => {
  const { readBuildIdentity } = await import('../src/build-identity.mjs');
  const identity = await readBuildIdentity();
  const directory = await mkdtemp(join(tmpdir(), 'wu-id-fence-'));
  let calls = 0;
  const desktop = await startDesktop({ directory, handler: async () => { calls++; return {}; } });
  try {
    const before = await requestDesktop({ command: 'status' }, { directory });
    const request = { command: 'click', callerIdentity: identity,
      expectedServerBuildId: identity.buildId, expectedAccessEpoch: before.accessEpoch };
    await desktop.setPaused(true);
    await desktop.setPaused(false);
    await assert.rejects(requestDesktop(request, { directory }), { code: 'server_changed' });
    const now = await requestDesktop({ command: 'status' }, { directory });
    await assert.rejects(requestDesktop({ ...request, expectedAccessEpoch: now.accessEpoch,
      expectedServerBuildId: '0'.repeat(64) }, { directory }), { code: 'server_changed' });
    assert.equal(calls, 0);
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('RPC never dispatches guarded input to a legacy broker replacing the preflight server', async () => {
  const { readBuildIdentity } = await import('../src/build-identity.mjs');
  const identity = await readBuildIdentity();
  const directory = await mkdtemp(join(tmpdir(), 'wu-legacy-race-'));
  const config = { endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\wu-legacy-${randomUUID()}` : join(directory, 'legacy.sock'), token: 'fixture', pid: process.pid };
  let actions = 0;
  const broker = await startBroker({ ...config, handler: async request => {
    if (request.command !== 'status') actions++;
    return { state: 'running' };
  } });
  try {
    await writeFile(join(directory, 'server.json'), JSON.stringify(config));
    await assert.rejects(requestDesktop({ command: 'click', callerIdentity: identity,
      expectedServerBuildId: identity.buildId, expectedAccessEpoch: 'previous:0' }, { directory }), { code: 'unsupported_protocol' });
    assert.equal(actions, 0);
  } finally { await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pause during asynchronous disk verification prevents native dispatch', async () => {
  const { readBuildIdentity } = await import('../src/build-identity.mjs');
  const identity = await readBuildIdentity();
  const directory = await mkdtemp(join(tmpdir(), 'wu-id-paused-'));
  let checks = 0, entered, release, calls = 0;
  const checking = new Promise(resolve => { entered = resolve; });
  const desktop = await startDesktop({ directory, identityReader: async () => {
    if (++checks > 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return identity;
  }, handler: async () => { calls++; return {}; } });
  try {
    const pending = requestDesktop({ command: 'click' }, { directory });
    const assertion = assert.rejects(pending, { code: 'desktop_paused' });
    await checking;
    const pausing = desktop.setPaused(true);
    release(); await pausing; await assertion;
    assert.equal(calls, 0);
  } finally { release?.(); await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('doctor does not expose native diagnostic paths or private error details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-id-private-'));
  const desktop = await startDesktop({ directory, handler: async () => { throw new Error('C:\\Users\\private\\token-data'); } });
  try {
    const report = await requestDesktop({ command: 'doctor' }, { directory });
    assert.equal(report.desktop.ok, false);
    assert.equal(report.desktop.code, 'desktop_probe_failed');
    assert.ok(!JSON.stringify(report).includes('private'));
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});
