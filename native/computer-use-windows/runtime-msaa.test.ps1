$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies ([System.Windows.Forms.Form].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class MsaaNativeFixtureForm : Form {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateWindowEx(int exStyle, string className, string title,
        int style, int x, int y, int width, int height, IntPtr parent, IntPtr id, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetWindowText(IntPtr window, string text);
    public IntPtr Button;
    public int Invocations;
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x111 && message.LParam == Button && Button != IntPtr.Zero &&
            ((message.WParam.ToInt64() >> 16) & 0xffff) == 0) Invocations++;
        base.WndProc(ref message);
    }
}
'@
$form = New-Object MsaaNativeFixtureForm
$form.Text = 'windows-use MSAA regression fixture'
$unidentified = New-Object System.Windows.Forms.Button
$unidentified.Text = 'Unidentified fixture'; $unidentified.Top = 90
$script:unidentifiedInvocations = 0
$unidentified.Add_Click({ $script:unidentifiedInvocations++ })
$secret = New-Object System.Windows.Forms.TextBox
$secret.Top = 50; $secret.UseSystemPasswordChar = $true
$secret.Text = 'fixture-secret-must-stay-redacted'
$form.Controls.Add($unidentified); $form.Controls.Add($secret)
$operation = Join-Path ([IO.Path]::GetTempPath()) ('wu-msaa-test-' + [guid]::NewGuid() + '.json')
try {
    $form.Show(); [System.Windows.Forms.Application]::DoEvents()
    # WinForms ButtonAccessibleObject does not expose IAccIdentity on .NET Framework.
    # Use a real standard BUTTON for the positive oleacc/COM/action path instead.
    $form.Button = [MsaaNativeFixtureForm]::CreateWindowEx(0, 'BUTTON', 'Continue fixture',
        0x50010000, 10, 10, 150, 30, $form.Handle, [IntPtr]101, [IntPtr]::Zero, [IntPtr]::Zero)
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($form.Button -eq [IntPtr]::Zero) {
        $errorMessage = ([ComponentModel.Win32Exception]::new($errorCode)).Message
        throw "Native fixture button creation failed ($errorCode): $errorMessage"
    }
    [System.Windows.Forms.Application]::DoEvents()
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
    $unidentifiedNodes = @($snapshot.elements | Where-Object { $_.name -eq 'Unidentified fixture' -and $_.controlType -eq 'MSAA.43' })
    if ($unidentifiedNodes.Count -ne 1 -or $null -ne $unidentifiedNodes[0].runtimeId -or $unidentifiedNodes[0].actions.Count -ne 0) {
        throw 'Unidentified WinForms control must remain visible without actions'
    }
    $rejected = $false
    try { [OrcaMsaa]::Act($unidentifiedNodes[0], 'invoke', $null) } catch { $rejected = $_.Exception.Message -like '*native identity unavailable*' }
    if (-not $rejected -or $script:unidentifiedInvocations -ne 0) { throw 'Unidentified WinForms control received input' }
    $buttons = @($snapshot.elements | Where-Object { $_.name -eq 'Continue fixture' -and $_.actions -contains 'Invoke' })
    if ($buttons.Count -ne 1) { throw 'Native MSAA button was not exposed as an actionable element' }
    $request = [pscustomobject]@{tool='perform_secondary_action';app=[string]$PID;windowId=[long]$form.Handle;noScreenshot=$true;accessibility='msaa';element=$buttons[0];action='invoke'}
    $null = Invoke-OrcaOperation $request
    [System.Windows.Forms.Application]::DoEvents()
    if ($form.Invocations -ne 1) { throw 'MSAA invocation did not reach the fixture button' }
    $renamed = [MsaaNativeFixtureForm]::SetWindowText($form.Button, 'Replacement control')
    $renameError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if (-not $renamed) {
        $errorMessage = ([ComponentModel.Win32Exception]::new($renameError)).Message
        throw "Fixture button rename failed ($renameError): $errorMessage"
    }
    $rejected = $false
    try { $null = Invoke-OrcaOperation $request } catch { $rejected = $true }
    if (-not $rejected -or $form.Invocations -ne 1) { throw 'Changed element identity was acted on' }
    Write-Output 'PASS: native MSAA observation/invoke, password redaction, stale element rejection, and unidentified control rejection'
} finally {
    $form.Close(); $form.Dispose()
    Remove-Item $operation -Force -ErrorAction SilentlyContinue
}
