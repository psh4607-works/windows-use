function Get-ReleaseHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Assert-ReleaseNoLinks([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    # Check ancestors too: a safe-looking child can be inside a junction.
    $ancestor = $item
    while ($ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'linked_path_refused' }
        $ancestor = if ($ancestor -is [IO.DirectoryInfo]) { $ancestor.Parent } else { $ancestor.Directory }
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'linked_path_refused' }
            if ($child.PSIsContainer) { Assert-ReleaseNoLinks $child.FullName }
        }
    }
}

function Assert-ReleaseOwnedDirectory([string]$Path, [string]$RunId) {
    if ($RunId -notmatch '^[a-f0-9]{32}$') { throw 'invalid_run_id' }
    Assert-ReleaseNoLinks $Path
    if ([IO.File]::ReadAllText((Join-Path $Path '.release-owner')) -cne $RunId) { throw 'foreign_owner' }
}

function Remove-ReleaseOwnedDirectory([string]$Path, [string]$RunId) {
    Assert-ReleaseOwnedDirectory $Path $RunId
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Resolve-ReleasePayloadFile([string]$Directory, [string]$Relative) {
    if ($Relative -notmatch '^[A-Za-z0-9_.\/-]+$' -or $Relative.StartsWith('/') -or
        @($Relative.Split('/') | Where-Object { $_ -in @('','..','.') }).Count) { throw 'unsafe_manifest_path' }
    $path = Join-Path $Directory $Relative
    Assert-ReleaseNoLinks $path
    return $path
}

function Test-ReleaseManifest([string]$Directory) {
    $path=Join-Path $Directory 'package-manifest.json'
    Assert-ReleaseNoLinks $path
    $manifest=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($manifest.architecture -ne 'x64' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or
        $manifest.runtime.version -notmatch '^\d+\.\d+\.\d+$' -or !$manifest.files) { throw 'invalid_manifest' }
    $count=0
    foreach ($file in $manifest.files.PSObject.Properties) {
        if ($file.Value -cnotmatch '^[a-f0-9]{64}$' -or
            (Get-ReleaseHash (Resolve-ReleasePayloadFile $Directory $file.Name)) -cne $file.Value) { throw 'payload_hash_mismatch' }
        $count++
    }
    if (!$count) { throw 'empty_manifest' }
    return @{ sha256=Get-ReleaseHash $path; version=$manifest.version; runtime=$manifest.runtime.version; fileCount=$count }
}

function Assert-ReleaseEnvironment([hashtable]$Facts) {
    foreach ($key in @('windows','x64','interactive','net48','supportedOs')) {
        if ($Facts[$key] -ne $true) { throw 'prerequisite_missing' }
    }
    foreach ($key in @('client','owner','registration','startup','shortcuts','server')) {
        if ($Facts[$key] -ne $false) { throw 'protected_existing_resource' }
    }
}

function Assert-ReleaseRecoveryProcesses($Context, $Processes, [int]$CurrentPid) {
    $clients=@($Processes | Where-Object { $_.Name -eq 'WindowsUse.exe' -and $_.ExecutablePath -eq (Join-Path $Context.install 'WindowsUse.exe') })
    foreach ($process in $Processes) {
        if ($process.ProcessId -eq $CurrentPid -or !$process.CommandLine -or
            $process.CommandLine.IndexOf($Context.work, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if ($process.ProcessId -in $clients.ProcessId) { continue }
        if ($process.ExecutablePath -eq (Join-Path $Context.install 'runtime/node.exe') -and
            $process.ParentProcessId -in $clients.ProcessId) { continue }
        throw 'recovery_process_still_running'
    }
}
