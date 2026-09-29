import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop } from '../src/desktop.mjs';
import { startBroker } from '../src/broker.mjs';
import { randomUUID } from 'node:crypto';

const image = Buffer.from('fixture PNG bytes');
const remote = {
  action: { method: 'typeText', verification: { state: 'unverified', reason: 'synthetic_input' } },
  snapshot: { treeText: 'Editor: typed once', window: { id: 123 } },
  session: { id: 'screenshot-test', observation: 'fresh-after-input' },
  screenshotStatus: { state: 'captured' },
  screenshot: { data: image.toString('base64'), format: 'png', width: 10, height: 10 },
};

function run(directory, output, command = 'type-text') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/windows-use.mjs', command, '--app', 'fixture',
      '--session', 'screenshot-test', '--observation', 'before-input', '--text', 'typed once',
      '--screenshot', output], { env: { ...process.env, WINDOWS_USE_HOME: directory } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      try {
        assert.equal(stderr, '');
        assert.equal(stdout.trim().split('\n').length, 1, 'exactly one JSON response');
        resolve({ code, response: JSON.parse(stdout) });
      } catch (error) { reject(error); }
    });
  });
}

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'wu-shot-'));
  const directory = join(root, 'ipc');
  const outputDir = join(root, 'output');
  await mkdir(outputDir);
  let calls = 0;
  const desktop = await startDesktop({ directory, handler: async request => {
    calls++;
    assert.equal(request.command, 'type-text');
    return handler ? handler({ root, outputDir }) : structuredClone(remote);
  } });
  t.after(async () => {
    await chmod(outputDir, 0o700).catch(() => {});
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, outputDir, directory, calls: () => calls };
}

test('screenshot preflight rejects an existing file without dispatching input or changing bytes', async t => {
  const f = await fixture(t);
  const path = join(f.outputDir, 'existing.png');
  await writeFile(path, 'keep this');
  const { code, response } = await run(f.directory, path);
  assert.equal(code, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EEXIST');
  assert.equal(f.calls(), 0);
  assert.equal(response.result, undefined);
  assert.deepEqual(response.screenshotOutput, { status: 'failed', stage: 'preflight', path });
  assert.equal(await readFile(path, 'utf8'), 'keep this');
});

for (const scenario of ['existing-directory', 'dangling-symlink', 'missing-parent', 'file-parent', 'no-permission']) {
  test(`screenshot preflight rejects ${scenario} before input`, { skip: scenario === 'no-permission' && process.getuid?.() === 0 }, async t => {
    const f = await fixture(t);
    let path = join(f.outputDir, 'image.png');
    let expected = 'EEXIST';
    if (scenario === 'existing-directory') await mkdir(path);
    if (scenario === 'dangling-symlink') {
      if (process.platform === 'win32') return t.skip('symlink creation needs Windows developer mode');
      await symlink(join(f.root, 'absent'), path);
    }
    if (scenario === 'missing-parent') { path = join(f.root, 'missing', 'image.png'); expected = 'ENOENT'; }
    if (scenario === 'file-parent') { await writeFile(path, 'parent'); path = join(path, 'image.png'); expected = 'ENOTDIR'; }
    if (scenario === 'no-permission') {
      if (process.platform === 'win32') return t.skip('POSIX permission fixture');
      await chmod(f.outputDir, 0o500); expected = 'EACCES';
    }
    const { code, response } = await run(f.directory, path);
    assert.equal(code, 1);
    assert.equal(response.error.code, expected);
    assert.equal(response.screenshotOutput.stage, 'preflight');
    assert.equal(response.result, undefined);
    assert.equal(f.calls(), 0);
  });
}

test('save race preserves the received input result and fresh observation without replay', async t => {
  const f = await fixture(t, async ({ outputDir }) => {
    await writeFile(join(outputDir, 'race.png'), 'race winner');
    return structuredClone(remote);
  });
  const path = join(f.outputDir, 'race.png');
  const { code, response } = await run(f.directory, path);
  assert.equal(code, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EEXIST');
  assert.equal(f.calls(), 1);
  assert.deepEqual(response.result?.action, remote.action);
  assert.deepEqual(response.result.snapshot, remote.snapshot);
  assert.deepEqual(response.result.session, remote.session);
  assert.deepEqual(response.result.screenshotStatus, remote.screenshotStatus);
  assert.equal(response.result.screenshot.data, undefined);
  assert.equal(response.result.screenshot.path, undefined);
  assert.deepEqual(response.screenshotOutput, { status: 'failed', stage: 'save', path });
  assert.equal(await readFile(path, 'utf8'), 'race winner');
});

for (const scenario of ['ENOENT', 'ENOTDIR', 'EACCES', 'missing-image']) {
  test(`post-input ${scenario} preserves verification, snapshot and observation`, async t => {
    if (scenario === 'EACCES' && (process.platform === 'win32' || process.getuid?.() === 0)) return t.skip('POSIX permission fixture');
    const f = await fixture(t, async ({ outputDir }) => {
      if (scenario === 'ENOENT') await rm(outputDir, { recursive: true });
      if (scenario === 'ENOTDIR') { await rm(outputDir, { recursive: true }); await writeFile(outputDir, 'replacement parent'); }
      if (scenario === 'EACCES') await chmod(outputDir, 0o500);
      const result = structuredClone(remote);
      if (scenario === 'missing-image') { delete result.screenshot; result.screenshotStatus = { state: 'failed', message: 'capture unavailable' }; }
      return result;
    });
    const path = join(f.outputDir, 'image.png');
    const { code, response } = await run(f.directory, path);
    assert.equal(code, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, scenario === 'missing-image' ? 'screenshot_missing' : scenario);
    assert.match(response.error.message, /Do not replay input/);
    assert.deepEqual(response.result.action, remote.action);
    assert.deepEqual(response.result.snapshot, remote.snapshot);
    assert.deepEqual(response.result.session, remote.session);
    assert.deepEqual(response.result.screenshotStatus, scenario === 'missing-image'
      ? { state: 'failed', message: 'capture unavailable' } : remote.screenshotStatus);
    assert.equal(response.result.screenshot?.data, undefined);
    assert.equal(response.result.screenshot?.path, undefined);
    assert.deepEqual(response.screenshotOutput, { status: 'failed', stage: scenario === 'missing-image' ? 'capture' : 'save', path });
    assert.equal(f.calls(), 1);
  });
}

test('successful screenshot saves exact bytes once and keeps the existing result envelope', async t => {
  const f = await fixture(t);
  const path = join(f.outputDir, 'saved.png');
  const { code, response } = await run(f.directory, path);
  assert.equal(code, 0);
  assert.equal(response.ok, true);
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.action, remote.action);
  assert.deepEqual(response.result.session, remote.session);
  assert.deepEqual(response.result.screenshot, { format: 'png', width: 10, height: 10, path });
  assert.deepEqual(response.screenshotOutput, { status: 'saved', path });
  assert.deepEqual(await readFile(path), image);
  assert.equal(f.calls(), 1);
});

test('desktop errors keep the existing error envelope and do not claim a screenshot failure', async t => {
  const f = await fixture(t, () => { throw Object.assign(new Error('observation expired'), { code: 'stale_observation' }); });
  const { code, response } = await run(f.directory, join(f.outputDir, 'image.png'));
  assert.equal(code, 1);
  assert.deepEqual(response, { ok: false, error: { code: 'stale_observation', message: 'observation expired' } });
  assert.equal(f.calls(), 1);
});

for (const result of [null, undefined, false, 42, 'unexpected response']) {
  test(`missing image in a ${typeof result} response remains a capture-stage failure`, async t => {
    const f = await fixture(t, () => result);
    const path = join(f.outputDir, 'image.png');
    const { code, response } = await run(f.directory, path);
    assert.equal(code, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'screenshot_missing');
    assert.deepEqual(response.screenshotOutput, { status: 'failed', stage: 'capture', path });
    assert.equal(response.result, result ?? null);
    assert.equal(f.calls(), 1);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  });
}

test('doctor with a null broker result preserves build diagnostics with its capture failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-shot-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\windows-use-${randomUUID()}` : join(directory, 'desktop.sock');
  const token = randomUUID();
  let calls = 0;
  const broker = await startBroker({ endpoint, token, handler: request => {
    calls++;
    assert.equal(request.command, 'doctor');
    return null;
  } });
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'server.json'), JSON.stringify({ endpoint, token }));
  const path = join(directory, 'image.png');
  const { code, response } = await run(directory, path, 'doctor');
  assert.equal(code, 1);
  assert.equal(response.ok, false);
  assert.equal(response.result.desktop.ok, false);
  assert.equal(response.result.desktop.code, 'invalid_response');
  assert.equal(response.result.identities.caller.integrity, 'verified');
  assert.equal(response.result.identities.installation.integrity, 'verified');
  assert.equal(response.result.identities.server, null);
  assert.equal(response.result.build.ok, false);
  assert.equal(response.error.code, 'screenshot_missing');
  assert.deepEqual(response.screenshotOutput, { status: 'failed', stage: 'capture', path });
  assert.equal(calls, 1);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('RPC still transports image data without local screenshot preflight or persistence', async t => {
  const f = await fixture(t);
  const path = join(f.outputDir, 'existing.png');
  await writeFile(path, 'keep this');
  const child = execFile(process.execPath, ['bin/windows-use.mjs', 'rpc', '--screenshot', path],
    { env: { ...process.env, WINDOWS_USE_HOME: f.directory } });
  const completed = new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => { try { resolve({ code, response: JSON.parse(stdout) }); } catch (error) { reject(error); } });
  });
  child.stdin.end(JSON.stringify({ command: 'type-text', params: { noScreenshot: false } }));
  const { code, response } = await completed;
  assert.equal(code, 0);
  assert.deepEqual(response, { ok: true, result: remote });
  assert.equal(await readFile(path, 'utf8'), 'keep this');
  assert.equal(f.calls(), 1);
});
