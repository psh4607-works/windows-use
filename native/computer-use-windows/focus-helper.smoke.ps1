param(
    [string]$HelperPath = (Join-Path $PSScriptRoot "focus-helper.ps1")
)

$ErrorActionPreference = "Stop"
$pipeName = "orca-computer-focus-smoke-$([guid]::NewGuid().ToString('N'))"
$token = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
$utf8 = [System.Text.UTF8Encoding]::new($false)
$helper = $null

function Invoke-OrcaFocusHelperSmokeRequest($request) {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new(
        ".",
        $pipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::Asynchronous
    )
    try {
        $client.Connect(2000)
        $reader = [System.IO.StreamReader]::new($client, $utf8, $false, 4096, $true)
        $writer = [System.IO.StreamWriter]::new($client, $utf8, 4096, $true)
        $writer.AutoFlush = $true
        try {
            $writer.WriteLine(($request | ConvertTo-Json -Compress))
            $reader.ReadLine() | ConvertFrom-Json
        } finally {
            $reader.Dispose()
            $writer.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

try {
    $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powerShell
    $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$HelperPath`" -PipeName $pipeName -ParentPid $PID"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["ORCA_COMPUTER_WINDOWS_FOCUS_TOKEN"] = $token
    $helper = [Diagnostics.Process]::Start($startInfo)

    $readyTask = $helper.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(5000) -or $readyTask.Result -ne '{"ready":true}') {
        throw "focus helper did not become ready: $($helper.StandardError.ReadToEnd())"
    }

    $invalid = Invoke-OrcaFocusHelperSmokeRequest ([pscustomobject]@{
        command = "focus"
        token = ("0" * 64)
        pid = $PID
        windowHandle = 1
    })
    if ([bool]$invalid.ok -or [string]$invalid.error -ne "authentication_failed") {
        throw "focus helper accepted an invalid token"
    }

    $wrongOwner = Invoke-OrcaFocusHelperSmokeRequest ([pscustomobject]@{
        command = "focus"
        token = $token
        pid = $PID
        windowHandle = 1
    })
    if ([bool]$wrongOwner.ok -or [string]$wrongOwner.error -ne "window_owner_mismatch") {
        throw "focus helper accepted a window not owned by the requested process"
    }

    $terminated = Invoke-OrcaFocusHelperSmokeRequest ([pscustomobject]@{
        command = "terminate"
        token = $token
    })
    if (-not [bool]$terminated.ok -or -not [bool]$terminated.terminate) {
        throw "focus helper did not accept authenticated termination"
    }
    if (-not $helper.WaitForExit(5000)) { throw "focus helper did not exit after termination" }

    [pscustomobject]@{
        ok = $true
        authenticationRejected = $true
        windowOwnershipRejected = $true
        cleanTermination = $true
    } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $helper -and -not $helper.HasExited) {
        $helper.Kill()
        [void]$helper.WaitForExit(2000)
    }
}
