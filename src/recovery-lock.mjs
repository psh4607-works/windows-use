import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Windows releases this exclusive pipe when the owning process dies, including
// hard termination. A persistent lock file cannot provide that guarantee.
export async function acquireRecoveryLock(directory) {
  if (process.platform !== 'win32') throw new Error('Desktop recovery requires Windows');
  const key = createHash('sha256').update((await realpath(directory)).toLowerCase()).digest('hex');
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\\\\.\\pipe\\windows-use-recovery-${key}`, resolve);
  });
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
