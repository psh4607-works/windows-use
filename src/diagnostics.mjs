import { createConnection } from 'node:net';

export function probeSsh(port, { timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let finished = false, banner = '';
    const finish = result => { if (finished) return; finished = true; socket.destroy(); resolve(result); };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish({ ok: false, message: 'Local SSH listener did not return a banner in time.' }));
    socket.on('error', error => finish({ ok: false, message: `Local SSH listener is unavailable (${error.code ?? 'connection failed'}).` }));
    socket.on('data', chunk => {
      banner += chunk;
      if (/^SSH-2\.0-[^\r\n]+\r?\n/m.test(banner)) finish({ ok: true, message: 'Local SSH listener is ready. Remote routing and authentication were not tested.' });
      else if (banner.length > 4096) finish({ ok: false, message: 'The local port did not return a valid SSH banner.' });
    });
    socket.on('end', () => finish({ ok: false, message: 'The local port closed without a valid SSH banner.' }));
  });
}
