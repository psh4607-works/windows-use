import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

test('packaging refuses a tampered runtime and emits only exact owned-file uninstall operations', async () => {
  const module = await import('../scripts/windows-package-lib.mjs').catch(() => ({}));
  assert.equal(typeof module.verifySha256, 'function', 'bundled runtime verification is required');
  const bytes = Buffer.from('verified release');
  const expected = createHash('sha256').update(bytes).digest('hex');
  module.verifySha256(bytes, expected);
  assert.throws(() => module.verifySha256(Buffer.from('tampered'), expected), /checksum/i);
  const uninstall = module.uninstallScript(['WindowsUse.exe', 'runtime/node.exe']);
  assert.match(uninstall, /Delete "\$INSTDIR\\runtime\\node.exe"/);
  assert.doesNotMatch(uninstall, /\/r|\*/);
  for (const path of ['../outside', 'runtime/../../outside', '$TEMP/file', 'bad\nDelete file', 'C:/outside']) {
    assert.throws(() => module.uninstallScript([path]), /path/i);
  }
});
