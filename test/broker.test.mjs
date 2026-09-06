import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startBroker, callBroker } from '../src/broker.mjs';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';

test('IPC responds to a complete fragmented request without requiring the client to half-close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-frame-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\wu-test-${randomUUID()}` : join(directory, 'socket');
  const token = 'a'.repeat(64);
  let broker, socket;
  try {
    broker = await startBroker({ endpoint, token, handler: async request => ({ text: request.text }) });
    const response = await new Promise((resolve, reject) => {
      socket = createConnection(endpoint);
      let data = '';
      socket.setEncoding('utf8');
      socket.setTimeout(500, () => reject(new Error('Broker waited for a half-close instead of processing the complete request')));
      socket.on('error', reject);
      socket.on('data', chunk => {
        data += chunk;
        if (data.includes('\n')) resolve(JSON.parse(data.trim()));
      });
      socket.once('connect', () => {
        const input = Buffer.from(`${JSON.stringify({ token, request: { text: '한글🙂\nsecond line' } })}\n`);
        socket.write(input.subarray(0, input.length - 4));
        setTimeout(() => socket.write(input.subarray(input.length - 4)), 10);
      });
    });
    assert.deepEqual(response, { ok: true, result: { text: '한글🙂\nsecond line' } });
  } finally { socket?.destroy(); await broker?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('authenticated IPC routes SSH-side requests to one desktop owner and rejects the wrong token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-ipc-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\wu-test-${process.pid}` : join(directory, 'socket');
  let concurrent = 0, maxConcurrent = 0;
  let broker;
  try {
    broker = await startBroker({ endpoint, token: 'a'.repeat(64), handler: async request => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      concurrent--; return { desktop: 'interactive', request };
    } });
    const options = { endpoint, token: 'a'.repeat(64) };
    const result = await Promise.all([callBroker({ command: 'apps' }, options), callBroker({ command: 'snapshot' }, options)]);
    assert.equal(result[0].desktop, 'interactive');
    assert.equal(maxConcurrent, 1);
    await assert.rejects(callBroker({ command: 'apps' }, { endpoint, token: 'b'.repeat(64) }), /unauthorized/i);
  } finally { await broker?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('desktop registration is discovered by a separate caller and removed on shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wu-registration-'));
  let desktop;
  try {
    desktop = await startDesktop({ directory, handler: async request => ({ command: request.command, owner: 'desktop' }) });
    assert.deepEqual(await requestDesktop({ command: 'apps' }, { directory }), { command: 'apps', owner: 'desktop' });
    await assert.rejects(startDesktop({ directory }), /already|existing/i);
    await desktop.close(); desktop = null;
    await assert.rejects(requestDesktop({ command: 'apps' }, { directory }), /serve/i);
  } finally { await desktop?.close(); await rm(directory, { recursive: true, force: true }); }
});
