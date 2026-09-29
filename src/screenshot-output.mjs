import { access, lstat, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

// This only catches predictable errors. The final write must still use wx:
// another process can change the destination after this check.
export async function preflightScreenshot(path) {
  try {
    let existing;
    try { existing = await lstat(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) throw Object.assign(new Error('Screenshot output already exists.'), { code: 'EEXIST' });
    const parent = dirname(path);
    if (!(await stat(parent)).isDirectory()) {
      throw Object.assign(new Error('Screenshot parent is not a directory.'), { code: 'ENOTDIR' });
    }
    // Node's access check does not evaluate Windows ACLs. A denied write can
    // still fail after the desktop action; saveScreenshot preserves that result.
    await access(parent, constants.W_OK | constants.X_OK);
  } catch (error) {
    error.screenshotOutput = { status: 'failed', stage: 'preflight', path };
    throw error;
  }
}

export async function saveScreenshot(result, path) {
  const { data, ...metadata } = result?.screenshot ?? {};
  // Keep input/observation evidence even when capture or local persistence fails.
  // Raw image data is only for the RPC hop, never the caller's JSON output.
  const preserved = result?.screenshot ? { ...result, screenshot: metadata } : result ?? null;
  const stage = data ? 'save' : 'capture';
  try {
    if (!data) throw Object.assign(new Error(result?.screenshotStatus?.message ?? 'Screenshot was not captured'), { code: 'screenshot_missing' });
    await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 });
    return { ok: true, result: { ...preserved, screenshot: { ...metadata, path } },
      screenshotOutput: { status: 'saved', path } };
  } catch (error) {
    return { ok: false, result: preserved,
      error: { code: error.code ?? 'windows_use_error', message: `${error.message} The desktop result is preserved; inspect it before any new input. Do not replay input to retry the screenshot.` },
      screenshotOutput: { status: 'failed', stage, path } };
  }
}
