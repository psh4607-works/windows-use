import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { startBroker, callBroker } from './broker.mjs';
import { COMMANDS, executeRequest } from './request.mjs';
import { lockObservations } from './observation-revision.mjs';
import { acquireRecoveryLock } from './recovery-lock.mjs';
import { readBuildIdentity, sameBuild } from './build-identity.mjs';
import { createWindowInventory } from './window-inventory.mjs';
import { assertCompatible } from './identity-protocol.mjs';

const defaultDirectory = () => process.env.WINDOWS_USE_HOME || join(homedir(), '.windows-use');

export async function startDesktop({ directory = defaultDirectory(), handler, paused = false, recoverStale = false,
  acquireRecovery = acquireRecoveryLock, identityReader = readBuildIdentity } = {}) {
  const serverIdentity = structuredClone(await identityReader());
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
  const inventories = createWindowInventory();
  const idleWaiters = new Set();
  const stateDir = join(directory, 'state');
  const clearObservations = async () => {
    const release = await lockObservations(stateDir);
    try {
      await rm(stateDir, { recursive: true, force: true });
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
    } finally { await release(); }
  };
  const status = () => ({ state: paused ? 'paused' : 'running', activeRequests, pid: process.pid, accessEpoch: `${accessInstance}:${revision}`, identities: { server: serverIdentity } });
  const assertUnchanged = async () => {
    const admitted = revision;
    if (!sameBuild(serverIdentity, await identityReader())) throw Object.assign(new Error('Package files changed or are unverified. Rebuild/reinstall and restart Windows Use in the interactive desktop.'), { code: 'restart_required' });
    if (paused || admitted !== revision) rejectPaused();
  };
  const execute = handler ?? (request => executeRequest(request, { stateDir }));
  const rejectPaused = () => { throw Object.assign(new Error('Windows Use is paused or its access state changed. Take a new snapshot after resuming.'), { code: 'desktop_paused' }); };
  const handle = async request => {
    if (request?.command === 'status') return status();
    if (request?.command === 'doctor') {
      if (paused) return { ...status(), desktop: { ok: false, message: 'Windows Use is paused. Resume from the tray to test desktop access.' } };
      activeRequests++;
      try {
        await assertUnchanged();
        await execute({ command: 'apps', params: { noScreenshot: true } });
        return { ...status(), desktop: { ok: true, message: 'Authenticated desktop IPC and Windows app enumeration succeeded.' } };
      } catch (error) {
        const known = ['restart_required', 'desktop_paused'].includes(error.code);
        return { ...status(), desktop: { ok: false, code: known ? error.code : 'desktop_probe_failed',
          message: known ? error.message : 'Windows desktop app enumeration failed. Inspect the local client diagnostics.' } };
      }
      finally { activeRequests--; if (!activeRequests) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); } }
    }
    if (paused) rejectPaused();
    activeRequests++;
    try { await assertUnchanged(); return await execute(request); }
    finally { activeRequests--; if (!activeRequests) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); } }
  };
  try { await clearObservations(); broker = await startBroker({ ...config, prepare: request => {
    if (!request || ![...COMMANDS, 'status', 'doctor'].includes(request.command)) throw new Error('Unknown command');
    const diagnostic = ['status', 'doctor'].includes(request.command);
    const tracked = request.trackAccess === true;
    if (tracked && (!['windows', 'query', 'snapshot'].includes(request.command) ||
        (request.params?.restoreWindow !== undefined && request.params.restoreWindow !== false))) {
      throw Object.assign(new Error('Access tracking is only supported for reads without focus changes.'), { code: 'invalid_wait' });
    }
    if (paused && !diagnostic) rejectPaused();
    const admitted = revision;
    return async () => {
      if (!diagnostic && request.callerIdentity) {
        assertCompatible(request.callerIdentity, serverIdentity, request);
        if (request.expectedServerBuildId !== serverIdentity.buildId || request.expectedAccessEpoch !== status().accessEpoch) {
          throw Object.assign(new Error('Desktop server changed after compatibility verification. Take a new observation; no input was sent.'), { code: 'server_changed' });
        }
      }
      if (!diagnostic && admitted !== revision) rejectPaused();
      if (tracked && request.accessEpoch !== undefined && request.accessEpoch !== status().accessEpoch) rejectPaused();
      let result;
      try { result = await handle(request); }
      catch (error) {
        // Preserve the wait's epoch even before the target app appears.
        if (!tracked || request.command !== 'windows' || error.code !== 'app_not_found') throw error;
        result = { windows: [] };
      }
      if (request.command === 'windows' && request.params?.all === true) {
        if (result.complete !== true || !Array.isArray(result.observationErrors) || result.observationErrors.length) {
          throw Object.assign(new Error('Desktop window inventory is incomplete; no baseline or destination can be established.'), { code: 'incomplete_observation' });
        }
        if (paused || admitted !== revision) rejectPaused();
        if (request.params.afterInventory !== undefined) {
          result = { ...result, windows: inventories.after(request.params.afterInventory, request.session, status().accessEpoch, result.windows) };
        } else {
          result = { ...result, inventory: inventories.capture(request.session, status().accessEpoch, result.windows) };
        }
        result.accessEpoch = status().accessEpoch;
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
  const deadline = performance.now() + (timeoutMs ?? 60000);
  const limits = () => {
    signal?.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Object.assign(new Error('Desktop request deadline elapsed during compatibility verification.'), { code: 'transport_timeout' });
    return { ...config, timeoutMs: remaining, signal };
  };
  try {
    try { config = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('Start windows-use serve in an interactive Windows desktop terminal first.'), { code: 'desktop_unavailable' }); throw error; }
    if (request.callerIdentity) {
      // Use one captured registration for both calls. In particular, a legacy
      // replacement must never receive input with metadata it would ignore.
      const current = await callBroker({ command: 'status' }, limits());
      assertCompatible(request.callerIdentity, current.identities?.server, request);
      if (current.identities.server.buildId !== request.expectedServerBuildId || current.accessEpoch !== request.expectedAccessEpoch) {
        throw Object.assign(new Error('Desktop server changed after compatibility verification. Observe again before acting.'), { code: 'server_changed' });
      }
    }
    const result = await callBroker(request, limits());
    if (['status', 'doctor'].includes(request.command)) {
      const invalid = value => !value || typeof value !== 'object' || Array.isArray(value);
      if (invalid(result) || (result.identities !== undefined && invalid(result.identities))) throw Object.assign(
        new Error('Desktop server returned an invalid diagnostic response.'), { code: 'invalid_response' });
      return { ...result, identities: { ...result.identities, installation: await readBuildIdentity() } };
    }
    return result;
  }
  catch (error) {
    if (request.command === 'doctor') return { state: 'unavailable',
      desktop: { ok: false, code: error.code === 'invalid_response' ? error.code : 'desktop_unavailable',
        message: error.code === 'invalid_response' ? 'Desktop server returned an invalid diagnostic response.' :
          'Desktop broker is unavailable. Inspect the local client and restart in the interactive desktop session.' },
      identities: { installation: await readBuildIdentity(), server: null } };
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw new Error('Desktop server is unavailable. Start windows-use serve in the Windows desktop session; do not start it over SSH.');
    throw error;
  }
}
