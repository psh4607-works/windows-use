$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'windows-use MSAA regression fixture'
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Continue fixture'; $button.Top = 10
$script:invocations = 0
$button.Add_Click({ $script:invocations++ })
$secret = New-Object System.Windows.Forms.TextBox
$secret.Top = 50; $secret.UseSystemPasswordChar = $true
$secret.Text = 'fixture-secret-must-stay-redacted'
$form.Controls.Add($button); $form.Controls.Add($secret)
$operation = Join-Path ([IO.Path]::GetTempPath()) ('wu-msaa-test-' + [guid]::NewGuid() + '.json')
try {
    $form.Show(); [System.Windows.Forms.Application]::DoEvents()
    Set-Content $operation '{"tool":"handshake"}' -Encoding UTF8
    $null = . (Join-Path $PSScriptRoot 'runtime.ps1') -OperationPath $operation
    # A service-session test has no Process.MainWindowHandle; bind only this test's real form.
    function Find-OrcaProcess([string]$Query) {
        if ($Query -ne [string]$PID) { throw 'Unexpected fixture process' }
        [pscustomobject]@{Id=$PID;ProcessName='powershell';MainWindowHandle=$form.Handle;MainWindowTitle=$form.Text}
    }
    function Get-OrcaProcessWindows($Process) {
        [pscustomobject]@{id=[long]$form.Handle;title=$form.Text;index=0}
    }
    $snapshot = (Invoke-OrcaOperation ([pscustomobject]@{tool='get_app_state';app=[string]$PID;windowId=[long]$form.Handle;noScreenshot=$true;accessibility='msaa'})).snapshot
    if ($snapshot.accessibility -ne 'msaa') { throw 'MSAA backend was not used' }
    if (($snapshot | ConvertTo-Json -Depth 30) -match 'fixture-secret-must-stay-redacted') { throw 'Protected value leaked into snapshot' }
    $buttons = @($snapshot.elements | Where-Object { $_.name -eq 'Continue fixture' -and $_.actions -contains 'Invoke' })
    if ($buttons.Count -ne 1) { throw 'Native MSAA button was not exposed as an actionable element' }
    $request = [pscustomobject]@{tool='perform_secondary_action';app=[string]$PID;windowId=[long]$form.Handle;noScreenshot=$true;accessibility='msaa';element=$buttons[0];action='invoke'}
    $null = Invoke-OrcaOperation $request
    [System.Windows.Forms.Application]::DoEvents()
    if ($script:invocations -ne 1) { throw 'MSAA invocation did not reach the fixture button' }
    $button.Text = 'Replacement control'
    $rejected = $false
    try { $null = Invoke-OrcaOperation $request } catch { $rejected = $true }
    if (-not $rejected -or $script:invocations -ne 1) { throw 'Changed element identity was acted on' }
    Write-Output 'PASS: native MSAA observation/invoke, password redaction, and stale element rejection'
} finally {
    $form.Close(); $form.Dispose()
    Remove-Item $operation -Force -ErrorAction SilentlyContinue
}
