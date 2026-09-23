$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../scripts/windows-release/safety.ps1')
. (Join-Path $PSScriptRoot '../scripts/windows-release/live.ps1')
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
function Reject([scriptblock]$Action) { $rejected=$false; try { & $Action } catch { $rejected=$true }; Assert $rejected 'Foreign state was accepted.' }
$base=Join-Path $PSScriptRoot '../.cache'
New-Item -ItemType Directory -Force $base | Out-Null
$work=Join-Path $base ('wu-live-fixture-'+[guid]::NewGuid().ToString('N'))
$id=[guid]::NewGuid().ToString('N')
New-Item -ItemType Directory $work | Out-Null
[IO.File]::WriteAllText((Join-Path $work '.release-owner'),$id)
$c=@{ work=$work; runId=$id; install=(Join-Path $work 'client'); owned=$true; relogin=$false;
    shortcuts=(Join-Path $work 'shortcuts'); processes=[Collections.Generic.List[object]]::new(); uninstallPending=$false }
$script:clients=@(); $script:mutex=$false; $script:location=$null; $script:startup=$null; $script:registration=$false
function Get-Process { param($Name, $Id, $ErrorAction); if ($Id) { return @{ SessionId=2 } }; return $script:clients }
function Test-ReleaseMutex { return $script:mutex }
function Get-ReleaseLocation { return $script:location }
function Get-ReleaseStartup { return $script:startup }
# Registry provider is unavailable on non-Windows; only these reads are simulated.
function Test-Path { param($LiteralPath, $Path); $p=if ($LiteralPath) {$LiteralPath} else {$Path}; if ($p -eq $script:ReleaseProductKey) { return $script:registration }; return Microsoft.PowerShell.Management\Test-Path -LiteralPath $p }
try {
    Assert-ReleaseClients $c
    $script:clients=@(@{ Path='foreign/WindowsUse.exe'; SessionId=2 })
    Reject { Assert-ReleaseClients $c }
    $script:clients=@(@{ Path=(Join-Path $c.install 'WindowsUse.exe'); SessionId=3 })
    Reject { Assert-ReleaseClients $c }
    $script:clients=@(); $script:mutex=$true
    Reject { Assert-ReleaseClients $c }
    $script:mutex=$false; $script:location='foreign-installation'
    Reject { Assert-ReleaseClients $c }
    $script:location=$null; $script:startup='foreign-registration'
    Reject { Assert-ReleaseClients $c }
    $script:startup=$null; $script:registration=$true
    Reject { Assert-ReleaseClients $c }
    $script:registration=$false
    function Invoke-ReleaseUninstall { param($Context); $script:uninstalls++ }
    $script:uninstalls=0
    $c.uninstallPending=$true
    Reject { Invoke-ReleaseCleanup $c }
    Assert ($script:uninstalls -eq 0 -and (Test-Path $work)) 'Cleanup raced an uninstaller.'
    $c.uninstallPending=$false
    $c.nativePending=$true
    Reject { Invoke-ReleaseCleanup $c }
    Assert ($script:uninstalls -eq 0 -and (Test-Path $work)) 'Cleanup ignored unknown native completion.'
    $c.nativePending=$false
    $c.processes.Add(@{ HasExited=$false; Path='installer.exe' })
    Reject { Invoke-ReleaseCleanup $c }
    Assert ($script:uninstalls -eq 0 -and (Test-Path $work)) 'Cleanup raced a native process.'
    $c.processes.Clear()
    $script:clients=@(@{ Path='foreign/WindowsUse.exe'; SessionId=2 })
    Reject { Invoke-ReleaseCleanup $c }
    Assert ($script:uninstalls -eq 0 -and (Test-Path $work)) 'Cleanup stopped a foreign owner.'
    $script:clients=@()
    $result=Invoke-ReleaseCleanup $c
    Assert ($result.status -eq 'passed' -and !(Test-Path $work) -and $script:uninstalls -eq 1) 'Owned cleanup did not complete.'
    $result=Invoke-ReleaseCleanup $c
    Assert ($result.status -eq 'skipped' -and $script:uninstalls -eq 1) 'Repeated cleanup performed mutations.'
} finally { if (Microsoft.PowerShell.Management\Test-Path $work) { Remove-Item $work -Recurse -Force } }
'release live safety fixture assertions passed'
