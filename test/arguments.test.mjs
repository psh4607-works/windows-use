import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli } from '../src/arguments.mjs';
import { sshInvocation } from '../src/ssh.mjs';

test('CLI selects a named accessibility backend and rejects unknown backends', () => {
  assert.equal(parseCli(['snapshot', '--accessibility', 'msaa']).request.params.accessibility, 'msaa');
  assert.equal(parseCli(['snapshot', '--accessibility', 'uia']).request.params.accessibility, 'uia');
  assert.throws(() => parseCli(['snapshot', '--accessibility', 'typo']), /accessibility/i);
});

test('CLI preserves text as data and translates element and window options', () => {
  const parsed = parseCli(['set-value', '--host', 'windows-pc', '--session', 'task-a', '--observation', 'abc', '--app', 'Notepad', '--element', '4', '--window-id', '1234', '--value', '$HOME `x` 한국어', '--json']);
  assert.deepEqual(parsed.request, { command: 'set-value', session: 'task-a', observation: 'abc', params: { app: 'Notepad', elementIndex: 4, windowId: 1234, value: '$HOME `x` 한국어', noScreenshot: true } });
  assert.equal(parsed.host, 'windows-pc');
  assert.throws(() => parseCli(['click', '--element', '1e2']), /element/i);
  assert.throws(() => parseCli(['snapshot', '--unknown']), /unknown/i);
});

test('SSH discovers the installed client and uses its bundled Node without depending on PATH', () => {
  const script = Buffer.from(sshInvocation('windows-pc').args.at(-1).split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /LOCALAPPDATA/);
  assert.match(script, /Programs[\\/]WindowsUse/);
  assert.match(script, /runtime[\\/]node\.exe/);
  assert.match(script, /Test-Path/);
  assert.match(script, /\.windows-use\/app/);
});

test('SSH sends a fixed encoded launcher and never embeds UI text in the command', () => {
  const invocation = sshInvocation('windows-pc', "C:/Tools/User's Windows Use");
  assert.equal(invocation.program, 'ssh');
  assert.ok(invocation.args.includes('BatchMode=yes'));
  assert.ok(invocation.args.includes('--'));
  const encoded = invocation.args.at(-1).split(' ').at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /User''s Windows Use/);
  assert.match(script, /rpc/);
  assert.doesNotMatch(script, /ExecutionPolicy|Set-ExecutionPolicy/i);
  assert.throws(() => sshInvocation('-oProxyCommand=bad'), /host/i);
});

test('desktop inventory CLI carries all and after-inventory only on supported read commands', () => {
  assert.equal(parseCli(['windows', '--all', '--session', 'task']).request.params.all, true);
  assert.equal(parseCli(['wait-for', '--condition', 'window', '--after-inventory', 'token', '--window-title', 'Exact', '--session', 'task']).request.params.afterInventory, 'token');
  assert.throws(() => parseCli(['click', '--all']), /windows/);
  assert.throws(() => parseCli(['snapshot', '--after-inventory', 'token']), /wait-for/);
});
