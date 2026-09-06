import { createServer, createConnection } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const MAX_REQUEST = 2 * 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const envelope = error => ({ ok: false, error: { code: error.code ?? 'windows_use_error', message: error.message } });

export async function startBroker({ endpoint, token, handler }) {
  let queue = Promise.resolve();
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let data = '', bytes = 0, received = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (received) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST) { socket.destroy(); return; }
      data += chunk;
      if (!data.includes('\n')) return;
      received = true;
      socket.setTimeout(0);
      let value;
      try {
        value = JSON.parse(data);
        const candidate = Buffer.from(typeof value.token === 'string' ? value.token : '');
        const expected = Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error('Unauthorized desktop broker request');
      } catch (error) { socket.end(`${JSON.stringify(envelope(error))}\n`); return; }
      queue = queue.then(async () => {
        if (socket.destroyed) return;
        let response;
        try { response = { ok: true, result: await handler(value.request) }; }
        catch (error) { response = envelope(error); }
        const text = JSON.stringify(response);
        socket.end(`${Buffer.byteLength(text) <= MAX_RESPONSE ? text : JSON.stringify(envelope(new Error('Desktop response exceeds size limit')))}\n`);
      }).catch(() => socket.destroy());
    });
    socket.once('end', () => { if (!received) socket.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  return { close: async () => {
    // Finish accepted desktop work before closing its transport.
    await queue;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

export async function callBroker(request, { endpoint, token, timeoutMs = 60000 }) {
  const input = JSON.stringify({ token, request });
  if (Buffer.byteLength(input) > MAX_REQUEST) throw new Error('Request exceeds 2 MiB');
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let data = '', bytes = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error('Desktop broker timeout; action outcome is unverifiable. Re-observe before retrying.')));
    // Windows named pipes do not support the Unix half-close request pattern.
    // Keep both directions open and delimit each JSON message explicitly.
    socket.once('connect', () => socket.write(`${input}\n`));
    socket.on('error', error => finish(error));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE) { finish(new Error('Desktop response exceeds size limit')); return; }
      data += chunk;
      if (!data.includes('\n')) return;
      try {
        const response = JSON.parse(data);
        if (!response.ok) throw Object.assign(new Error(response.error?.message ?? 'Desktop broker failed'), { code: response.error?.code });
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.once('end', () => { if (!settled) finish(new Error('Desktop broker closed before a complete response; action outcome is unverifiable. Re-observe before retrying.')); });
    socket.once('close', () => { if (!settled) finish(new Error('Desktop broker disconnected; action outcome is unverifiable. Re-observe before retrying.')); });
  });
}
