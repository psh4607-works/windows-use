$ErrorActionPreference = 'Stop'
$library = Join-Path $PSScriptRoot '../scripts/windows-release/plan.ps1'
if (!(Test-Path $library)) { throw 'Release plan implementation is missing.' }
. $library
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
$phases = @('preflight','install-previous','verify-previous','smoke-previous','fixture-previous','prepare-update','update','verify-candidate','smoke-candidate','fixture-candidate','uninstall','verify-uninstall')
function New-Actions($Context) {
    $actions = @{}
    foreach ($name in ($phases + @('checkpoint','relogin','cleanup'))) {
        $actions[$name] = { param($c, $phase)
            $c.calls.Add($phase)
            if ($phase -in $c.fail) { throw 'private account/path/host must not escape' }
            if ($phase -eq 'checkpoint') { return @{ status='unverified'; code='manual_login_required' } }
            return @{ status='passed'; code='verified' }
        }
    }
    return $actions
}
function New-Context { return @{ calls=[Collections.Generic.List[string]]::new(); fail=@() } }
$c = New-Context
$r = Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture
Assert (($c.calls -join ',') -eq (($phases + 'cleanup') -join ',')) 'Phase order differs.'
Assert ($r.requiredPassed -and $r.exitCode -eq 2 -and $r.status -eq 'incomplete') 'Unverified coverage must not be pass.'
Assert ($r.evidence -eq 'fixture') 'Fixture evidence must stay distinguishable.'
foreach ($phase in $phases) {
    $c = New-Context; $c.fail = @($phase)
    $r = Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture
    Assert ($r.exitCode -ne 0 -and !$r.requiredPassed) "Failure not propagated: $phase"
    Assert ($c.calls[-1] -eq 'cleanup') "Finally cleanup absent: $phase"
    Assert ($c.calls.Count -eq ([array]::IndexOf($phases, $phase) + 2)) "Later phases ran after $phase"
    Assert (@($r.steps | Where-Object status -eq skipped).Count -eq ($phases.Count - [array]::IndexOf($phases, $phase) - 1)) 'Unexecuted phases were not recorded as skipped.'
    Assert (($r | ConvertTo-Json -Depth 10) -notmatch 'private account') 'Private exception leaked.'
}
$c = New-Context; $c.fail=@('update','cleanup')
$r = Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture
Assert (@($r.steps | Where-Object status -eq failed).Count -eq 2) 'Cleanup failure masked primary failure.'
$c = New-Context
$paused = Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture -PauseForRelogin
Assert ($paused.status -eq 'checkpoint' -and $paused.exitCode -eq 2) 'Missing checkpoint.'
Assert ('cleanup' -notin $c.calls -and 'uninstall' -notin $c.calls) 'Checkpoint must retain only owned installation.'
$tampered=$paused | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$tampered.steps[0].status='skipped'
$c.calls.Clear()
$rejected=$false
try { $null=Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture -Resume $tampered } catch { $rejected=$true }
Assert ($rejected -and $c.calls.Count -eq 0) 'Incomplete checkpoint was resumed.'
$c.calls.Clear()
$resumed = Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture -Resume $paused
Assert (($c.calls -join ',') -eq 'relogin,uninstall,verify-uninstall,cleanup') 'Resume replays completed mutations.'
Assert (@($resumed.steps | Where-Object id -eq update).Count -eq 1) 'Resume duplicates results.'
$c.calls.Clear()
try { Invoke-ReleasePlan -Context $c -Actions (New-Actions $c) -Evidence fixture -Resume $resumed; throw 'accepted invalid resume' }
catch { Assert ($_.Exception.Message -ne 'accepted invalid resume') 'Invalid resume accepted.' }
Assert ($c.calls.Count -eq 0) 'Invalid checkpoint triggered an action.'
'release plan fixture assertions passed'
