import { mkdir, open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lockObservations, readInputRevision, advanceInputRevision, validateObservationState } from './observation-revision.mjs';
import { DesktopScriptProviderClient } from '../dist/provider.mjs';

const ACTIONS = { click: 'click', 'type-text': 'typeText', 'press-key': 'pressKey', hotkey: 'hotkey', 'paste-text': 'pasteText', 'set-value': 'setValue', invoke: 'performSecondaryAction', scroll: 'scroll', drag: 'drag' };
export const COMMANDS = ['capabilities', 'apps', 'windows', 'snapshot', ...Object.keys(ACTIONS)];
export const SESSION_TTL_MS = 120000;

function defaultProvider() {
  if (process.platform !== 'win32') throw new Error('Windows desktop required; use --host for an installed remote Windows CLI.');
  const script = join(dirname(fileURLToPath(import.meta.url)), '../native/computer-use-windows/runtime.ps1');
  return new DesktopScriptProviderClient('windows', script);
}

export async function executeRequest(request, {
  stateDir = join(homedir(), '.windows-use', 'state'), providerFactory = defaultProvider, now = Date.now
} = {}) {
  if (!request || !COMMANDS.includes(request.command)) throw new Error('Unknown command');
  const params = { noScreenshot: true, ...request.params };
  if (params.accessibility !== undefined && !['uia', 'msaa'].includes(params.accessibility)) throw new Error('Invalid accessibility backend');
  if (['capabilities', 'apps', 'windows'].includes(request.command)) {
    const provider = providerFactory();
    try {
      if (request.command === 'capabilities') return await provider.capabilities();
      if (request.command === 'apps') return await provider.listApps();
      return await provider.listWindows(params);
    } finally { provider.shutdown(); }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.session ?? '')) throw new Error('A session of 1-64 letters, digits, hyphens or underscores is required.');
  if (typeof params.app !== 'string' || !params.app.trim()) throw new Error('An app is required.');
  if ((['scroll', 'drag'].includes(request.command) || params.x !== undefined || params.y !== undefined) && params.allowPointer !== true) throw new Error('Pointer actions require --allow-pointer and explicit user authorization.');

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, `${request.session}.json`);
  const release = await lockObservations(stateDir);
  const sessionLockPath = join(stateDir, `${request.session}.lock`);
  let sessionLock, provider;
  try {
    try { sessionLock = await open(sessionLockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Session is busy; wait for its active owner.'); throw error; }
    let inputRevision = await readInputRevision(stateDir, request.command === 'snapshot');
    provider = providerFactory();
    if (request.command !== 'snapshot') {
      let saved;
      try { saved = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) throw new Error('Take a fresh snapshot in this session before acting.'); throw error; }
      validateObservationState(saved, inputRevision);
      if (saved.expiresAt <= now()) throw new Error('Snapshot expired; take a fresh snapshot.');
      if (!request.observation || request.observation !== saved.observation) throw new Error('Observation changed or is missing; use the latest observation token.');
      if (params.app !== saved.app) throw new Error('Snapshot belongs to a different app; take a fresh snapshot.');
      const observedAccessibility = saved.accessibility ?? 'uia';
      if (params.accessibility !== undefined && params.accessibility !== observedAccessibility) throw new Error('Accessibility backend changed; take a fresh snapshot.');
      params.accessibility = observedAccessibility;
      for (const [key, snapshot] of saved.snapshots) provider.snapshots.set(key, snapshot);
    }
    params.accessibility ??= 'uia';
    let method = ACTIONS[request.command];
    if (request.command === 'click' && params.allowPointer !== true) {
      if (params.clickCount > 1 || params.modifiers || (params.mouseButton && params.mouseButton !== 'left')) throw new Error('Modified pointer clicks require --allow-pointer.');
      const element = [...provider.snapshots.values()].flatMap(snapshot => snapshot.elements ?? []).find(item => item.index === params.elementIndex);
      const action = ['Invoke', 'Select', 'Toggle'].find(name => element?.actions?.includes(name));
      if (!action) throw new Error('Element has no supported accessible click action. Pointer fallback requires --allow-pointer and explicit user authorization.');
      method = 'performSecondaryAction';
      params.action = action;
    }
    if (request.command === 'click') { params.clickCount ??= 1; params.mouseButton ??= 'left'; }
    if (request.command === 'scroll') params.pages ??= 1;
    // Consume the observation before input: a lost response must not permit replay.
    if (request.command !== 'snapshot' || params.restoreWindow === true) {
      inputRevision = await advanceInputRevision(stateDir);
      await rm(statePath, { force: true });
    }
    const result = request.command === 'snapshot'
      ? await provider.snapshot(params)
      : await provider.action(method, params);
    const observation = randomUUID();
    const expiresAt = now() + SESSION_TTL_MS;
    const snapshots = [...provider.snapshots].map(([key, snapshot]) => [key, { ...snapshot, screenshotPngBase64: null }]);
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 2, inputRevision, app: params.app, accessibility: params.accessibility, observation, expiresAt, snapshots }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, statePath);
    } finally { await rm(temporary, { force: true }); }
    return { ...result, session: { id: request.session, observation, expiresAt, accessibility: params.accessibility } };
  } finally {
    try { provider?.shutdown(); }
    finally {
      try { if (sessionLock) { await sessionLock.close(); await rm(sessionLockPath, { force: true }); } }
      finally { await release(); }
    }
  }
}
