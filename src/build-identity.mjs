import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
export const PROTOCOL_REVISION = 1;
export const CAPABILITIES = Object.freeze({ observationSafety: 1, query: 1, waitAccessEpoch: 1, directWindowWorkflow: 1 });
const roots = ['bin', 'src', 'dist', 'native', 'skills'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validPayloadName = name => /^(package\.json|(?:bin|src|dist|native|skills)\/[A-Za-z0-9_.\/-]+)$/.test(name) &&
  !name.split('/').some(part => part === '..' || part === '.' || !part);

async function payloadFiles(root) {
  const names = ['package.json'];
  async function walk(relative) {
    let entries;
    try { entries = await readdir(join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const name = `${relative}/${entry.name}`;
      // npm silently drops these entries. Reject them so npm and Windows copies
      // cannot acquire different inventories from the same source build.
      if (entry.name.startsWith('.') || /(?:\.orig|~)$/.test(entry.name) ||
          ['node_modules', 'CVS', 'npm-debug.log', 'package-lock.json', 'config.gypi'].includes(entry.name)) {
        throw new Error('npm-excluded entry in build payload; remove it before packaging');
      }
      if (!validPayloadName(name)) throw new Error('Unsupported build payload file name');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error('Unsupported build payload entry');
    }
  }
  for (const name of roots) await walk(name);
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, hash(await readFile(join(root, name)))])));
}

function manifestFor(version, files) {
  const content = { schemaVersion: 1, version, protocolRevision: PROTOCOL_REVISION, capabilityRevision: 1, capabilities: CAPABILITIES, files };
  return { ...content, buildId: hash(JSON.stringify(content)), skillSha256: files['skills/windows-use/SKILL.md'] ?? null };
}

export async function writeBuildManifest(root = rootDirectory) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = manifestFor(pkg.version, await payloadFiles(root));
  await writeFile(join(root, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Return only public, path-free identity fields. Never include broker data or file paths.
export async function readBuildIdentity(root = rootDirectory) {
  let manifest, current;
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    current = manifestFor(pkg.version, await payloadFiles(root));
    try { manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (manifest && (manifest.schemaVersion !== 1 || !validHash(manifest.buildId) || !manifest.files ||
        Object.entries(manifest.files).some(([name, digest]) => !validHash(digest) || !validPayloadName(name)))) throw new Error('Invalid manifest');
    const integrity = !manifest ? 'missing' : JSON.stringify(manifest) === JSON.stringify(current) ? 'verified' : 'mismatch';
    const { files, ...identity } = current;
    return { ...identity, integrity };
  } catch {
    return { schemaVersion: 1, version: null, buildId: null, protocolRevision: PROTOCOL_REVISION,
      capabilityRevision: 1, capabilities: { ...CAPABILITIES }, skillSha256: null, integrity: 'invalid' };
  }
}

export function sameBuild(a, b) {
  return a?.integrity === 'verified' && b?.integrity === 'verified' && validHash(a.buildId) && a.buildId === b.buildId;
}
