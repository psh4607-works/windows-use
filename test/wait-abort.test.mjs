import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from '../src/wait-for.mjs';

const request = timeoutMs => ({ command: 'wait-for', session: 'wait',
  params: { app: 'fixture', name: 'Ready', timeoutMs, pollMs: 50 } });
const read = async () => ({ windows: [], accessEpoch: 'owner:0' });

for (const kind of ['cancel', 'timeout']) {
  test(`a sleep rejection that wins the abort race still returns wait_${kind === 'cancel' ? 'cancelled' : 'timeout'}`, async () => {
    const controller = new AbortController();
    let entered;
    const sleeping = new Promise(resolve => { entered = resolve; });
    // Register before the orchestrator's race listener, with no async/finally
    // wrapper that would defer this rejection to a later microtask.
    const sleep = (_ms, _value, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('adapter aborted'), { code: 'ABORT_ERR' })), { once: true });
      entered();
    });
    const pending = waitFor(request(kind === 'cancel' ? 10000 : 20), { read, sleep, now: () => 0, signal: controller.signal });
    const assertion = assert.rejects(pending, error => error.code === (kind === 'cancel' ? 'wait_cancelled' : 'wait_timeout'));
    await sleeping;
    if (kind === 'cancel') controller.abort();
    await assertion;
  });
}

test('real Node timer sleeps preserve cancellation and deadline error codes', async () => {
  const controller = new AbortController();
  let entered;
  const sleeping = new Promise(resolve => { entered = resolve; });
  const pending = waitFor(request(10000), { read, signal: controller.signal, sleep: (...args) => {
    const timer = delay(...args); entered(); return timer;
  } });
  const assertion = assert.rejects(pending, error => error.code === 'wait_cancelled');
  await sleeping; controller.abort(); await assertion;
  await assert.rejects(waitFor(request(20), { read }), error => error.code === 'wait_timeout');
});

test('an unrelated sleep failure retains its original error', async () => {
  const failure = new Error('fixture sleep failure');
  await assert.rejects(waitFor(request(10000), { read, sleep: async () => { throw failure; } }), error => error === failure);
});
