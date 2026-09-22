import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateSettings(value) {
  if (!value || typeof value.paused !== 'boolean' || !value.connection) throw new Error('Invalid client settings');
  const connection = value.connection;
  if (Object.keys(value).some(key => !['paused', 'connection'].includes(key)) ||
      Object.keys(connection).some(key => !['alias', 'hostname', 'port', 'username'].includes(key))) throw new Error('Unknown setting; credentials are managed by SSH');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(connection.alias ?? '')) throw new Error('SSH alias must contain 1–64 letters, digits, dots, underscores or hyphens');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,252}$/u.test(connection.hostname ?? '')) throw new Error('Enter a hostname or IP address, without a URL or spaces');
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) throw new Error('SSH port must be between 1 and 65535');
  if (!/^[\p{L}\p{N}_.@\\ -]{1,128}$/u.test(connection.username ?? '')) throw new Error('Enter a Windows SSH username');
  return { paused: value.paused, connection: { ...connection } };
}

export async function loadSettings(directory) {
  const path = join(directory, 'settings.json');
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read client settings: ${path}. Check file permissions and storage. (${error.code})`, { cause: error });
    return validateSettings({ paused: false, connection: { alias: 'windows-pc', hostname: hostname(), port: 22, username: userInfo().username } });
  }
  try { return validateSettings(JSON.parse(contents)); }
  catch (error) {
    // Do not reset a damaged pause setting to the default (access enabled).
    throw new Error(`Client settings are damaged or incompatible: ${path}. Back up the file, then repair or remove it and restart Windows Use. Removing it resets connection settings and the paused state.`, { cause: error });
  }
}

export async function saveSettings(directory, settings) {
  const value = validateSettings(settings);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `settings.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'settings.json'));
  } finally { await rm(temporary, { force: true }); }
  return value;
}

export function connectionInstructions(connection) {
  validateSettings({ paused: false, connection });
  return {
    sshConfig: `Host ${connection.alias}\n    HostName ${connection.hostname}\n    User "${connection.username}"\n    Port ${connection.port}\n`,
    command: `windows-use doctor --host ${connection.alias}`
  };
}
