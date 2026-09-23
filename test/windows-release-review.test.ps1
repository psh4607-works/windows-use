$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../scripts/windows-release/safety.ps1')
. (Join-Path $PSScriptRoot '../scripts/windows-release/plan.ps1')
. (Join-Path $PSScriptRoot '../scripts/windows-release/live.ps1')
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
function Expect-Code([scriptblock]$Action, [string]$Code) {
    $caught=$false
    try { & $Action | Out-Null } catch {
        $caught=$true
        Assert ($_.Exception.Message -ceq $Code) ('Expected '+$Code+', got a different failure')
    }
    Assert $caught ('Expected failure: '+$Code)
}
$base=Join-Path $PSScriptRoot '../.cache'
New-Item -ItemType Directory -Force $base | Out-Null
$work=Join-Path $base ('wu-review-'+[guid]::NewGuid().ToString('N'))
$c=@{ install=(Join-Path $work 'client'); home=(Join-Path $work 'home'); shortcuts=(Join-Path $work 'shortcuts');
    payloadFiles=@(); previousPayloadFiles=@(); runId='fixture'; settingsHash='unused' }
function Get-ReleaseLocation { return $null }
function Get-ReleaseStartup { return $null }
function Test-ReleaseMutex { return $false }
try {
    New-Item -ItemType Directory $c.install,$c.home | Out-Null
    Expect-Code { Test-ReleaseUninstalled $c } 'uninstall_removed_user_data'
    Expect-Code { Assert-ReleaseUserData $c 'user_data_not_preserved' } 'user_data_not_preserved'
    [IO.File]::WriteAllText((Join-Path $c.install 'release-user-file.txt'),$c.runId)
    Expect-Code { Test-ReleaseUninstalled $c } 'uninstall_removed_user_data'
    [IO.File]::WriteAllText((Join-Path $c.home 'settings.json'),'fixture')
    $c.settingsHash=Get-ReleaseHash (Join-Path $c.home 'settings.json')
    Test-ReleaseUninstalled $c
    Expect-Code { Test-ReleaseInstalled $c previous } 'package_owner_missing'
} finally { Remove-Item $work -Recurse -Force }
foreach ($code in @('package_owner_missing','user_data_not_preserved','uninstall_removed_user_data','private path must be omitted')) {
    $actions=@{ preflight={param($context,$phase) throw $context.failure}; cleanup={ @{status='passed';code='verified'} } }
    $report=Invoke-ReleasePlan -Context @{ failure=$code } -Actions $actions -Evidence fixture
    $expected=if ($code -like 'private*') {'step_failed'} else {$code}
    Assert ($report.steps[0].code -ceq $expected) 'Known failure lost or raw exception leaked into report.'
}
foreach ($paths in @(@(),@($null),@(''),@('../escape'),@('valid','valid'))) {
    Expect-Code { Assert-ReleasePayloadPaths $paths 1 } 'invalid_checkpoint_paths'
}
Assert-ReleasePayloadPaths @('runtime/node.exe','.windows-use-client') 2
Expect-Code { Assert-ReleasePayloadPaths @('runtime/node.exe') 2 } 'invalid_checkpoint_paths'
$fixture=[pscustomobject]@{ HasExited=$false; refreshed=$false; closeCalls=0 }
$fixture | Add-Member ScriptMethod Refresh { $this.refreshed=$true }
$fixture | Add-Member ScriptMethod CloseMainWindow {
    if (!$this.refreshed) { throw 'read_stale_process_state' }
    $this.closeCalls++; return $false
}
$fixture | Add-Member ScriptMethod WaitForExit { param($timeout); return $false }
$c=@{ stops=0; failStop=$false }
function Stop-ReleaseClient($context) { $context.stops++; if ($context.failStop) { throw 'private shutdown failure' } }
$primary=$null
try { throw 'fixture_input_not_verified' } catch { $primary=$_ }
$failure=$null
try { Complete-ReleaseFixture $c $fixture $primary } catch { $failure=$_ }
Assert ($c.stops -eq 1 -and $fixture.refreshed -and $fixture.closeCalls -eq 1) 'Fixture close prevented owner shutdown.'
Assert ($failure.Exception.Message -eq 'fixture_input_not_verified') 'Primary fixture failure was masked.'
Assert (($failure.Exception.Data['releaseSecondaryCodes'] -join ',') -eq 'fixture_close_failed') 'Close failure was lost.'
$fixture.HasExited=$true; $c.failStop=$true
Expect-Code { Complete-ReleaseFixture $c $fixture $null } 'fixture_shutdown_failed'
$actions=@{ preflight={param($context,$phase) throw $context.failure}; cleanup={ @{status='passed';code='verified'} } }
$failure.Exception.Data['releaseSecondaryCodes']=@('fixture_close_failed','private details')
$report=Invoke-ReleasePlan -Context @{failure=$failure} -Actions $actions -Evidence fixture
Assert ($report.steps[0].code -eq 'fixture_input_not_verified') 'Primary report code changed.'
Assert (($report.steps[0].secondaryCodes -join ',') -eq 'fixture_close_failed') 'Secondary codes leaked or were not reported.'
'release review fixture assertions passed'
