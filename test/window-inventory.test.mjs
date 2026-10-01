import test from 'node:test';
import assert from 'node:assert/strict';
const { createWindowInventory } = await import('../src/window-inventory.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const old = { id: 1, app: { pid: 42, name: 'fixture' }, processInstance: 'start-a', title: 'Old' };
const fresh = { id: 2, app: { pid: 43, name: 'other' }, processInstance: 'start-b', title: 'Destination' };
test('inventory survives actions but is scoped to session, epoch, expiry and native process instance', () => {
  assert.equal(typeof createWindowInventory, 'function', 'desktop inventory baseline API exists');
  let time = 100;
  const inventory = createWindowInventory({ now: () => time });
  const saved = inventory.capture('task', 'epoch', [old]);
  assert.equal(typeof saved.token, 'string');
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [old, fresh]), [fresh]);
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [{ ...old, processInstance: 'restarted' }]).length, 1);
  assert.throws(() => inventory.after(saved.token, 'other', 'epoch', [fresh]), /inventory/i);
  assert.throws(() => inventory.after(saved.token, 'task', 'other', [fresh]), /inventory/i);
  time = saved.expiresAt;
  assert.throws(() => inventory.after(saved.token, 'task', 'epoch', [fresh]), /expired/i);
});

test('an unavailable baseline process identity does not block unrelated windows or become a new candidate after recovery', () => {
  const inventory = createWindowInventory();
  const unavailable = { ...old, processInstance: null };
  const saved = inventory.capture('task', 'epoch', [unavailable]);
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [unavailable, fresh]), [fresh]);
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [old, fresh]), [fresh]);
});

test('identity loss during polling excludes only that PID and HWND for the remaining token lifetime', () => {
  const inventory = createWindowInventory();
  const saved = inventory.capture('task', 'epoch', [old]);
  const unavailable = { id: 3, app: { pid: 44 }, processInstance: null };
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [
    { ...old, processInstance: null }, unavailable, fresh
  ]), [fresh]);
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', []), []);
  const sameProcessNewWindow = { ...old, id: 4 };
  const sameHandleNewProcess = { ...old, app: { pid: 45 }, processInstance: 'other' };
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [
    old, { ...old, processInstance: 'restarted' }, { ...unavailable, processInstance: 'available' },
    fresh, sameProcessNewWindow, sameHandleNewProcess
  ]), [fresh, sameProcessNewWindow, sameHandleNewProcess]);
});

test('unknown process instances never excuse missing or invalid native HWND and PID', () => {
  const inventory = createWindowInventory();
  const saved = inventory.capture('task', 'epoch', []);
  for (const window of [null, {}, { ...old, id: null }, { ...old, id: 0 }, { ...old, id: 1.5 },
    { ...old, app: null }, { ...old, app: { pid: null } }, { ...old, app: { pid: 0 } },
    { ...old, app: { pid: '42' }, processInstance: null }]) {
    assert.throws(() => inventory.capture('task', 'epoch', [window]), error => error.code === 'invalid_observation');
    assert.throws(() => inventory.after(saved.token, 'task', 'epoch', [fresh, window]), error => error.code === 'invalid_observation');
  }
});

test('an invalid poll does not change the saved inventory before rejecting', () => {
  const inventory = createWindowInventory();
  const saved = inventory.capture('task', 'epoch', []);
  assert.throws(() => inventory.after(saved.token, 'task', 'epoch', [
    { ...fresh, processInstance: null }, { ...old, id: null }
  ]), error => error.code === 'invalid_observation');
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [fresh]), [fresh]);
});

test('blocked identities expire with their token and do not affect a new inventory', () => {
  let time = 0;
  const inventory = createWindowInventory({ now: () => time, ttlMs: 10 });
  const saved = inventory.capture('task', 'epoch', [{ ...old, processInstance: null }]);
  const restarted = { ...old, processInstance: 'restarted' };
  assert.deepEqual(inventory.after(saved.token, 'task', 'epoch', [restarted]), []);
  time = saved.expiresAt;
  assert.throws(() => inventory.after(saved.token, 'task', 'epoch', [restarted]), error => error.code === 'inventory_expired');
  const next = inventory.capture('task', 'epoch', [old]);
  assert.deepEqual(inventory.after(next.token, 'task', 'epoch', [restarted]), [restarted]);
});
