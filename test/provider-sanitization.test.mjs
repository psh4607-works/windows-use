import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Compile the same source helper used by the distribution without exposing test
// hooks in the public provider API. Provider/IPC tests separately exercise dist.
const built = await build({ entryPoints: ['vendor/orca/src/main/computer/desktop-script-observation-safety.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22' });
const { sanitizeResponse, redactStrings } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

test('explicit secrets redact action verification even without a refreshed snapshot', () => {
  const secret = 'SYNTHETIC_SECRET';
  const response = { ok: true, action: { path: 'accessibility', verification: { state: 'unverified', expected: secret, actualPreview: secret } } };
  const clean = sanitizeResponse(response, [secret]);
  assert.equal(clean.action.verification.expected, '[redacted]');
  assert.equal(clean.action.verification.actualPreview, '[redacted]');
  assert.equal(response.action.verification.expected, secret, 'sanitization must not mutate the source');
});

test('short punctuation-edged secrets apply word boundaries only at word edges', () => {
  for (const [secret, text, expected] of [
    ['.', 'version1.', 'version1[redacted]'],
    ['.a', 'prefix.a', 'prefix[redacted]'],
    ['a.', 'a.suffix', '[redacted]suffix'],
    ['💡', 'a💡b', 'a[redacted]b'],
    ['a+b', 'xa+b', 'xa+b'],
    ['𝔸', 'X𝔸Y', 'X𝔸Y'],
    ['𝔸', ' 𝔸 ', ' [redacted] ']
  ]) assert.equal(redactStrings(text, [secret]), expected);
});
