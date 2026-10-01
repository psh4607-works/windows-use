import { randomUUID } from 'node:crypto';
import { queryError } from './query.mjs';
const sessionValid = session => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session ?? '');
const identity = window => {
  if (!Number.isSafeInteger(window?.id) || window.id <= 0 || !Number.isSafeInteger(window.app?.pid) || window.app.pid <= 0) {
    throw queryError('invalid_observation', 'Desktop inventory requires a native HWND and PID for every window.');
  }
  return { key: JSON.stringify([window.app.pid, window.id]),
    instance: typeof window.processInstance === 'string' && window.processInstance
      ? JSON.stringify([window.app.pid, window.processInstance, window.id]) : null };
};
export function createWindowInventory({ now = Date.now, ttlMs = 120000 } = {}) {
  const entries = new Map();
  return {
    capture(session, epoch, windows) {
      if (!sessionValid(session)) throw queryError('invalid_inventory', 'A valid session is required for a desktop inventory.');
      for (const [token, entry] of entries) if (entry.expiresAt <= now()) entries.delete(token);
      const token = randomUUID(), expiresAt = now() + ttlMs;
      const observed = windows.map(identity);
      entries.set(token, { session, epoch, expiresAt,
        windows: new Set(observed.map(window => window.instance).filter(Boolean)),
        blocked: new Set(observed.filter(window => !window.instance).map(window => window.key)) });
      return { token, expiresAt };
    },
    after(token, session, epoch, windows) {
      const saved = entries.get(token);
      if (!saved || saved.session !== session || saved.epoch !== epoch) throw queryError('invalid_inventory', 'Desktop inventory is unknown or belongs to a different session or desktop access epoch.');
      if (saved.expiresAt <= now()) { entries.delete(token); throw queryError('inventory_expired', 'Desktop inventory expired; capture a new inventory before opening the destination.'); }
      const observed = windows.map(identity);
      // A missing process instance makes PID/HWND reuse ambiguous for this token,
      // even if a later observation can read the instance again.
      for (const current of observed) if (!current.instance) saved.blocked.add(current.key);
      return windows.filter((window, index) => {
        const current = observed[index];
        return current.instance && !saved.blocked.has(current.key) && !saved.windows.has(current.instance);
      });
    }
  };
}
