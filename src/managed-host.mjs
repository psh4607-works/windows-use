import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startDesktop, requestDesktop } from './desktop.mjs';
import { probeSsh } from './diagnostics.mjs';
import { loadSettings, saveSettings, validateSettings, connectionInstructions } from './settings.mjs';

export async function runManagedHost({ directory = process.env.WINDOWS_USE_HOME || join(homedir(), '.windows-use'),
  input = process.stdin, output = process.stdout, start = startDesktop, save = saveSettings } = {}) {
  let settings = await loadSettings(directory);
  const desktop = await start({ directory, paused: settings.paused, recoverStale: true });
  const view = () => ({ status: desktop.status(), settings, ...connectionInstructions(settings.connection) });
  const send = response => output.write(`${JSON.stringify(response)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  send({ event: 'ready', ok: true, result: view() });
  try {
    for await (const line of lines) {
      let request;
      try {
        if (Buffer.byteLength(line) > 32768) throw new Error('Control request is too large');
        request = JSON.parse(line);
        if (!Number.isSafeInteger(request.id)) throw new Error('A numeric request id is required');
        if (request.command === 'quit') { send({ id: request.id, ok: true, result: view() }); break; }
        if (request.command === 'diagnose') {
          const connection = request.connection ? validateSettings({ paused: settings.paused, connection: request.connection }).connection : settings.connection;
          const [desktopCheck, ssh] = await Promise.all([
            requestDesktop({ command: 'doctor' }, { directory }), probeSsh(connection.port)
          ]);
          send({ id: request.id, ok: true, result: { ...view(), diagnostics: { desktop: desktopCheck.desktop, ssh } } });
          continue;
        }
        if (['pause', 'resume'].includes(request.command)) {
          const next = { ...settings, paused: request.command === 'pause' };
          if (next.paused) {
            // A successful pause must survive a crash or a later restart.
            // Even if storage fails, retain the pause intent and revoke access.
            settings = next;
            let saveError;
            try { settings = await save(directory, next); }
            catch (error) { saveError = error; }
            try { await desktop.setPaused(true); }
            catch (error) {
              if (saveError) throw new Error(`${saveError.message}; Pausing also failed: ${error.message}`, { cause: saveError });
              throw error;
            }
            if (saveError) throw new Error(`Desktop access is paused, but the pause could not be saved: ${saveError.message}. A restart may resume access; fix the storage problem and pause again before restarting.`, { cause: saveError });
          } else if (settings.paused) {
            // Keep the durable pause until access has resumed successfully.
            try {
              await desktop.setPaused(false);
              settings = await save(directory, next);
            } catch (error) {
              try { await desktop.setPaused(true); }
              catch (rollbackError) { throw new Error(`${error.message}; Restoring pause also failed: ${rollbackError.message}`, { cause: error }); }
              throw error;
            }
          }
        } else if (request.command === 'settings') {
          settings = await save(directory, { ...settings, connection: request.connection });
        } else if (request.command !== 'status') throw new Error('Unknown local control command');
        send({ id: request.id, ok: true, result: view() });
      } catch (error) { send({ id: request?.id, ok: false, error: { message: error.message } }); }
    }
  } finally { lines.close(); await desktop.close(); }
}
