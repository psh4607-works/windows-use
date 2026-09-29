import { mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifySha256, uninstallScript } from './windows-package-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtime = {
  version: '24.21.0',
  archive: 'node-v24.21.0-win-x64.zip',
  sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
};
const cache = join(root, '.cache', 'windows-package');
const release = join(root, 'release');
const payload = join(release, 'windows-x64');
await mkdir(cache, { recursive: true }); await mkdir(release, { recursive: true });

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${program} exited ${result.status}`);
  }
  return result;
}
async function filesIn(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${item.name}`;
    if (item.isDirectory()) files.push(...await filesIn(join(directory, item.name), `${relative}/`));
    else if (item.isFile()) files.push(relative);
    else throw new Error(`Unsupported package entry: ${relative}`);
  }
  return files.sort();
}

run(process.execPath, ['scripts/build.mjs']);
run(process.env.DOTNET || 'dotnet', ['build', 'windows/WindowsUse/WindowsUse.csproj', '-c', 'Release', `-p:Version=${pkg.version}`, '--nologo']);
const archivePath = join(cache, runtime.archive);
let bytes;
try { bytes = await readFile(archivePath); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(`https://nodejs.org/download/release/v${runtime.version}/${runtime.archive}`);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  verifySha256(bytes, runtime.sha256);
  await writeFile(archivePath, bytes, { flag: 'wx' });
}
verifySha256(bytes, runtime.sha256);
const extracted = join(cache, 'extracted');
await rm(extracted, { recursive: true, force: true }); await mkdir(extracted);
run('tar', ['-xf', archivePath, '-C', extracted]);
await rm(payload, { recursive: true, force: true }); await mkdir(payload);
for (const name of ['bin', 'src', 'dist', 'native', 'skills', 'build-manifest.json', 'package.json', 'LICENSE', 'NOTICE.md', 'README.md', 'provenance.json']) {
  await cp(join(root, name), join(payload, name), { recursive: true });
}
await mkdir(join(payload, 'docs'));
await cp(join(root, 'docs', 'windows-client-verification.md'), join(payload, 'docs', 'windows-client-verification.md'));
const trayBuild = join(root, 'windows', 'WindowsUse', 'bin', 'Release', 'net48');
for (const file of ['WindowsUse.exe', 'WindowsUse.exe.config']) await cp(join(trayBuild, file), join(payload, file));
await mkdir(join(payload, 'runtime'));
const nodeRoot = join(extracted, `node-v${runtime.version}-win-x64`);
await cp(join(nodeRoot, 'node.exe'), join(payload, 'runtime', 'node.exe'));
await cp(join(nodeRoot, 'LICENSE'), join(payload, 'runtime', 'LICENSE.node.txt'));
await writeFile(join(payload, '.windows-use-client'), 'WindowsUse.Client');
await writeFile(join(payload, 'windows-use.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0bin\\windows-use.mjs" %*\r\nexit /b %errorlevel%\r\n');
const hashes = {};
for (const file of await filesIn(payload)) hashes[file] = createHash('sha256').update(await readFile(join(payload, file))).digest('hex');
await writeFile(join(payload, 'package-manifest.json'), `${JSON.stringify({ version: pkg.version, architecture: 'x64', runtime, files: hashes }, null, 2)}\n`);
const uninstallPath = join(cache, 'uninstall-files.nsh');
await writeFile(uninstallPath, uninstallScript(await filesIn(payload)));
const installer = join(release, `WindowsUse-Setup-${pkg.version}-x64.exe`);
const prefix = process.platform === 'win32' ? '/' : '-';
const compiled = run(process.env.MAKENSIS || 'makensis', [
  `${prefix}V4`, `${prefix}DVERSION=${pkg.version}`, `${prefix}DPAYLOAD=${payload}`,
  `${prefix}DOUTPUT=${installer}`, `${prefix}DUNINSTALL_FILES=${uninstallPath}`, 'windows/installer.nsi'
], { stdio: 'pipe', encoding: 'utf8' });
await writeFile(join(release, 'windows-installer-build.log'), compiled.stdout + compiled.stderr);
const hash = createHash('sha256').update(await readFile(installer)).digest('hex');
await writeFile(`${installer}.sha256`, `${hash}  ${installer.split(/[\\/]/).at(-1)}\n`);
console.log(JSON.stringify({ installer, sha256: hash, runtime: runtime.version, files: Object.keys(hashes).length }, null, 2));
