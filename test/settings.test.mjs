import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('connection settings round-trip without credentials and reject SSH directive injection', async () => {
  const module = await import('../src/settings.mjs').catch(() => ({}));
  assert.equal(typeof module.saveSettings, 'function', 'connection settings persistence is required');
  const directory = await mkdtemp(join(tmpdir(), 'wu-settings-'));
  try {
    const settings = { paused: true, connection: { alias: 'windows-pc', hostname: 'pc.example.com', port: 2222, username: 'DOMAIN\\user' } };
    await module.saveSettings(directory, settings);
    assert.deepEqual(await module.loadSettings(directory), settings);
    const info = module.connectionInstructions(settings.connection);
    assert.match(info.sshConfig, /Host windows-pc/);
    assert.match(info.sshConfig, /Port 2222/);
    assert.equal(info.command, 'windows-use doctor --host windows-pc');
    for (const invalid of [{ port: 0 }, { hostname: 'pc\nProxyCommand evil' }, { alias: '-oProxyCommand=evil' }, { username: 'user"\nMatch all' }, { password: 'secret' }]) {
      await assert.rejects(module.saveSettings(directory, { ...settings, connection: { ...settings.connection, ...invalid } }));
    }
    assert.deepEqual(await module.loadSettings(directory), settings, 'invalid settings must not replace the saved profile');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('damaged and incompatible settings stay intact and name the recovery file and action', async () => {
  const { loadSettings } = await import('../src/settings.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wu-corrupt-settings-'));
  const path = join(directory, 'settings.json');
  try {
    for (const contents of ['{"paused":', JSON.stringify({ paused: true, obsoleteSchema: 1 })]) {
      await writeFile(path, contents);
      await assert.rejects(loadSettings(directory), error => {
        assert.ok(error.message.includes(path));
        assert.match(error.message, /Back up.*repair.*remove.*restart/);
        return true;
      });
      assert.equal(await readFile(path, 'utf8'), contents);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Korean Windows computer and account names are accepted without allowing SSH config injection', async () => {
  const { validateSettings, connectionInstructions } = await import('../src/settings.mjs');
  const settings = { paused: false, connection: { alias: 'windows-pc', hostname: '테스트컴퓨터', port: 22, username: '홍길동' } };
  assert.deepEqual(validateSettings(settings), settings);
  assert.match(connectionInstructions(settings.connection).sshConfig, /HostName 테스트컴퓨터/);
  assert.throws(() => validateSettings({ ...settings, connection: { ...settings.connection, hostname: '컴퓨터\nProxyCommand evil' } }), /hostname/i);
});
