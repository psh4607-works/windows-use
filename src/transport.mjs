import { spawn } from 'node:child_process';

export async function sendRequest({ program, args }, request, { timeoutMs = 65000, maxOutputBytes = 20 * 1024 * 1024 } = {}) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Request exceeds 2 MiB');
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const stdout = [], stderr = [];
    let bytes = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const terminate = message => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      force.unref(); child.once('close', () => clearTimeout(force));
      finish(new Error(message));
    };
    const timer = setTimeout(() => terminate('SSH timed out; remote action outcome is unverifiable. Observe before retrying.'), timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) { terminate('SSH output exceeded limit; remote action outcome is unverifiable.'); return; }
        chunks.push(chunk);
      });
      stream.on('error', error => finish(error));
    }
    child.stdin.on('error', () => {});
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      let response;
      try { response = JSON.parse(Buffer.concat(stdout).toString('utf8').trim()); }
      catch { finish(new Error(`SSH failed (exit ${code}); remote outcome is unverifiable. ${Buffer.concat(stderr).toString('utf8').slice(0, 1500)}`)); return; }
      if (!response.ok) { finish(Object.assign(new Error(response.error?.message ?? 'Remote command failed'), { code: response.error?.code })); return; }
      if (code !== 0) { finish(new Error(`SSH exited ${code}; remote outcome is unverifiable.`)); return; }
      finish(null, response.result);
    });
    child.stdin.end(input);
  });
}
