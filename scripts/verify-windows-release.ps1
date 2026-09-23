# Windows PowerShell 5.1 x64, in a dedicated logged-in desktop account.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RunDirectory,
    [string]$PreviousInstaller,
    [string]$CandidateInstaller,
    [switch]$ReloginCheckpoint,
    [switch]$Resume,
    [switch]$CleanupOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-release/plan.ps1')
. (Join-Path $PSScriptRoot 'windows-release/safety.ps1')
. (Join-Path $PSScriptRoot 'windows-release/native.ps1')
. (Join-Path $PSScriptRoot 'windows-release/live.ps1')
$oldHome=$env:WINDOWS_USE_HOME; $oldPath=$env:PATH
$c=$null; $created=$false
try {
    if (($Resume -and $CleanupOnly) -or (($Resume -or $CleanupOnly) -and $ReloginCheckpoint)) { throw 'incompatible_options' }
    $root=[IO.Path]::GetFullPath($RunDirectory)
    if ($Resume -or $CleanupOnly) {
        $state=Get-Content -LiteralPath (Join-Path $root 'run.json') -Raw | ConvertFrom-Json
        Assert-ReleaseOwnedDirectory $root $state.runId
        if ($state.schemaVersion -ne 1 -or $state.relogin -isnot [bool]) { throw 'invalid_recovery_state' }
        $id=$state.runId
        $relogin=$state.relogin
    } else {
        if (Test-Path -LiteralPath $root) { throw 'new_directory_required' }
        $id=[guid]::NewGuid().ToString('N'); $relogin=[bool]$ReloginCheckpoint
        New-Item -ItemType Directory -Path $root | Out-Null
        Assert-ReleaseNoLinks $root
        [IO.File]::WriteAllText((Join-Path $root '.release-owner'),$id)
        @{ schemaVersion=1; runId=$id; relogin=$relogin } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'run.json') -Encoding UTF8
        $created=$true
    }
    $work=Join-Path $root 'work'
    $defaultHome=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.windows-use'
    $c=@{ runId=$id; root=$root; work=$work; install=(Join-Path $work 'client'); defaultHome=$defaultHome;
        home=$(if ($relogin) { $defaultHome } else { Join-Path $work 'home' });
        shortcuts=([IO.Path]::Combine([Environment]::GetFolderPath('Programs'),'Windows Use'));
        source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));
        powerShell=$(if ($env:WINDIR) { Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe' } else { 'powershell.exe' });
        inputs=@{ previous=$PreviousInstaller; candidate=$CandidateInstaller }; packages=@{}; environment=@{ windows=$false };
        processes=[Collections.Generic.List[object]]::new(); relogin=$relogin; owned=$false; uninstallPending=$false }
    if ($Resume -or $CleanupOnly) {
        if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or !(Test-Path $work)) { throw 'recovery_environment_missing' }
        $c.environment=@{ windows=$true; build=[Environment]::OSVersion.Version.Build; x64=[Environment]::Is64BitProcess;
            interactive=([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0); pathNodeExcluded=$true }
        if (!$c.environment.x64 -or !$c.environment.interactive) { throw 'recovery_desktop_required' }
        Assert-ReleaseOwnedDirectory $work $id
        Assert-ReleaseOwnedDirectory $c.home $id
        $env:WINDOWS_USE_HOME=$c.home
        $env:PATH="$env:WINDIR\System32;$env:WINDIR;$env:WINDIR\System32\WindowsPowerShell\v1.0"
        # Refuse cleanup while an installer/smoke/fixture process may still own files.
        Assert-ReleaseRecoveryProcesses $c @(Get-CimInstance Win32_Process) $PID
        if ($Resume) {
            $checkpoint=Get-Content -LiteralPath (Join-Path $root 'checkpoint.json') -Raw | ConvertFrom-Json
            Assert-ReleaseCheckpoint $checkpoint.result 'windows'
            if (!$relogin -or $checkpoint.runId -ne $id -or $checkpoint.loginHash -eq (Get-ReleaseLogonHash)) {
                $c.owned=$false; throw 'new_logon_required'
            }
            $c.loginHash=$checkpoint.loginHash; $c.settingsHash=$checkpoint.settingsHash
            Assert-ReleasePayloadPaths $checkpoint.previousPayloadFiles $checkpoint.packages.previous.manifest.fileCount
            $c.previousPayloadFiles=@($checkpoint.previousPayloadFiles)
            $c.packages=@{ previous=@{ installerSha256=$checkpoint.packages.previous.installerSha256; manifest=$checkpoint.packages.previous.manifest; smokeChecks=$checkpoint.packages.previous.smokeChecks };
                candidate=@{ installerSha256=$checkpoint.packages.candidate.installerSha256; manifest=$checkpoint.packages.candidate.manifest; smokeChecks=$checkpoint.packages.candidate.smokeChecks } }
            $manifest=Test-ReleaseManifest $c.install
            if ($manifest.sha256 -ne $c.packages.candidate.manifest.sha256) { $c.owned=$false; throw 'checkpoint_package_changed' }
            $c.payloadFiles=@((Get-Content (Join-Path $c.install 'package-manifest.json') -Raw | ConvertFrom-Json).files.PSObject.Properties.Name)
        }
        Assert-ReleaseClients $c
        $c.owned=$true
    }
    $actions=@{}
    foreach ($phase in @('preflight','install-previous','verify-previous','smoke-previous','fixture-previous','prepare-update','update',
        'verify-candidate','smoke-candidate','fixture-candidate','checkpoint','relogin','uninstall','verify-uninstall','cleanup')) {
        $actions[$phase]={ param($context,$name) Invoke-ReleaseStage $context $name }
    }
    if ($CleanupOnly) {
        $detail=Invoke-ReleaseCleanup $c
        $report=[ordered]@{ schemaVersion=1; evidence='windows'; status='incomplete'; requiredPassed=$false; exitCode=2;
            steps=@(@{ id='cleanup'; status=$detail.status; code=$detail.code }); coverage=@(@{ id='release-lifecycle'; status='unverified'; code='cleanup_only' }) }
    } else {
        $report=Invoke-ReleasePlan -Context $c -Actions $actions -PauseForRelogin:$ReloginCheckpoint -Resume $(if ($Resume) { $checkpoint.result } else { $null })
    }
    $report.environment=$c.environment; $report.packages=$c.packages
    $report.completedAtUtc=[DateTime]::UtcNow.ToString('o')
    if ($report.status -eq 'checkpoint') {
        @{ runId=$id; loginHash=$c.loginHash; settingsHash=$c.settingsHash; previousPayloadFiles=$c.previousPayloadFiles; packages=$c.packages; result=$report } |
            ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $root 'checkpoint.json') -Encoding UTF8
    }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding UTF8
    if ($report.status -ne 'checkpoint' -and !$c.owned) { Remove-Item -LiteralPath (Join-Path $root 'checkpoint.json') -ErrorAction SilentlyContinue }
    Write-Output ($report | ConvertTo-Json -Depth 12 -Compress)
    exit $report.exitCode
} catch {
    # No raw exceptions, paths, command lines, machine/account names or credentials.
    $cleanup='skipped'
    if ($c -and $c.owned) {
        try { $null=Invoke-ReleaseCleanup $c; $cleanup='passed' } catch { $cleanup='failed' }
    }
    $failure=@{ schemaVersion=1; evidence='windows'; status='failed'; requiredPassed=$false; exitCode=1;
        environment=@{ windows=([Environment]::OSVersion.Platform -eq 'Win32NT') }; packages=@{};
        completedAtUtc=[DateTime]::UtcNow.ToString('o'); coverage=@();
        steps=@(@{ id='entry'; status='failed'; code='invalid_input_or_recovery_state' },@{ id='cleanup'; status=$cleanup; code='recovery_required_if_retained' }) }
    if ($created) { $failure | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding UTF8 }
    Write-Output ($failure | ConvertTo-Json -Depth 8 -Compress)
    exit 1
} finally {
    $env:WINDOWS_USE_HOME=$oldHome; $env:PATH=$oldPath
}
