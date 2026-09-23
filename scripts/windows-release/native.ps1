function ConvertTo-ReleaseArgument([string]$Value) {
    # CommandLineToArgvW quoting, including quotes and trailing backslashes (.NET 4.8).
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-ReleaseNativeArguments([string[]]$Arguments, [string]$InstallerDirectory) {
    if ($InstallerDirectory) {
        # NSIS consumes the unquoted final /D tail, including embedded spaces.
        # https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
        if ($Arguments.Count -or $InstallerDirectory -match '["\r\n]') { throw 'invalid_installer_directory' }
        return '/S /D='+$InstallerDirectory
    }
    return ($Arguments | ForEach-Object { ConvertTo-ReleaseArgument $_ }) -join ' '
}

function Invoke-ReleaseProcess {
    param([hashtable]$Context, [string]$File, [string[]]$Arguments, [int]$TimeoutMs=180000, [string]$InstallerDirectory)
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$File
    $info.Arguments=Get-ReleaseNativeArguments -Arguments $Arguments -InstallerDirectory $InstallerDirectory
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $process=[Diagnostics.Process]::Start($info)
    $Context.processes.Add($process)
    $stdout=$process.StandardOutput.ReadToEndAsync()
    $stderr=$process.StandardError.ReadToEndAsync()
    $timer=[Diagnostics.Stopwatch]::StartNew()
    if (!$process.WaitForExit($TimeoutMs)) { $Context.nativePending=$true; throw 'native_timeout' }
    $process.WaitForExit()
    $remaining=[Math]::Max(1, $TimeoutMs-[int]$timer.ElapsedMilliseconds)
    # A spawned descendant can retain redirected handles after the parent exits.
    $drained=[Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout,$stderr))
    if (!$drained.Wait($remaining)) { $Context.nativePending=$true; throw 'native_output_timeout' }
    if ($process.ExitCode -ne 0) { throw 'native_exit_nonzero' }
    # Never emit raw stderr, command lines or process paths into an artifact.
    return $stdout.GetAwaiter().GetResult().Trim()
}

function Wait-ReleaseCondition([scriptblock]$Condition, [int]$Seconds=30) {
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    do { if (& $Condition) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline)
    throw 'condition_timeout'
}
