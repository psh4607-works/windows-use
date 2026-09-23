import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { startBroker, callBroker } from './broker.mjs';
import { COMMANDS, executeRequest } from './request.mjs';
import { acquireRecoveryLock } from './recovery-lock.mjs';

const defaultDirectory = () => process.env.WINDOWS_USE_HOME || join(homedir(), '.windows-use');

export async function startDesktop({ directory = defaultDirectory(), handler, paused = false, recoverStale = false,
  acquireRecovery = acquireRecoveryLock } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\windows-use-${randomUUID()}` : join(directory, 'desktop.sock');
  const config = { endpoint, token: randomBytes(32).toString('hex'), pid: process.pid };
  const configPath = join(directory, 'server.json');
  const register = () => writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  try { await register(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const conflict = () => new Error('Existing desktop owner found. Close the existing Windows Use client or windows-use serve process first.');
    if (!recoverStale) throw conflict();
    const assertDeadOwner = async () => {
      let contents;
      try { contents = await readFile(configPath, 'utf8'); }
      catch (readError) { if (readError.code === 'ENOENT') return false; throw readError; }
      let old;
      try {
        old = JSON.parse(contents);
        if (!Number.isInteger(old?.pid) || old.pid <= 0) throw new Error('Invalid owner PID');
      } catch {
        throw new Error(`Invalid desktop registration: ${configPath}. Close all Windows Use clients and windows-use serve processes, then back up and remove this file before restarting. Ownership cannot be verified safely.`);
      }
      let dead = false;
      try { process.kill(old.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
      if (!dead) throw conflict();
      return true;
    };
    await assertDeadOwner();
    // Re-read under an OS-owned lock: a competing recovery must not delete the
    // newly registered live owner. Old recovery.lock files are no longer used.
    const release = await acquireRecovery(directory).catch(lockError => {
      if (lockError.code === 'EADDRINUSE') throw conflict();
      throw lockError;
    });
    try {
      if (await assertDeadOwner()) await rm(configPath, { force: true });
      await register();
    } finally { await release(); }
  }
  let broker, activeRequests = 0, revision = 0;
  const accessInstance = randomUUID();
  const idleWaiters = new Set();
  const stateDir = join(directory, 'state');
  const clearObservations = async () => {
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
  };
  const status = () => ({ state: paused ? 'paused' : 'running', activeRequests, pid: process.pid, accessEpoch: `${accessInstance}:${revision}` });
  const execute = handler ?? (request => executeRequest(request, { stateDir }));
  const rejectPaused = () => { throw Object.assign(new Error('Windows Use is paused or its access state changed. Take a new snapshot after resuming.'), { code: 'desktop_paused' }); };
  const handle = async request => {
    if (request?.command === 'status') return status();
    if (request?.command === 'doctor') {
      if (paused) return { ...status(), desktop: { ok: false, message: 'Windows Use is paused. Resume from the tray to test desktop access.' } };
      activeRequests++;
      try {
        await execute({ command: 'apps', params: { noScreenshot: true } });
        return { ...status(), desktop: { ok: true, message: 'Authenticated desktop IPC and Windows app enumeration succeeded.' } };
      } catch (error) { return { ...status(), desktop: { ok: false, message: error.message } }; }
      finally { activeRequests--; if (!activeRequests) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); } }
    }
    if (paused) rejectPaused();
    activeRequests++;
    try { return await execute(request); }
    finally { activeRequests--; if (!activeRequests) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); } }
  };
  try { await clearObservations(); broker = await startBroker({ ...config, prepare: request => {
    if (!request || ![...COMMANDS, 'status', 'doctor'].includes(request.command)) throw new Error('Unknown command');
    const diagnostic = ['status', 'doctor'].includes(request.command);
    const tracked = request.trackAccess === true;
    if (tracked && (!['windows', 'query', 'snapshot'].includes(request.command) || request.params?.restoreWindow === true)) {
      throw Object.assign(new Error('Access tracking is only supported for reads without focus changes.'), { code: 'invalid_wait' });
    }
    if (paused && !diagnostic) rejectPaused();
    const admitted = revision;
    return async () => {
      if (!diagnostic && admitted !== revision) rejectPaused();
      if (tracked && request.accessEpoch !== undefined && request.accessEpoch !== status().accessEpoch) rejectPaused();
      let result;
      try { result = await handle(request); }
      catch (error) {
        // Preserve the wait's epoch even before the target app appears.
        if (!tracked || request.command !== 'windows' || error.code !== 'app_not_found') throw error;
        result = { windows: [] };
      }
      if (!tracked) return result;
      // A pause may have begun while the native read was in flight. Never stamp
      // that old observation with the new epoch, even if access already resumed.
      if (paused || admitted !== revision) rejectPaused();
      return { ...result, accessEpoch: status().accessEpoch };
    };
  } }); }
  catch (error) { await rm(configPath, { force: true }); throw error; }
  return { status, setPaused: async value => {
    // Revoke new work immediately, then let already-started input finish before clearing observations.
    paused = true;
    revision++;
    if (activeRequests) await new Promise(resolve => idleWaiters.add(resolve));
    await clearObservations();
    paused = Boolean(value);
    return status();
  }, close: async () => {
    paused = true; revision++;
    await broker.close();
    const current = JSON.parse(await readFile(configPath, 'utf8'));
    if (current.token === config.token) await rm(configPath, { force: true });
  } };
}

export async function requestDesktop(request, { directory = defaultDirectory(), timeoutMs, signal } = {}) {
  if (!request || ![...COMMANDS, 'status', 'doctor'].includes(request.command)) throw new Error('Unknown command');
  let config;
  try { config = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Start windows-use serve in an interactive Windows desktop terminal first.'); throw error; }
  try { return await callBroker(request, { ...config, timeoutMs, signal }); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw new Error('Desktop server is unavailable. Start windows-use serve in the Windows desktop session; do not start it over SSH.');
    throw error;
  }
}
