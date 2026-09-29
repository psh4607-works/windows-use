import test from 'node:test';
import assert from 'node:assert/strict';
import { readBuildIdentity } from '../src/build-identity.mjs';
import { sshInvocation } from '../src/ssh.mjs';
import { parseCli } from '../src/arguments.mjs';

async function api() {
  const value = await import('../src/identity-protocol.mjs').catch(() => ({}));
  assert.equal(typeof value.identityReader, 'function', 'caller compatibility preflight is required');
  return value;
}

test('legacy servers remain diagnosable but never receive query, wait reads, or input', async () => {
  const { identityReader } = await api();
  const caller = await readBuildIdentity();
  const calls = [];
  const read = identityReader(async request => {
    calls.push(request.command);
    return { state: 'running', desktop: { ok: true } };
  }, caller);
  const doctor = await read({ command: 'doctor' });
  assert.equal(doctor.identities.caller.buildId, caller.buildId);
  assert.equal(doctor.identities.server, null);
  assert.equal(doctor.build.ok, false);
  for (const request of [{ command: 'query' }, { command: 'windows', trackAccess: true },
    { command: 'click' }, { command: 'snapshot', params: { restoreWindow: true } }]) {
    await assert.rejects(read(request), { code: 'unsupported_protocol' });
  }
  assert.deepEqual(calls, ['doctor', 'status', 'status', 'status', 'status']);
  await read({ command: 'apps' });
  assert.equal(calls.at(-1), 'apps');
});

test('caller, remote installation and server builds survive independently and pin dispatch', async () => {
  const { identityReader } = await api();
  const a = await readBuildIdentity();
  const b = { ...a, buildId: 'b'.repeat(64) }, c = { ...a, buildId: 'c'.repeat(64) };
  let sent;
  const read = identityReader(async request => {
    if (['doctor', 'status'].includes(request.command)) return { state: 'running', accessEpoch: 'instance:0', desktop: { ok: true }, identities: { installation: b, server: c } };
    sent = request; return { accepted: true };
  }, a);
  const doctor = await read({ command: 'doctor' });
  assert.equal(doctor.identities.caller.buildId, a.buildId);
  assert.equal(doctor.identities.installation.buildId, b.buildId);
  assert.equal(doctor.identities.server.buildId, c.buildId);
  assert.equal(doctor.build.ok, false);
  assert.equal(doctor.build.compatible, true);
  await read({ command: 'query' });
  assert.equal(sent.expectedServerBuildId, c.buildId);
  assert.equal(sent.expectedAccessEpoch, 'instance:0');
});

test('same build is healthy; capability differences fail before dispatch', async () => {
  const { identityReader } = await api();
  const caller = await readBuildIdentity();
  let server = caller, calls = 0;
  const read = identityReader(async request => {
    if (['status', 'doctor'].includes(request.command)) return { accessEpoch: 'owner:0', desktop: { ok: true }, identities: { installation: server, server } };
    calls++; return {};
  }, caller);
  assert.equal((await read({ command: 'doctor' })).build.ok, true);
  server = { ...caller, capabilities: { ...caller.capabilities, query: 0 } };
  await assert.rejects(read({ command: 'query' }), { code: 'unsupported_capability' });
  assert.equal(calls, 0);
});

test('isolated SSH calls select the same explicit state home as their desktop server', () => {
  const options = parseCli(['doctor', '--host', 'fixture', '--remote-home', "C:\\fixture's state"]);
  assert.equal(options.remoteHome, "C:\\fixture's state");
  const invocation = sshInvocation(options.host, undefined, options.remoteHome);
  const script = Buffer.from(invocation.args.at(-1).split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("$env:WINDOWS_USE_HOME='C:\\fixture''s state'"));
  assert.throws(() => sshInvocation('fixture', undefined, 'bad\nvalue'), /home/i);
});

test('guarded SSH requests use a separate RPC verb that legacy CLI cannot forward', () => {
  const invocation = sshInvocation('fixture', undefined, undefined, true);
  const script = Buffer.from(invocation.args.at(-1).split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /\$entry identity-rpc;/);
});

test('doctor reports failed SSH diagnostics without leaking remote stderr paths', async () => {
  const { identityReader } = await api();
  const caller = await readBuildIdentity();
  const read = identityReader(async () => { throw new Error('SSH: C:\\Users\\private\\key'); }, caller);
  const result = await read({ command: 'doctor' });
  assert.equal(result.desktop.ok, false);
  assert.equal(result.identities.caller.buildId, caller.buildId);
  assert.ok(!JSON.stringify(result).includes('private'));
});
