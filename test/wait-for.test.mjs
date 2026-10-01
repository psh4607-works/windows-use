import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../src/wait-for.mjs';
const match = { index: 3, identity: [1, 3], value: 'ready', sensitive: false };
const observed = (matches = [match]) => ({ accessEpoch: 'owner:0', snapshot: { window: { id: 123 } },
  session: { id: 'wait', observation: 'fresh-token' }, query: { matches, matchCount: matches.length, unique: matches.length === 1, complete: true } });
const request = (params = {}) => ({ command: 'wait-for', session: 'wait', params: { app: 'fixture', role: 'ControlType.Edit', ...params } });
function fixture(results = [observed()]) {
  let time = 0, reads = 0;
  const calls = [], sleeps = [];
  return { calls, sleeps, now: () => time,
    advance: ms => { time += ms; }, sleep: async ms => { sleeps.push(ms); time += ms; },
    read: async (req, options) => {
      calls.push({ ...req, options });
      if (req.command === 'status') return { state: 'running', accessEpoch: 'owner:0' };
      if (req.command === 'windows') return { windows: [{ id: 123 }], accessEpoch: 'owner:0' };
      return results[Math.min(reads++, results.length - 1)];
    }
  };
}
test('wait-for immediately returns the fresh unique observation without sleeping or sending input', async () => {
  assert.equal(typeof waitFor, 'function', 'wait-for orchestration must exist');
  const deps = fixture();
  const result = await waitFor(request(), deps);
  assert.equal(result.session.observation, 'fresh-token');
  assert.equal(result.wait.condition, 'element');
  assert.equal(result.wait.polls, 1);
  assert.equal(deps.sleeps.length, 0);
  assert.equal(deps.calls.find(call => call.command === 'query').params.windowId, 123);
  assert.ok(deps.calls.every(call => ['status', 'windows', 'query'].includes(call.command)));
});

test('wait-for polls until delayed satisfaction and respects a monotonic deadline including read time', async () => {
  const delayed = fixture([observed([]), observed()]);
  const result = await waitFor(request({ timeoutMs: 1000, pollMs: 100 }), delayed);
  assert.equal(result.wait.polls, 2);
  assert.deepEqual(delayed.sleeps, [100]);
  const absent = fixture([observed([])]);
  await assert.rejects(waitFor(request({ timeoutMs: 250, pollMs: 100 }), absent), error => error.code === 'wait_timeout');
  assert.deepEqual(absent.sleeps, [100, 100, 50]);
  assert.equal(absent.calls.filter(call => call.command === 'query').length, 3);
  const slow = fixture();
  const read = slow.read;
  slow.read = async (...args) => { const value = await read(...args); slow.advance(250); return value; };
  await assert.rejects(waitFor(request({ timeoutMs: 250 }), slow), error => error.code === 'wait_timeout');
});

test('wait-for rejects unbounded or invalid waits before desktop reads', async () => {
  for (const params of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 600001 }, { pollMs: 0 },
    { pollMs: 1.2 }, { pollMs: 10001 }, { condition: 'typo' }, { condition: 'value' },
    { condition: 'element', value: 'secret' }, { noScreenshot: false }, { accessibility: 'typo' }]) {
    const deps = fixture();
    await assert.rejects(waitFor(request(params), deps), error => error.code === 'invalid_wait' || error.code === 'invalid_query');
    assert.equal(deps.calls.length, 0);
  }
});

test('wait-for pins a unique HWND, rejects ambiguity, and stops when that window closes', async () => {
  const ambiguous = fixture();
  const read = ambiguous.read;
  ambiguous.read = async (req, opts) => req.command === 'windows' ? { windows: [{ id: 123 }, { id: 456 }], accessEpoch: 'owner:0' } : read(req, opts);
  await assert.rejects(waitFor(request(), ambiguous), error => error.code === 'ambiguous_window');
  const closed = fixture([observed([])]);
  const original = closed.read;
  let count = 0;
  closed.read = async (req, opts) => req.command === 'windows' ? { windows: ++count === 1 ? [{ id: 123 }] : [{ id: 456 }], accessEpoch: 'owner:0' } : original(req, opts);
  await assert.rejects(waitFor(request(), closed), error => error.code === 'window_closed');
  assert.equal(closed.calls.filter(call => call.command === 'query').length, 1);
  for (const result of [observed([match, match]), { ...observed(), query: { ...observed().query, complete: false, unique: false } }]) {
    await assert.rejects(waitFor(request(), fixture([result])), error => ['ambiguous_selector', 'incomplete_observation'].includes(error.code));
  }
});

test('window appearance waits through missing apps and returns a fresh observation for the exact title', async () => {
  const deps = fixture();
  let windows = 0;
  const original = deps.read;
  deps.read = async (req, opts) => {
    if (req.command === 'windows') {
      if (++windows === 1) return { windows: [], accessEpoch: 'owner:0' };
      return { windows: [{ id: 123, title: 'Ready' }, { id: 456, title: 'Other' }], accessEpoch: 'owner:0' };
    }
    if (req.command === 'snapshot') { assert.equal(req.params.windowId, 123); return observed(); }
    return original(req, opts);
  };
  const result = await waitFor(request({ role: undefined, condition: 'window', windowTitle: 'Ready' }), deps);
  assert.equal(result.wait.polls, 2);
  assert.equal(result.wait.condition, 'window');
  assert.equal(result.session.observation, 'fresh-token');
});

test('value waits compare exact values and changed waits follow native identity across index changes', async () => {
  const values = fixture([observed([{ ...match, value: 'loading' }]), observed()]);
  assert.equal((await waitFor(request({ condition: 'value', value: 'ready' }), values)).wait.polls, 2);
  const changed = fixture([observed(), observed([{ ...match, index: 8, value: 'updated' }])]);
  assert.equal((await waitFor(request({ condition: 'changed' }), changed)).query.matches[0].index, 8);
  const replaced = fixture([observed(), observed([{ ...match, identity: [1, 99], value: 'updated' }])]);
  await assert.rejects(waitFor(request({ condition: 'changed' }), replaced), error => error.code === 'element_changed');
  for (const element of [{ ...match, identity: null }, { ...match, value: null }, { ...match, value: 'secret', sensitive: true }]) {
    await assert.rejects(waitFor(request({ condition: 'changed' }), fixture([observed([element])])), error => {
      assert.doesNotMatch(error.message, /secret/);
      return ['unsupported_identity', 'unsupported_value', 'sensitive_value'].includes(error.code);
    });
  }
});

test('wait-for rejects paused or changed access epochs, including pause-resume between reads', async () => {
  const paused = fixture();
  paused.read = async () => { throw Object.assign(new Error('paused'), { code: 'desktop_paused' }); };
  await assert.rejects(waitFor(request(), paused), error => error.code === 'desktop_paused');
  const changed = fixture([observed([])]);
  const read = changed.read;
  changed.read = async (req, opts) => {
    const result = await read(req, opts);
    return req.command === 'query' ? { ...result, accessEpoch: 'owner:2' } : result;
  };
  await assert.rejects(waitFor(request(), changed), error => error.code === 'desktop_paused');
  const missing = fixture();
  const original = missing.read;
  missing.read = async (req, opts) => {
    const result = await original(req, opts);
    if (req.command !== 'status') delete result.accessEpoch;
    return result;
  };
  await assert.rejects(waitFor(request(), missing), error => error.code === 'unsupported_wait');
});

test('deadline and cancellation settle even if an in-flight read never responds', async () => {
  const never = () => new Promise(() => {});
  const bounded = promise => Promise.race([promise.then(() => 'success', error => error.code), new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
  assert.equal(await bounded(waitFor(request({ timeoutMs: 20 }), { read: never })), 'wait_timeout');
  const controller = new AbortController();
  const pending = waitFor(request(), { read: never, signal: controller.signal });
  controller.abort();
  assert.equal(await bounded(pending), 'wait_cancelled');
  let calls = 0;
  assert.equal(await bounded(waitFor(request(), { read: async () => { calls++; }, signal: controller.signal })), 'wait_cancelled');
  assert.equal(calls, 0);
});

test('value waits reject truncated values instead of treating a preview as the exact value', async () => {
  const deps = fixture([observed([{ ...match, valueTruncated: true }])]);
  await assert.rejects(waitFor(request({ condition: 'value', value: 'ready' }), deps), error => error.code === 'unsupported_value');
});

test('wait-for refuses silently ignored selectors and returns only the pinned window observation', async () => {
  for (const params of [{ condition: 'window', role: 'ControlType.Edit' }, { name: 'Ready', elementIndex: 3 }, { windowTitle: '' }]) {
    await assert.rejects(waitFor(request(params), fixture()), error => ['invalid_wait', 'invalid_query'].includes(error.code));
  }
  await assert.rejects(waitFor(request(), fixture([{ ...observed(), snapshot: { window: { id: 456 } } }])), error => error.code === 'invalid_observation');
});

test('window waits return observation metadata without a duplicated tree that can contain sensitive labels', async () => {
  const deps = fixture();
  const read = deps.read;
  deps.read = async (req, opts) => req.command === 'snapshot' ? { ...observed(), snapshot: { window: { id: 123 }, treeText: 'secret-label' } } : read(req, opts);
  const result = await waitFor(request({ role: undefined, condition: 'window' }), deps);
  assert.equal(result.snapshot.treeText, undefined);
  assert.doesNotMatch(JSON.stringify(result), /secret-label/);
});

test('wait-for reuses stamped read epochs without standalone status round trips', async () => {
  const deps = fixture();
  await waitFor(request(), deps);
  assert.deepEqual(deps.calls.map(call => call.command), ['windows', 'query']);
  assert.ok(deps.calls.every(call => call.trackAccess === true));
  assert.equal(deps.calls[0].accessEpoch, undefined);
  assert.equal(deps.calls[1].accessEpoch, 'owner:0');
});

test('an old server missing the target app still reports the upgrade guidance before retrying', async () => {
  let reads = 0;
  await assert.rejects(waitFor(request(), { read: async () => {
    reads++;
    throw Object.assign(new Error('private app missing'), { code: 'app_not_found' });
  } }), error => error.code === 'unsupported_wait' && /Update the desktop server/.test(error.message));
  assert.equal(reads, 1);
});

test('an unsupported windows read after a stamped poll keeps the same upgrade guidance', async () => {
  const deps = fixture([observed([])]);
  const original = deps.read;
  let windows = 0;
  deps.read = async (req, options) => {
    if (req.command === 'windows' && ++windows > 1) throw Object.assign(new Error('private app missing'), { code: 'app_not_found' });
    return original(req, options);
  };
  await assert.rejects(waitFor(request(), deps), error => error.code === 'unsupported_wait' && /Update the desktop server/.test(error.message));
  assert.equal(windows, 2);
});

test('new-window wait discovers cross-process exact destination and observes concrete PID', async () => {
  const calls = [];
  const result = await waitFor({ command: 'wait-for', session: 'wait', params: { condition: 'window', afterInventory: 'baseline', windowTitle: 'Destination', app: 'Target.exe' } }, {
    read: async req => {
      calls.push(req);
      if (req.command === 'windows') {
        assert.equal(req.params.all, true);
        assert.equal(req.params.afterInventory, 'baseline');
        return { accessEpoch: 'epoch', windows: [
          { id: 100, title: 'Unrelated', app: { pid: 5, name: 'Other' }, processInstance: 'old' },
          { id: 456, title: 'Destination', app: { pid: 42, name: 'Target' }, processInstance: 'started' }
        ] };
      }
      assert.equal(req.params.app, '42');
      return { accessEpoch: 'epoch', session: { observation: 'fresh' }, snapshot: { window: { id: 456, title: 'Destination' }, app: { pid: 42 }, processInstance: 'started' } };
    }
  });
  assert.equal(result.snapshot.app.pid, 42);
  assert.equal(result.session.observation, 'fresh');
  assert.equal(calls.length, 2);
});

test('new-window wait requires exact destination criteria and refuses instance replacement', async () => {
  const request = { command: 'wait-for', session: 'wait', params: { condition: 'window', afterInventory: 'baseline' } };
  await assert.rejects(waitFor(request, { read: () => assert.fail('must not read') }), error => error.code === 'invalid_wait');
  await assert.rejects(waitFor({ ...request, params: { ...request.params, windowTitle: 'Destination' } }, {
    read: async req => req.command === 'windows' ? { accessEpoch: 'epoch', windows: [{ id: 456, title: 'Destination', app: { pid: 42 }, processInstance: 'first' }] } :
      { accessEpoch: 'epoch', snapshot: { window: { id: 456 }, app: { pid: 42 }, processInstance: 'replacement' } }
  }), error => error.code === 'window_changed');
});

test('new-window wait rejects title changed between enumeration and snapshot', async () => {
  await assert.rejects(waitFor({ command: 'wait-for', session: 'wait', params: { condition: 'window', afterInventory: 'baseline', windowTitle: 'Expected' } }, {
    read: async req => req.command === 'windows' ? { accessEpoch: 'epoch', windows: [{ id: 456, title: 'Expected', app: { pid: 42 }, processInstance: 'start' }] } :
      { accessEpoch: 'epoch', snapshot: { window: { id: 456, title: 'Different target' }, app: { pid: 42 }, processInstance: 'start' } }
  }), error => error.code === 'window_changed');
});
