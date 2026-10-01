import { randomUUID } from 'node:crypto';
import { queryError } from './query.mjs';
const sessionValid = session => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session ?? '');
const identity = window => {
  if (!Number.isSafeInteger(window.id) || window.id <= 0 || !Number.isSafeInteger(window.app?.pid) ||
      window.app.pid <= 0 || typeof window.processInstance !== 'string' || !window.processInstance) {
    throw queryError('invalid_observation', 'Desktop inventory requires a native HWND, PID and process instance for every window.');
  }
  return JSON.stringify([window.app.pid, window.processInstance, window.id]);
};
export function createWindowInventory({ now = Date.now, ttlMs = 120000 } = {}) {
  const entries = new Map();
  return {
    capture(session, epoch, windows) {
      if (!sessionValid(session)) throw queryError('invalid_inventory', 'A valid session is required for a desktop inventory.');
      for (const [token, entry] of entries) if (entry.expiresAt <= now()) entries.delete(token);
      const token = randomUUID(), expiresAt = now() + ttlMs;
      entries.set(token, { session, epoch, expiresAt, windows: new Set(windows.map(identity)) });
      return { token, expiresAt };
    },
    after(token, session, epoch, windows) {
      const saved = entries.get(token);
      if (!saved || saved.session !== session || saved.epoch !== epoch) throw queryError('invalid_inventory', 'Desktop inventory is unknown or belongs to a different session or desktop access epoch.');
      if (saved.expiresAt <= now()) { entries.delete(token); throw queryError('inventory_expired', 'Desktop inventory expired; capture a new inventory before opening the destination.'); }
      return windows.filter(window => !saved.windows.has(identity(window)));
    }
  };
}
