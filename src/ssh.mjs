export function sshInvocation(host, remoteDir) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(host)) throw new Error('Invalid SSH host alias');
  if (remoteDir && /[\r\n\0]/.test(remoteDir)) throw new Error('Invalid remote directory');
  const root = remoteDir ? `'${remoteDir.replaceAll("'", "''")}'` : "(Join-Path $env:USERPROFILE '.windows-use/app')";
  const script = `$ErrorActionPreference='Stop'; $entry=Join-Path ${root} 'bin/windows-use.mjs'; & node.exe $entry rpc; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { program: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`] };
}
