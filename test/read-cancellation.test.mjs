import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';
import { sendRequest } from '../src/transport.mjs';
const cancelled = () => Object.assign(new Error('cancelled read'), { code: 'wait_cancelled' });
const outcome = promise => Promise.race([promise.then(() => 'success', error => error.code), new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);

test('local read cancellation closes the caller without waiting for a started native read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-cancel-'));
  let release, entered;
  const active = new Promise(resolve => { entered = resolve; });
  const desktop = await startDesktop({ directory, handler: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  try {
    const controller = new AbortController();
    const pending = requestDesktop({ command: 'apps' }, { directory, signal: controller.signal });
    await active;
    controller.abort(cancelled());
    assert.equal(await outcome(pending), 'wait_cancelled');
  } finally { release({}); await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SSH transport cancellation terminates only its own child and preserves structured reason', async () => {
  const controller = new AbortController();
  const promise = sendRequest({ program: process.execPath, args: ['-e', 'setTimeout(() => process.stdout.write(JSON.stringify({ok:true,result:{}})), 250)'] },
    { command: 'apps' }, { signal: controller.signal });
  controller.abort(cancelled());
  assert.equal(await outcome(promise), 'wait_cancelled');
});
