$ErrorActionPreference='Stop'
$library = Join-Path $PSScriptRoot '../scripts/windows-release/safety.ps1'
if (!(Test-Path $library)) { throw 'Release safety implementation is missing.' }
. $library
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
function Reject([scriptblock]$Action) {
    $rejected=$false
    try { & $Action } catch { $rejected=$true }
    Assert $rejected 'Unsafe operation accepted.'
}
$base=Join-Path $PSScriptRoot '../.cache'
New-Item -ItemType Directory -Force $base | Out-Null
$root=Join-Path $base ('wu-release-test-'+[guid]::NewGuid().ToString('N'))
$outside=Join-Path $base ('wu-release-foreign-'+[guid]::NewGuid().ToString('N'))
$id=[guid]::NewGuid().ToString('N')
try {
    New-Item -ItemType Directory $root,$outside | Out-Null
    Set-Content (Join-Path $outside 'keep.txt') 'foreign'
    Reject { Remove-ReleaseOwnedDirectory $root $id }
    Set-Content (Join-Path $root '.release-owner') 'another-owner' -NoNewline
    Reject { Remove-ReleaseOwnedDirectory $root $id }
    Set-Content (Join-Path $root '.release-owner') $id -NoNewline
    $linkType=if ([Environment]::OSVersion.Platform -eq 'Win32NT') { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkType -Path (Join-Path $root 'link') -Target ([IO.Path]::GetFullPath($outside)) | Out-Null
    Reject { Remove-ReleaseOwnedDirectory $root $id }
    Remove-Item (Join-Path $root 'link')
    Assert (Test-Path (Join-Path $outside 'keep.txt')) 'Foreign directory changed.'
    foreach ($path in @('../secret','/absolute','C:/private','a/../../x','a\\x','a//x','a/./x')) { Reject { Resolve-ReleasePayloadFile $root $path } }
    Set-Content (Join-Path $root 'file.txt') 'payload'
    $hash=Get-ReleaseHash (Join-Path $root 'file.txt')
    @{ version='0.2.0'; architecture='x64'; runtime=@{version='24.21.0'}; files=@{'file.txt'=$hash} } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $root 'package-manifest.json')
    $manifest=Test-ReleaseManifest $root
    Assert ($manifest.fileCount -eq 1 -and $manifest.sha256 -match '^[a-f0-9]{64}$') 'Manifest not verified.'
    Set-Content (Join-Path $root 'file.txt') 'tampered'
    Reject { Test-ReleaseManifest $root }
    Remove-ReleaseOwnedDirectory $root $id
    Assert (!(Test-Path $root)) 'Owned directory not cleaned.'
    $facts=@{ windows=$true; x64=$true; interactive=$true; net48=$true; supportedOs=$true; client=$false; owner=$false; registration=$false; startup=$false; shortcuts=$false; server=$false }
    Assert-ReleaseEnvironment $facts
    foreach ($key in @('windows','x64','interactive','net48','supportedOs','client','owner','registration','startup','shortcuts','server')) {
        $changed=$facts.Clone(); $changed[$key]=!$changed[$key]
        Reject { Assert-ReleaseEnvironment $changed }
    }
    $context=@{ work=(Join-Path $base 'release work'); install=(Join-Path $base 'release work/client') }
    $client=@{ Name='WindowsUse.exe'; ProcessId=7; ExecutablePath=(Join-Path $context.install 'WindowsUse.exe'); CommandLine=(Join-Path $context.install 'WindowsUse.exe') }
    $node=@{ Name='node.exe'; ProcessId=8; ParentProcessId=7; ExecutablePath=(Join-Path $context.install 'runtime/node.exe'); CommandLine=(Join-Path $context.install 'runtime/node.exe') }
    Assert-ReleaseRecoveryProcesses $context @($client,$node) 99
    Reject { Assert-ReleaseRecoveryProcesses $context @($node) 99 }
    $node.ExecutablePath='foreign-node.exe'
    Reject { Assert-ReleaseRecoveryProcesses $context @($client,$node) 99 }
    Reject { Assert-ReleaseRecoveryProcesses $context @(@{ Name='installer.exe'; ProcessId=5; CommandLine=('installer /D='+$context.install.ToUpperInvariant()) }) 99 }
} finally {
    if (Test-Path $root) { Remove-Item $root -Recurse -Force }
    Remove-Item $outside -Recurse -Force
}
'release safety fixture assertions passed'
