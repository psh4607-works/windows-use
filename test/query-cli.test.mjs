import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli } from '../src/arguments.mjs';

test('CLI exposes exact query selectors and bounded wait options without accepting selectors on actions', () => {
  const query = parseCli(['query', '--app', 'fixture', '--session', 'find', '--role', 'ControlType.Edit', '--name', 'Editor', '--automation-id', 'editor']).request;
  assert.equal(query.params.role, 'ControlType.Edit');
  assert.equal(query.params.name, 'Editor');
  assert.equal(query.params.automationId, 'editor');
  const wait = parseCli(['wait-for', '--condition', 'window', '--window-title', 'Ready', '--timeout-ms', '5000', '--poll-ms', '100']).request;
  assert.equal(wait.params.condition, 'window');
  assert.equal(wait.params.windowTitle, 'Ready');
  assert.equal(wait.params.timeoutMs, 5000);
  assert.equal(wait.params.pollMs, 100);
  assert.throws(() => parseCli(['click', '--name', 'Save']), /query.*wait-for/);
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop } from '../src/desktop.mjs';
function cli(args, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/windows-use.mjs', ...args], { env: { ...process.env, WINDOWS_USE_HOME: directory } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
}
test('real CLI prints a structured timeout with nonzero exit and documents query/wait options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-query-cli-'));
  const desktop = await startDesktop({ directory, handler: async request => {
    assert.equal(request.command, 'windows'); return { windows: [] };
  } });
  try {
    const result = await cli(['wait-for', '--app', 'fixture', '--session', 'wait', '--name', 'Ready', '--timeout-ms', '100', '--poll-ms', '50'], directory);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.output).error.code, 'wait_timeout');
    const help = await cli(['--help'], directory);
    for (const text of ['query', 'wait-for', '--automation-id', '--condition', '--timeout-ms', '--poll-ms']) assert.ok(help.output.includes(text));
  } finally { await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real CLI wait succeeds with a fresh token and SIGINT cancels a later wait', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-wait-cli-'));
  let cancelMode = false, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const desktop = await startDesktop({ directory, handler: async request => {
    if (request.command === 'windows') { if (cancelMode) entered(); return { windows: [{ id: 123 }] }; }
    assert.equal(request.command, 'query');
    return { snapshot: { window: { id: 123 } }, session: { observation: 'fresh' }, query: {
      matches: [{ index: 2 }], matchCount: 1, unique: true, complete: true
    } };
  } });
  let child;
  try {
    const args = ['wait-for', '--app', 'fixture', '--session', 'wait', '--name', 'Ready'];
    const success = await cli(args, directory);
    assert.equal(success.code, 0);
    assert.equal(JSON.parse(success.output).result.session.observation, 'fresh');
    cancelMode = true;
    child = spawn(process.execPath, ['bin/windows-use.mjs', ...args], { env: { ...process.env, WINDOWS_USE_HOME: directory } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    await ready;
    child.kill('SIGINT');
    assert.deepEqual(await exited, { code: 1, signal: null });
    assert.equal(JSON.parse(output).error.code, 'wait_cancelled');
  } finally { child?.kill(); await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});
