#!/usr/bin/env node
import { runManagedHost } from '../src/managed-host.mjs';
try {
  if (process.platform !== 'win32') throw new Error('Run the Windows Use client in a logged-in Windows desktop.');
  await runManagedHost();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ event: 'fatal', ok: false, error: { message: error.message } })}\n`);
  process.exitCode = 1;
}
