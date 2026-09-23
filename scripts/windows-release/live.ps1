$script:ReleaseProductKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WindowsUse'
$script:ReleaseRunKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Get-ReleaseStartup { return (Get-ItemProperty $script:ReleaseRunKey -Name WindowsUse -ErrorAction SilentlyContinue).WindowsUse }
function Get-ReleaseLocation { return (Get-ItemProperty $script:ReleaseProductKey -ErrorAction SilentlyContinue).InstallLocation }
function Get-ReleaseStartupCommand($c) { return '"' + (Join-Path $c.install 'WindowsUse.exe') + '" --background' }
function Test-ReleaseMutex {
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try { $mutex=[Threading.Mutex]::OpenExisting("Global\WindowsUse.$sid.Owner"); $mutex.Dispose(); return $true }
    catch [Threading.WaitHandleCannotBeOpenedException] { return $false }
}
function Get-ReleaseLogonHash {
    $logon=@([Security.Principal.WindowsIdentity]::GetCurrent().Groups | Where-Object { $_.Value -like 'S-1-5-5-*' })
    if ($logon.Count -ne 1) { throw 'logon_identity_unavailable' }
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($logon[0].Value)))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Assert-ReleaseClients($c) {
    Assert-ReleaseOwnedDirectory $c.work $c.runId
    $clients=@(Get-Process WindowsUse -ErrorAction SilentlyContinue)
    foreach ($client in $clients) {
        if ($client.Path -ne (Join-Path $c.install 'WindowsUse.exe') -or $client.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'foreign_client' }
    }
    if (!$clients.Count -and (Test-ReleaseMutex)) { throw 'unattributed_owner' }
    $location=Get-ReleaseLocation
    if ((Test-Path $script:ReleaseProductKey) -and $location -ne $c.install) { throw 'foreign_installation' }
    if ($location -and $location -ne $c.install) { throw 'foreign_installation' }
    $startup=Get-ReleaseStartup
    if ($startup -and $startup -ne (Get-ReleaseStartupCommand $c)) { throw 'foreign_startup' }
}
function Invoke-ReleaseCli($c, [string[]]$Arguments) {
    $raw=Invoke-ReleaseProcess $c (Join-Path $c.install 'runtime/node.exe') (@((Join-Path $c.install 'bin/windows-use.mjs')) + $Arguments)
    $response=$raw | ConvertFrom-Json
    if (!$response.ok) { throw 'cli_failed' }
    return $response.result
}
function Start-ReleaseClient($c) {
    Assert-ReleaseClients $c
    if (@(Get-Process WindowsUse -ErrorAction SilentlyContinue).Count) { throw 'client_already_running' }
    $p=Start-Process (Join-Path $c.install 'WindowsUse.exe') -ArgumentList '--background' -PassThru
    $c.processes.Add($p)
    Wait-ReleaseCondition { Test-Path (Join-Path $c.home 'server.json') }
    Wait-ReleaseCondition { (Invoke-ReleaseCli $c @('status')).state -eq 'running' }
    if (!(Invoke-ReleaseCli $c @('doctor')).desktop.ok) { throw 'doctor_failed' }
}
function Stop-ReleaseClient($c) {
    Assert-ReleaseClients $c
    if (@(Get-Process WindowsUse -ErrorAction SilentlyContinue).Count) {
        $null=Invoke-ReleaseProcess $c (Join-Path $c.install 'WindowsUse.exe') @('--shutdown') -TimeoutMs 90000
    }
    Wait-ReleaseCondition { !(Test-Path (Join-Path $c.home 'server.json')) -and !(Test-ReleaseMutex) } -Seconds 90
}
function Invoke-ReleaseInstaller($c, [string]$Slot) {
    Assert-ReleaseClients $c
    $file=Join-Path $c.work "$Slot.exe"
    if ((Get-ReleaseHash $file) -ne $c.packages[$Slot].installerSha256) { throw 'installer_changed' }
    $null=Invoke-ReleaseProcess $c $file -InstallerDirectory $c.install
}
function Test-ReleaseInstalled($c, [string]$Slot) {
    if (!(Test-Path -LiteralPath (Join-Path $c.install '.windows-use-client') -PathType Leaf)) { throw 'package_owner_missing' }
    if ([IO.File]::ReadAllText((Join-Path $c.install '.windows-use-client')) -ne 'WindowsUse.Client') { throw 'package_owner_missing' }
    $manifest=Test-ReleaseManifest $c.install
    # A stripped PATH is independent from a genuinely Node-free VM.
    $version=Invoke-ReleaseProcess $c (Join-Path $c.install 'runtime/node.exe') @('--version')
    if ($version -ne ('v'+$manifest.runtime)) { throw 'bundled_node_mismatch' }
    if ((Get-ReleaseLocation) -ne $c.install) { throw 'install_registration_missing' }
    $shell=New-Object -ComObject WScript.Shell
    foreach ($name in @('Windows Use','Uninstall')) {
        $shortcut=$shell.CreateShortcut((Join-Path $c.shortcuts "$name.lnk"))
        $target=if ($name -eq 'Windows Use') { 'WindowsUse.exe' } else { 'Uninstall.exe' }
        if ($shortcut.TargetPath -ne (Join-Path $c.install $target)) { throw 'shortcut_mismatch' }
    }
    $c.packages[$Slot].manifest=$manifest
    if ($Slot -eq 'previous') {
        $c.previousPayloadFiles=@((Get-Content (Join-Path $c.install 'package-manifest.json') -Raw | ConvertFrom-Json).files.PSObject.Properties.Name)
        if ((Get-ReleaseStartup) -ne (Get-ReleaseStartupCommand $c)) { throw 'startup_missing' }
    } else {
        if (Get-ReleaseStartup) { throw 'disabled_startup_not_preserved' }
        Assert-ReleaseUserData $c 'user_data_not_preserved'
        if ((Test-Path (Join-Path $c.home 'server.json')) -or (Test-ReleaseMutex) -or
            @(Get-Process WindowsUse -ErrorAction SilentlyContinue).Count) { throw 'update_owner_not_stopped' }
        if ($c.packages.previous.manifest.sha256 -eq $manifest.sha256) { throw 'same_payload_not_upgrade' }
    }
}
function Invoke-ReleaseSmoke($c, [string]$Slot) {
    Assert-ReleaseClients $c
    $report=Join-Path $c.work "$Slot-smoke.json"
    $null=Invoke-ReleaseProcess $c $c.powerShell @('-NoProfile','-File', (Join-Path $c.source 'test/windows-client-smoke.ps1'),
        '-ClientDirectory',$c.install,'-ReportPath',$report,'-StateDirectory',(Join-Path $c.work "$Slot-smoke-home"),'-AllowUnavailableSsh','-SanitizeReport') -TimeoutMs 300000
    $r=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if (!$r.ok -or $r.run.packageManifestSha256 -ne $c.packages[$Slot].manifest.sha256) { throw 'smoke_failed' }
    # Whitelist only counts and hashes; even the original smoke's connection text stays private.
    $c.packages[$Slot].smokeChecks=@($r.checked).Count
    Remove-Item -LiteralPath $report
}
function Complete-ReleaseFixture($c, $Fixture, $PrimaryFailure) {
    $failures=[Collections.Generic.List[string]]::new()
    try {
        $Fixture.Refresh()
        if (!$Fixture.HasExited -and (!$Fixture.CloseMainWindow() -or !$Fixture.WaitForExit(10000))) { $failures.Add('fixture_close_failed') }
    } catch { $failures.Add('fixture_close_failed') }
    try { Stop-ReleaseClient $c } catch { $failures.Add('fixture_shutdown_failed') }
    if (!$PrimaryFailure -and $failures.Count) {
        try { throw $failures[0] } catch { $PrimaryFailure=$_ }
        $failures.RemoveAt(0)
    }
    if ($PrimaryFailure) {
        $PrimaryFailure.Exception.Data['releaseSecondaryCodes']=$failures.ToArray()
        throw $PrimaryFailure
    }
}
function Invoke-ReleaseFixture($c) {
    Start-ReleaseClient $c
    $fixtureDirectory=Join-Path $c.work ('fixture-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $fixtureDirectory | Out-Null
    $title='windows-use Release '+$c.runId
    $fixtureArguments=@('-NoProfile','-STA','-File',(Join-Path $c.source 'test/windows-ui-fixture.ps1'),'-StateDirectory',$fixtureDirectory,'-WindowTitle',$title)
    $fixture=Start-Process $c.powerShell -ArgumentList (($fixtureArguments | ForEach-Object { ConvertTo-ReleaseArgument $_ }) -join ' ') -PassThru
    $c.processes.Add($fixture)
    $primaryFailure=$null
    try {
        Wait-ReleaseCondition { Test-Path (Join-Path $fixtureDirectory 'ui-state.json') }
        $target=@('--app',[string]$fixture.Id,'--session','release-fixture')
        $snapshot=Invoke-ReleaseCli $c (@('snapshot')+$target)
        if ($snapshot.snapshot.window.title -ne $title) { throw 'fixture_identity_mismatch' }
        $elements=[regex]::Matches($snapshot.snapshot.treeText, '(?m)^\s*(\d+)\b[^\r\n]*Smoke input')
        if ($elements.Count -ne 1) { throw 'fixture_element_missing' }
        $null=Invoke-ReleaseCli $c (@('set-value')+$target+@('--observation',$snapshot.session.observation,'--element',$elements[0].Groups[1].Value,'--value','release fixture 한글🙂'))
        $state=Get-Content (Join-Path $fixtureDirectory 'ui-state.json') -Raw | ConvertFrom-Json
        if ($state.text -ne 'release fixture 한글🙂') { throw 'fixture_input_not_verified' }
    } catch { $primaryFailure=$_ }
    finally { Complete-ReleaseFixture $c $fixture $primaryFailure }
}
function Invoke-ReleaseUninstall($c) {
    Assert-ReleaseClients $c
    if (Test-Path (Join-Path $c.install 'Uninstall.exe')) {
        $c.uninstallPending=$true
        $null=Invoke-ReleaseProcess $c (Join-Path $c.install 'Uninstall.exe') @('/S')
        # NSIS may clone itself; parent exit alone does not prove uninstallation.
        Wait-ReleaseCondition { !(Test-Path (Join-Path $c.install 'Uninstall.exe')) -and !(Get-ReleaseLocation) } -Seconds 90
        $c.uninstallPending=$false
    }
}
function Assert-ReleaseUserData($c, [ValidateSet('user_data_not_preserved','uninstall_removed_user_data')][string]$Code) {
    if (!(Test-Path -LiteralPath (Join-Path $c.install 'release-user-file.txt') -PathType Leaf) -or
        !(Test-Path -LiteralPath (Join-Path $c.home 'settings.json') -PathType Leaf) -or
        [IO.File]::ReadAllText((Join-Path $c.install 'release-user-file.txt')) -ne $c.runId -or
        (Get-ReleaseHash (Join-Path $c.home 'settings.json')) -ne $c.settingsHash) { throw $Code }
}
function Test-ReleaseUninstalled($c) {
    if ((Get-ReleaseLocation) -or (Get-ReleaseStartup) -or (Test-Path $c.shortcuts) -or
        (Test-Path (Join-Path $c.home 'server.json')) -or (Test-ReleaseMutex)) { throw 'uninstall_incomplete' }
    foreach ($file in @($c.previousPayloadFiles + $c.payloadFiles + @('package-manifest.json','Uninstall.exe'))) {
        if (Test-Path (Join-Path $c.install $file)) { throw 'payload_survived_uninstall' }
    }
    Assert-ReleaseUserData $c 'uninstall_removed_user_data'
}
function Invoke-ReleaseCleanup($c) {
    if (!$c.owned) { return @{ status='skipped'; code='no_owned_windows_resources' } }
    Assert-ReleaseClients $c
    # Do not race a timed-out installer or smoke subprocess. Retain for explicit recovery.
    if ($c.nativePending) { throw 'native_completion_unverified' }
    foreach ($p in $c.processes) {
        if (!$p.HasExited -and $p.Path -ne (Join-Path $c.install 'WindowsUse.exe')) { throw 'owned_process_still_running' }
    }
    if ($c.uninstallPending) { throw 'uninstall_still_pending' }
    if (Test-Path (Join-Path $c.install 'WindowsUse.exe')) { Stop-ReleaseClient $c }
    Invoke-ReleaseUninstall $c
    if ((Get-ReleaseLocation) -or (Get-ReleaseStartup) -or (Test-Path $c.shortcuts)) { throw 'registration_retained_manual_recovery' }
    if ($c.relogin) { Remove-ReleaseOwnedDirectory $c.home $c.runId }
    Remove-ReleaseOwnedDirectory $c.work $c.runId
    $c.owned=$false
    return @{ status='passed'; code='owned_resources_removed' }
}
function Invoke-ReleasePreflight($c) {
    $c.environment.windows=([Environment]::OSVersion.Platform -eq 'Win32NT')
    if (!$c.environment.windows) { throw 'windows_required' }
    $facts=@{ windows=$true; x64=([Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem);
        interactive=([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0);
        net48=((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release -ge 528040);
        supportedOs=([Environment]::OSVersion.Version.Build -ge 10240);
        client=(@(Get-Process WindowsUse -ErrorAction SilentlyContinue).Count -gt 0);
        owner=(Test-ReleaseMutex); registration=(Test-Path $script:ReleaseProductKey);
        startup=($null -ne (Get-ReleaseStartup)); shortcuts=(Test-Path $c.shortcuts);
        server=(Test-Path (Join-Path $c.defaultHome 'server.json')) }
    $c.environment += @{ build=[Environment]::OSVersion.Version.Build; x64=$facts.x64; interactive=$facts.interactive;
        nodeOnPath=($null -ne (Get-Command node -ErrorAction SilentlyContinue)); pathNodeExcluded=$true }
    Assert-ReleaseEnvironment $facts
    if ($c.relogin -and ((Test-Path $c.defaultHome) -or $env:WINDOWS_USE_HOME)) { throw 'relogin_requires_unused_default_home' }
    if ($env:WINDOWS_USE_HOME -and (Test-Path (Join-Path $env:WINDOWS_USE_HOME 'server.json'))) { throw 'protected_environment_server' }
    foreach ($slot in @('previous','candidate')) {
        $file=$c.inputs[$slot]
        if (!$file -or [IO.Path]::GetExtension($file) -ne '.exe') { throw 'installer_exe_required' }
        Assert-ReleaseNoLinks $file
        $c.packages[$slot]=@{ installerSha256=Get-ReleaseHash $file }
    }
    if ($c.packages.previous.installerSha256 -eq $c.packages.candidate.installerSha256) { throw 'distinct_installers_required' }
    New-Item -ItemType Directory $c.work | Out-Null
    [IO.File]::WriteAllText((Join-Path $c.work '.release-owner'),$c.runId)
    $c.owned=$true
    New-Item -ItemType Directory $c.home | Out-Null
    [IO.File]::WriteAllText((Join-Path $c.home '.release-owner'),$c.runId)
    foreach ($slot in @('previous','candidate')) { Copy-Item -LiteralPath $c.inputs[$slot] -Destination (Join-Path $c.work "$slot.exe") }
    # No machine/user environment, service, scheduled task or execution-policy changes.
    $env:WINDOWS_USE_HOME=$c.home
    $env:PATH="$env:WINDIR\System32;$env:WINDIR;$env:WINDIR\System32\WindowsPowerShell\v1.0"
    $c.loginHash=if ($c.relogin) { Get-ReleaseLogonHash } else { $null }
}
function Invoke-ReleaseStage($c, [string]$Phase) {
    switch ($Phase) {
        'preflight' { Invoke-ReleasePreflight $c }
        'install-previous' { Invoke-ReleaseInstaller $c previous }
        'verify-previous' { Test-ReleaseInstalled $c previous }
        'smoke-previous' { Invoke-ReleaseSmoke $c previous }
        'fixture-previous' { Invoke-ReleaseFixture $c }
        'prepare-update' {
            [IO.File]::WriteAllText((Join-Path $c.install 'release-user-file.txt'),$c.runId)
            [IO.File]::WriteAllText((Join-Path $c.home 'settings.json'),'{"paused":false,"connection":{"alias":"release-fixture","hostname":"localhost","port":22,"username":"fixture"}}')
            $c.settingsHash=Get-ReleaseHash (Join-Path $c.home 'settings.json')
            Assert-ReleaseClients $c
            if ((Get-ReleaseStartup) -ne (Get-ReleaseStartupCommand $c)) { throw 'startup_ownership_lost' }
            Remove-ItemProperty $script:ReleaseRunKey -Name WindowsUse
            Start-ReleaseClient $c
        }
        'update' { Invoke-ReleaseInstaller $c candidate }
        'verify-candidate' {
            Test-ReleaseInstalled $c candidate
            $c.payloadFiles=@((Get-Content (Join-Path $c.install 'package-manifest.json') -Raw | ConvertFrom-Json).files.PSObject.Properties.Name)
        }
        'smoke-candidate' { Invoke-ReleaseSmoke $c candidate }
        'fixture-candidate' { Invoke-ReleaseFixture $c }
        'checkpoint' {
            Assert-ReleaseClients $c
            Set-ItemProperty $script:ReleaseRunKey -Name WindowsUse -Value (Get-ReleaseStartupCommand $c)
            Start-ReleaseClient $c
            return @{ status='unverified'; code='manual_logout_login_required' }
        }
        'relogin' {
            if ((Get-ReleaseLogonHash) -eq $c.loginHash) { throw 'new_logon_not_observed' }
            Assert-ReleaseClients $c
            if (@(Get-Process WindowsUse -ErrorAction SilentlyContinue).Count -ne 1 -or
                (Get-ReleaseStartup) -ne (Get-ReleaseStartupCommand $c) -or
                !(Invoke-ReleaseCli $c @('doctor')).desktop.ok) { throw 'login_startup_not_verified' }
        }
        'uninstall' {
            if (!$c.relogin) { Start-ReleaseClient $c }
            Invoke-ReleaseUninstall $c
        }
        'verify-uninstall' { Test-ReleaseUninstalled $c }
        'cleanup' { return Invoke-ReleaseCleanup $c }
        default { throw 'unknown_phase' }
    }
    return @{ status='passed'; code='verified' }
}
