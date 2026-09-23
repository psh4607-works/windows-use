import { open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const stale = () => new Error('Desktop observation changed or is invalid; take a fresh snapshot.');

// Shared by direct executeRequest calls and the broker. A sibling lock survives
// observation-directory resets. Never steal an uncertain/crashed owner's lock.
export async function lockObservations(stateDir, { openFile = open } = {}) {
  const path = `${resolve(stateDir)}.input.lock`;
  let lock;
  try { lock = await openFile(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Desktop observation state is busy; retry after the active request. If its owner crashed, stop all clients before removing the state.input.lock file.');
    throw error;
  }
  return async () => { try { await lock.close(); } finally { await rm(path, { force: true }); } };
}

export async function readInputRevision(stateDir, allowReset = false) {
  try {
    const value = JSON.parse(await readFile(join(stateDir, '.input-revision.json'), 'utf8'));
    if (value?.version === 1 && typeof value.revision === 'string' && /^[0-9a-f-]{36}$/.test(value.revision)) return value.revision;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (!allowReset) throw stale();
  return advanceInputRevision(stateDir);
}

export async function advanceInputRevision(stateDir) {
  const revision = randomUUID();
  const path = join(stateDir, '.input-revision.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, revision }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return revision;
}

export function validateObservationState(saved, revision) {
  if (!saved || saved.version !== 2 || saved.inputRevision !== revision || !Number.isFinite(saved.expiresAt) ||
      !Array.isArray(saved.snapshots) || !saved.snapshots.every(entry => Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object' && Array.isArray(entry[1].elements))) throw stale();
}
