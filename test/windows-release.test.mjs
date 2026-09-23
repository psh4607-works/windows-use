import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const available = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error;
for (const suite of ['plan', 'safety', 'native', 'live']) {
  test(`release ${suite}: isolated PowerShell assertions`, { skip: !available }, () => {
    const r = spawnSync('pwsh', ['-NoProfile', '-File', `test/windows-release-${suite}.test.ps1`], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /fixture assertions passed/);
  });
}

test('release entry point records unsupported host without running Windows mutations', { skip: !available || process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'wu-release-entry-'));
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/verify-windows-release.ps1', '-RunDirectory', join(root, 'run')], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1);
    const raw = await readFile(join(root, 'run', 'result.json'), 'utf8');
    const report = JSON.parse(raw.replace(/^\uFEFF/, ''));
    assert.equal(report.status, 'failed');
    assert.equal(report.requiredPassed, false);
    assert.equal(report.steps[0].id, 'preflight');
    assert.equal(report.steps[0].status, 'failed');
    assert.equal(report.steps.at(-1).id, 'cleanup');
    assert.ok(report.steps.slice(1).every(s => s.status === 'skipped'));
    assert.equal(report.evidence, 'windows');
    assert.equal(report.environment.windows, false);
    assert.ok(!raw.includes(root));
    assert.doesNotMatch(raw, /username|hostname|endpoint|token|stack/i);
    assert.equal(r.stderr, '');
    const schema = JSON.parse(await readFile('docs/windows-release-result.schema.json', 'utf8'));
    for (const key of schema.required) assert.ok(Object.hasOwn(report, key), `missing ${key}`);
    const again = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/verify-windows-release.ps1', '-RunDirectory', join(root, 'run')], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.equal(await readFile(join(root, 'run', 'result.json'), 'utf8'), raw, 'existing result overwritten');
  } finally { await rm(root, { recursive: true, force: true }); }
});
