import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

test('local connection test requires an SSH banner and clearly distinguishes listener readiness from remote authentication', async () => {
  const module = await import('../src/diagnostics.mjs').catch(() => ({}));
  assert.equal(typeof module.probeSsh, 'function', 'SSH readiness probe is required');
  let banner = 'SSH-2.0-OpenSSH_for_Windows_9.5\r\n';
  const server = createServer(socket => { socket.on('error', () => {}); socket.end(banner); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const success = await module.probeSsh(port);
    assert.equal(success.ok, true);
    assert.match(success.message, /authentication.*not.*tested/i);
    banner = 'HTTP/1.1 200 OK\r\n';
    assert.equal((await module.probeSsh(port)).ok, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
