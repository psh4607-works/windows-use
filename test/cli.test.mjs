import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/windows-use.mjs', import.meta.url));
test('installed CLI exposes help without requiring Orca or a Windows desktop', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /windows-use/);
  assert.match(result.stdout, /--host/);
});
test('RPC rejects unknown operations with structured JSON and a nonzero exit', () => {
  const result = spawnSync(process.execPath, [cli, 'rpc'], { encoding: 'utf8', input: JSON.stringify({ command: 'delete-everything' }) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\{/, 'RPC must return structured JSON');
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.match(response.error.message, /Unknown command/);
});
