import { createHash } from 'node:crypto';

export function verifySha256(bytes, expected) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Runtime checksum mismatch; refusing to package unverified bytes');
}

export function uninstallScript(files) {
  const directories = new Set();
  const lines = files.map(file => {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(file) || file.startsWith('/') || file.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('Unsafe package path');
    const parts = file.split('/');
    for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join('\\'));
    return `Delete "$INSTDIR\\${parts.join('\\')}"`;
  });
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) lines.push(`RMDir "$INSTDIR\\${directory}"`);
  return `${lines.join('\n')}\n`;
}
