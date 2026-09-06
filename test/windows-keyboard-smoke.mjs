// Explicit live test: run only against the focused input in our disposable WPF fixture.
// node test/windows-keyboard-smoke.mjs <SSH-host> <fixture-PID>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const [host, app] = process.argv.slice(2);
assert.match(host ?? '', /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
assert.match(app ?? '', /^\d+$/);
const cli = fileURLToPath(new URL('../bin/windows-use.mjs', import.meta.url));
const target = ['--host', host, '--app', app, '--session', 'windows-keyboard-live-smoke'];
let observation;
async function run(command, args = []) {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, command, ...target, ...args,
    ...(observation && command !== 'snapshot' ? ['--observation', observation] : [])], { timeout: 70000 });
  const response = JSON.parse(stdout);
  assert.equal(response.ok, true);
  observation = response.result.session.observation;
  return response.result;
}
const initial = await run('snapshot');
assert.match(initial.snapshot.window.title, /^windows-use Smoke /, 'Refuse to type into a non-test window');
await run('hotkey', ['--key', 'Ctrl+a', '--restore-window']);
const expected = 'keyboard smoke 한글🙂';
await run('type-text', ['--text', expected, '--restore-window']);
const observed = await run('snapshot');
assert.ok(observed.snapshot.treeText.includes(`Value: ${expected},`),
  `Unicode input did not round-trip: ${observed.snapshot.treeText}`);
console.log(JSON.stringify({ ok: true, test: 'live Windows Unicode keyboard round-trip', expected }));
