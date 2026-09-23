$ErrorActionPreference='Stop'
$library=Join-Path $PSScriptRoot '../scripts/windows-release/native.ps1'
if (!(Test-Path $library)) { throw 'Native release adapter is missing.' }
. $library
function Assert($Value, $Message) { if (!$Value) { throw $Message } }
Assert ((Get-ReleaseNativeArguments -InstallerDirectory 'C:\Release tests\client') -ceq '/S /D=C:\Release tests\client') 'NSIS /D must be last and unquoted.'
Assert ((Get-ReleaseNativeArguments -Arguments @('/S')) -ceq '/S') 'NSIS silent uninstall switch was quoted.'
foreach ($invalid in @('C:\bad"path', "C:\bad`npath")) {
    $rejected=$false
    try { $null=Get-ReleaseNativeArguments -InstallerDirectory $invalid } catch { $rejected=$true }
    Assert $rejected 'Unsafe installer tail accepted.'
}
$c=@{ processes=[Collections.Generic.List[object]]::new() }
$shell=(Get-Process -Id $PID).Path
$value=Invoke-ReleaseProcess $c $shell @('-NoProfile','-Command', 'Write-Output ''한글 value with spaces''')
Assert ($value -eq '한글 value with spaces') 'Argument or output encoding changed.'
$rejected=$false
try { Invoke-ReleaseProcess $c $shell @('-NoProfile','-Command', 'Write-Output ''private-host/account''; exit 7') }
catch { $rejected=$true; Assert ($_.Exception.Message -eq 'native_exit_nonzero') 'Raw native failure leaked.' }
Assert $rejected 'Nonzero exit was accepted.'
try { Invoke-ReleaseProcess $c $shell @('-NoProfile','-Command','Start-Sleep -Milliseconds 500') -TimeoutMs 10; throw 'timeout accepted' }
catch { Assert ($_.Exception.Message -eq 'native_timeout') 'Timeout did not propagate.' }
Assert (!$c.processes[-1].HasExited) 'Timeout killed a process rather than retaining ownership.'
$c.processes[-1].WaitForExit()
Assert ($c.processes.Count -eq 3) 'Native ownership tracking missing.'
$c.nativePending=$false
$launchDescendant='$start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=(Get-Process -Id $PID).Path; $start.Arguments="-NoProfile -Command Start-Sleep -Seconds 3"; $start.UseShellExecute=$false; [Diagnostics.Process]::Start($start) | Out-Null'
try { $null=Invoke-ReleaseProcess $c $shell @('-NoProfile','-Command',$launchDescendant) -TimeoutMs 1800; throw 'descendant pipe timeout accepted' }
catch { Assert ($_.Exception.Message -eq 'native_output_timeout') 'Descendant holding stdout bypassed timeout.' }
Assert $c.nativePending 'Unknown native completion must inhibit cleanup.'
foreach ($p in $c.processes) { $p.Dispose() }
'release native fixture assertions passed'
