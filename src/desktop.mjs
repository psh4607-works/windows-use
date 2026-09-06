import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { startBroker, callBroker } from './broker.mjs';
import { COMMANDS, executeRequest } from './request.mjs';

const defaultDirectory = () => process.env.WINDOWS_USE_HOME || join(homedir(), '.windows-use');

export async function startDesktop({ directory = defaultDirectory(), handler } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\windows-use-${randomUUID()}` : join(directory, 'desktop.sock');
  const config = { endpoint, token: randomBytes(32).toString('hex'), pid: process.pid };
  const configPath = join(directory, 'server.json');
  try { await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Existing desktop registration found. Stop the existing windows-use serve process first; do not start a second owner.'); throw error; }
  let broker;
  try { broker = await startBroker({ ...config, handler: handler ?? (request => executeRequest(request, { stateDir: join(directory, 'state') })) }); }
  catch (error) { await rm(configPath, { force: true }); throw error; }
  return { close: async () => {
    await broker.close();
    const current = JSON.parse(await readFile(configPath, 'utf8'));
    if (current.token === config.token) await rm(configPath, { force: true });
  } };
}

export async function requestDesktop(request, { directory = defaultDirectory() } = {}) {
  if (!request || !COMMANDS.includes(request.command)) throw new Error('Unknown command');
  let config;
  try { config = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Start windows-use serve in an interactive Windows desktop terminal first.'); throw error; }
  try { return await callBroker(request, config); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw new Error('Desktop server is unavailable. Start windows-use serve in the Windows desktop session; do not start it over SSH.');
    throw error;
  }
}
