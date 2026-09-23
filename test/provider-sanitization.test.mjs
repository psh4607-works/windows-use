import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Compile the same source helper used by the distribution without exposing test
// hooks in the public provider API. Provider/IPC tests separately exercise dist.
const built = await build({ entryPoints: ['vendor/orca/src/main/computer/desktop-script-observation-safety.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22' });
const { sanitizeResponse, redactStrings } = await import(`data:text/javascript;charset=utf-8;base64,${Buffer.from(built.outputFiles[0].text, 'utf8').toString('base64')}`);

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

test('whitespace-only secrets mask sensitive fields without rewriting unrelated free text', () => {
  const publicText = 'version1. ordinary edit value';
  for (const secret of [' ', '\t', '\n', '\u3000', ' \t ']) {
    assert.equal(redactStrings(publicText, [secret]), publicText);
    const clean = sanitizeResponse({ ok: true, snapshot: {
      elements: [{ index: 2, isSensitive: true, value: secret }, { index: 3, isSensitive: false, value: publicText }],
      treeLines: [`2 edit ${secret}`, `3 edit ${publicText}`], windowTitle: publicText
    } }, [secret]);
    assert.equal(clean.snapshot.elements[0].value, '[redacted]');
    assert.equal(clean.snapshot.elements[1].value, publicText);
    assert.equal(clean.snapshot.treeLines[0], '2 [redacted]');
    assert.equal(clean.snapshot.treeLines[1], `3 edit ${publicText}`);
    assert.equal(clean.snapshot.windowTitle, publicText);
  }
});

test('ordinary verification is preserved without explicit secrets or sensitive elements', () => {
  for (const snapshot of [undefined, { elements: [{ index: 2, isSensitive: false, value: 'public' }] }]) {
    const verification = { state: 'verified', property: 'value', expected: 'public', actualPreview: 'public' };
    const response = { ok: true, snapshot, action: { path: 'accessibility', verification } };
    assert.deepEqual(sanitizeResponse(response, []).action.verification, verification);
  }
});

test('interior newlines preserve public row structure and collapse sensitive rows', () => {
  const secret = 'SYNTHETIC_SECRET';
  const clean = sanitizeResponse({ ok: true, snapshot: {
    elements: [{ index: 2, isSensitive: true, value: secret }, { index: 3, isSensitive: false, value: 'ordinary value' }],
    treeLines: [`  2 edit line1\n${secret}`, `\t3\t edit line1\n${secret} ordinary value`]
  } });
  assert.deepEqual(clean.snapshot.treeLines, ['  2 [redacted]', '\t3\t edit line1\n[redacted] ordinary value']);
});
