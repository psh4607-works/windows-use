import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync('dotnet', ['run', '--project', fileURLToPath(new URL('../windows/BridgeTests', import.meta.url)), '--',
  process.execPath, fileURLToPath(new URL('../test/managed-host-fixture.mjs', import.meta.url))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
