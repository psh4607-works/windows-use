// Explicit live test against test/windows-transition-fixture.ps1 only.
// node test/windows-transition-smoke.mjs <host> <remote-package> <remote-home> <source-pid> <remote-state-directory> <evidence-directory>
// Run with a fresh evidence directory. No desktop pointer input is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [host, remotePackage, remoteHome, sourcePid, stateDirectory, evidenceDirectory] = process.argv.slice(2);
assert.match(host ?? '', /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/);
assert.match(sourcePid ?? '', /^\d+$/);
for (const value of [remotePackage, remoteHome, stateDirectory, evidenceDirectory]) {
  assert.ok(value && !/[\r\n\0\u2018-\u201b]/.test(value), 'All six arguments are required');
}
const evidence = resolve(evidenceDirectory);
await mkdir(evidence, { recursive: true });
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/windows-use.mjs', import.meta.url));
const session = `transition-${sourcePid}-${Date.now()}`;
const common = ['--host', host, '--remote-dir', remotePackage, '--remote-home', remoteHome, '--session', session];
let observation;
let step = 0;
const pinnedWindows = new Map();
function target(app, windowId = pinnedWindows.get(String(app))) {
  assert.ok(Number.isSafeInteger(windowId) && windowId > 0, 'Target must have an observed HWND');
  return ['--app', String(app), '--window-id', String(windowId)];
}
async function run(command, args = [], { reject = false, screenshot = false } = {}) {
  const filename = `${String(++step).padStart(2, '0')}-${command}`;
  const argv = [cli, command, ...common, ...args];
  if (observation && !['windows', 'snapshot', 'query', 'wait-for'].includes(command)) argv.push('--observation', observation);
  if (screenshot) argv.push('--screenshot', join(evidence, `${filename}.png`));
  let stdout;
  try { ({ stdout } = await execute(process.execPath, argv, { timeout: 70000, maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  const response = JSON.parse(stdout);
  await writeFile(join(evidence, `${filename}.json`), JSON.stringify(response, null, 2));
  if (reject) {
    assert.equal(response.ok, false, `${command} must refuse input to an unfocused element`);
    return response;
  }
  assert.equal(response.ok, true, `${command}: ${JSON.stringify(response.error)}`);
  if (response.result.session?.observation) observation = response.result.session.observation;
  return response.result;
}
async function state(mode) {
  const path = `${stateDirectory.replace(/[\\/]$/, '')}/${mode}.json`;
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-Content -Raw -Encoding UTF8 -LiteralPath '${path.replaceAll("'", "''")}'`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host,
    `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`], { timeout: 20000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
function selector(name) {
  const role = new Map([
    ['Test Servers', 'ControlType.TreeItem'],
    ['Test Server A', 'ControlType.TreeItem'],
    ['Test Server B', 'ControlType.TreeItem'],
    ['Connect', 'ControlType.MenuItem'],
    ['Destination input', 'ControlType.Edit'],
    ['Close fixture', 'ControlType.Button'],
  ]).get(name);
  assert.ok(role, `Fixture selector must declare a semantic role: ${name}`);
  return ['--name', name, '--role', role];
}
async function find(app, name, windowId, action) {
  const result = await run('query', [...target(app, windowId), ...selector(name)]);
  assert.equal(result.query.complete, true);
  assert.equal(result.query.matchCount, 1, `Expected unique ${name}`);
  const match = result.query.matches[0];
  assert.equal(match.isEnabled, true, `${name} must be enabled`);
  if (action) assert.ok(match.actions.includes(action), `${name} must expose ${action}`);
  return match.index;
}
async function invoke(app, name, action, windowId, { restoreWindow = true } = {}) {
  const index = await find(app, name, windowId, action);
  return run('invoke', [...target(app, windowId), '--element', String(index), '--action', action,
    ...(restoreWindow ? ['--restore-window'] : [])]);
}

const initialState = await state('source');
assert.equal(initialState.fixture, 'windows-transition');
assert.equal(initialState.pid, Number(sourcePid));
assert.equal(initialState.closed, false);
assert.equal(initialState.connects, 0, 'Use a fresh fixture');
assert.equal(initialState.expanded, 0, 'Tree must begin collapsed');
const sourceWindows = await run('windows', ['--app', sourcePid]);
const sourceMatches = sourceWindows.windows.filter(window => window.title === initialState.title);
assert.equal(sourceMatches.length, 1, 'Expected one exact source fixture window');
pinnedWindows.set(sourcePid, sourceMatches[0].id);
const initial = await run('snapshot', target(sourcePid), { screenshot: true });
assert.equal(initial.snapshot.window.title, initialState.title);
await invoke(sourcePid, 'Test Servers', 'Expand');
await invoke(sourcePid, 'Test Server A', 'Select');
const selectedA = await state('source');
await writeFile(join(evidence, 'selected-a-state.json'), JSON.stringify(selectedA, null, 2));
assert.equal(selectedA.selected, 'Test Server A');
assert.equal(selectedA.connects, 0, 'Selecting A must not activate Connect');
await invoke(sourcePid, 'Test Server B', 'Select');
const selected = await state('source');
await writeFile(join(evidence, 'selected-b-state.json'), JSON.stringify(selected, null, 2));
assert.equal(selected.selected, 'Test Server B');
assert.equal(selected.expanded, 1);
// Activating a WPF TreeView may select its root before explicit Select actions.
// Prove the requested A -> B transition without assuming that extra event is absent.
assert.ok(selectedA.selections >= 1);
assert.ok(selected.selections > selectedA.selections, 'Selecting B must change the selection after A');
assert.ok(selected.events.filter(event => event.event === 'select').length >= 2);
assert.equal(selected.connects, 0, 'Selection must not activate Connect');

// An existing unrelated PowerShell window must not be mistaken for the newly launched destination.
const decoy = await state('decoy');
assert.notEqual(decoy.pid, Number(sourcePid));
const inventory = await run('windows', ['--all']);
assert.ok(inventory.inventory?.token, 'Global inventory must return a transition token');
await invoke(sourcePid, 'Test Server B', 'Focus');
const selectedIndex = await find(sourcePid, 'Test Server B');
await run('hotkey', [...target(sourcePid), '--element', String(selectedIndex), '--key', 'Shift+F10', '--restore-window']);
// WPF can expose a ContextMenu as a separate owned HWND. Inspect every observed
// source-process window. The same native menu item may also be exposed through
// its owner's accessibility tree; deduplicate by native identity, then pin the
// unique newly opened owned popup and freshly query there before acting.
const menuWindows = await run('windows', ['--app', sourcePid]);
const connectMatches = [];
for (const window of menuWindows.windows) {
  const result = await run('query', [...target(sourcePid, window.id), ...selector('Connect')]);
  assert.equal(result.query.complete, true, 'Menu discovery requires complete observations');
  for (const match of result.query.matches) {
    assert.equal(match.isEnabled, true, 'Connect must be enabled');
    assert.ok(match.actions.includes('Invoke'), 'Connect must expose Invoke');
    assert.ok(Array.isArray(match.identity) && match.identity.length > 0, 'Connect must have a native identity');
    connectMatches.push({ windowId: window.id, index: match.index, identity: match.identity });
  }
}
assert.equal(new Set(connectMatches.map(match => JSON.stringify(match.identity))).size, 1,
  'Expected exactly one distinct native Connect element across observed windows');
const previousWindowIds = new Set(sourceWindows.windows.map(window => window.id));
const sourceWindowId = pinnedWindows.get(sourcePid);
const newOwnedPopups = menuWindows.windows.filter(window => !previousWindowIds.has(window.id) &&
  (window.ownerWindowId === sourceWindowId || window.rootOwnerWindowId === sourceWindowId));
assert.equal(newOwnedPopups.length, 1, 'Expected one newly opened popup owned by the source window');
const menuWindowId = newOwnedPopups[0].id;
assert.equal(connectMatches.filter(match => match.windowId === menuWindowId).length, 1,
  'The new owned popup must expose exactly one Connect match');
await run('snapshot', target(sourcePid, menuWindowId), { screenshot: true });
await invoke(sourcePid, 'Connect', 'Invoke', menuWindowId, { restoreWindow: false });
const destinationTitle = `windows-use Transition Destination ${initialState.runId}`;
const arrived = await run('wait-for', ['--condition', 'window', '--after-inventory', inventory.inventory.token,
  '--window-title', destinationTitle, '--timeout-ms', '15000', '--poll-ms', '200']);
const destinationPid = arrived.snapshot.app.pid;
pinnedWindows.set(String(destinationPid), arrived.snapshot.window.id);
assert.notEqual(destinationPid, Number(sourcePid));
assert.notEqual(destinationPid, decoy.pid);
assert.equal(arrived.snapshot.window.title, destinationTitle);
const destination = await state('destination');
assert.equal(destination.pid, destinationPid);
assert.equal((await state('source')).connects, 1);

const inputIndex = await find(destinationPid, 'Destination input');
const refused = await run('type-text', [...target(destinationPid), '--element', String(inputIndex),
  '--text', 'MUST NOT APPEAR', '--restore-window'], { reject: true });
assert.match(`${refused.error.code} ${refused.error.message}`, /focus/i, 'Refusal must specifically report focus mismatch');
const afterRefusal = await state('destination');
assert.equal(afterRefusal.text, 'initial');
assert.equal(afterRefusal.otherText, 'untouched');
await invoke(destinationPid, 'Destination input', 'Focus');
const focusedIndex = await find(destinationPid, 'Destination input');
await run('hotkey', [...target(destinationPid), '--element', String(focusedIndex), '--key', 'Ctrl+a', '--restore-window']);
const expected = `transition ${initialState.runId} 한글🙂`;
const freshIndex = await find(destinationPid, 'Destination input');
await run('type-text', [...target(destinationPid), '--element', String(freshIndex), '--text', expected, '--restore-window']);
const finalSnapshot = await run('snapshot', target(destinationPid), { screenshot: true });
const finalState = await state('destination');
assert.equal(finalState.text, expected);
assert.equal(finalState.otherText, 'untouched');
assert.ok(finalState.focuses >= 1);
assert.ok(finalSnapshot.snapshot.treeText.includes(expected));
const finalDecoy = await state('decoy');
assert.equal(finalDecoy.text, 'initial');
assert.equal(finalDecoy.otherText, 'untouched');
await writeFile(join(evidence, 'verified-state.json'), JSON.stringify({ source: await state('source'), destination: finalState, decoy: finalDecoy }, null, 2));
await invoke(destinationPid, 'Close fixture', 'Invoke');
await invoke(sourcePid, 'Close fixture', 'Invoke');
assert.equal((await state('source')).closed, true);
assert.equal((await state('destination')).closed, true);
const summary = { ok: true, test: 'direct Windows selection, context menu, cross-process transition and focused input', evidence, steps: step };
await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
