export function sshInvocation(host, remoteDir, remoteHome, guarded = false) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(host)) throw new Error('Invalid SSH host alias');
  if (remoteDir && /[\r\n\0]/.test(remoteDir)) throw new Error('Invalid remote directory');
  if (remoteHome && /[\r\n\0]/.test(remoteHome)) throw new Error('Invalid remote home');
  const home = remoteHome ? `$env:WINDOWS_USE_HOME='${remoteHome.replaceAll("'", "''")}';` : '';
  const root = remoteDir
    ? `$root='${remoteDir.replaceAll("'", "''")}';`
    : "$root=Join-Path $env:LOCALAPPDATA 'Programs/WindowsUse'; if (!(Test-Path (Join-Path $root 'bin/windows-use.mjs'))) { $root=Join-Path $env:USERPROFILE '.windows-use/app' };";
  const script = `$ErrorActionPreference='Stop'; ${home} ${root} $entry=Join-Path $root 'bin/windows-use.mjs'; $node=Join-Path $root 'runtime/node.exe'; if (!(Test-Path $node)) { $node=(Get-Command node.exe -ErrorAction Stop).Source }; & $node $entry ${guarded ? 'identity-rpc' : 'rpc'}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { program: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`] };
}
