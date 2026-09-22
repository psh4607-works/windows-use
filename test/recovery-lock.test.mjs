import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop } from '../src/desktop.mjs';

test('Windows recovery excludes concurrent owners and releases its lock after a hard kill',
  { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wu-native-recovery-'));
    let child, desktop;
    try {
      const dead = spawn(process.execPath, ['-e', '']);
      await once(dead, 'exit');
      await writeFile(join(directory, 'server.json'), JSON.stringify({ pid: dead.pid }));
      await writeFile(join(directory, 'recovery.lock'), 'legacy abandoned file');
      const moduleUrl = new URL('../src/recovery-lock.mjs', import.meta.url).href;
      child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { acquireRecoveryLock } from ${JSON.stringify(moduleUrl)};
         await acquireRecoveryLock(${JSON.stringify(directory.toUpperCase())});
         process.send('locked');`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message),
        once(child, 'exit').then(([code]) => { throw new Error(`Lock holder exited: ${code}`); })
      ]);
      assert.equal(ready, 'locked');
      await assert.rejects(startDesktop({ directory, recoverStale: true }), /existing.*owner/i);
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      child = undefined;
      desktop = await startDesktop({ directory, recoverStale: true, handler: async () => ({}) });
      const owned = await readFile(join(directory, 'server.json'), 'utf8');
      await assert.rejects(startDesktop({ directory, recoverStale: true }), /existing.*owner/i);
      assert.equal(await readFile(join(directory, 'server.json'), 'utf8'), owned);
    } finally {
      if (child && child.exitCode === null) {
        const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
      }
      await desktop?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
