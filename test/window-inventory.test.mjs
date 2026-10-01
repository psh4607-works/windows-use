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
