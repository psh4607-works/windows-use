# Run in a logged-in Windows desktop session, against an installed test client.
# Uses Windows accessibility on this client's own window; does not move the pointer.
param(
    [Parameter(Mandatory=$true)][string]$ClientDirectory,
    [Parameter(Mandatory=$true)][string]$ReportPath,
    [string]$StateDirectory,
    [switch]$AllowUnavailableSsh,
    [switch]$SanitizeReport
)
$ErrorActionPreference = 'Stop'
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Run this smoke test in an interactive desktop session, not SSH session 0.' }
if (Get-Process WindowsUse -ErrorAction SilentlyContinue) { throw 'An existing Windows Use client is running. Refusing to touch another owner.' }
if (Test-Path $ReportPath) { throw 'ReportPath must be a new file.' }
$exe = Join-Path $ClientDirectory 'WindowsUse.exe'
$runtime = Join-Path $ClientDirectory 'runtime/node.exe'
$cli = Join-Path $ClientDirectory 'bin/windows-use.mjs'
$manifest = Join-Path $ClientDirectory 'package-manifest.json'
foreach ($file in @($exe, $runtime, $cli, $manifest)) { if (!(Test-Path $file)) { throw "Missing client file: $file" } }
$manifestHash = (Get-FileHash $manifest -Algorithm SHA256).Hash.ToLower()
Add-Type -AssemblyName Accessibility
# .NET Framework WinForms exposes MSAA actions even when a PowerShell UIA host
# does not supply the legacy Win32 proxies. Target accessible names and roles.
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Accessibility;
public static class WindowsUseSmokeAccessibility {
    delegate bool EnumCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr data);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    static IAccessible Get(IntPtr window) {
        if(window==IntPtr.Zero) return null;
        IAccessible accessible; Guid iid=typeof(IAccessible).GUID;
        if (AccessibleObjectFromWindow(window, 0xFFFFFFFC, ref iid, out accessible)!=0) return null;
        return accessible;
    }
    public static IntPtr Find(IntPtr root, string name, int role) {
        if(root==IntPtr.Zero) return IntPtr.Zero;
        IntPtr found=IntPtr.Zero;
        EnumChildWindows(root, delegate(IntPtr window, IntPtr unused) {
            try { var item=Get(window); if(item!=null && item.get_accName(0)==name && Convert.ToInt32(item.get_accRole(0))==role) { found=window; return false; } }
            catch { }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool Enabled(IntPtr window) { var item=Get(window); return item!=null && (Convert.ToInt32(item.get_accState(0)) & 1)==0; }
    public static bool Checked(IntPtr window) { return (Convert.ToInt32(Get(window).get_accState(0)) & 16)!=0; }
    public static void Invoke(IntPtr window) { Get(window).accDoDefaultAction(0); }
    public static void SetValue(IntPtr window, string value) { Get(window).set_accValue(0, value); }
    public static string ConnectionResult(IntPtr root) {
        if(root==IntPtr.Zero) return "";
        string result="";
        EnumChildWindows(root, delegate(IntPtr window, IntPtr unused) {
            try { var item=Get(window); if(item!=null && Convert.ToInt32(item.get_accRole(0))==42) {
                string text=item.get_accValue(0);
                if(text!=null && text.StartsWith("데스크톱: ")) { result=text; return false; }
            } } catch { }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
$state = if ($StateDirectory) { $StateDirectory } else { Join-Path $env:TEMP ('wu-client-smoke-' + [guid]::NewGuid().ToString('N')) }
if (Test-Path $state) { throw 'StateDirectory must be a new directory.' }
$oldHome = $env:WINDOWS_USE_HOME
$oldPath = $env:PATH
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$oldStartup = (Get-ItemProperty $runKey -Name WindowsUse -ErrorAction SilentlyContinue).WindowsUse
$client = $null
$results = [System.Collections.Generic.List[string]]::new()
function Wait-For([scriptblock]$Condition, [string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do { if (& $Condition) { return }; Start-Sleep -Milliseconds 150 } while ([DateTime]::UtcNow -lt $deadline)
    throw $Message
}
function Invoke-ClientCommand([string]$Command) {
    $raw = & $runtime $cli $Command
    $response = $raw | ConvertFrom-Json
    if (!$response.ok) { throw $response.error.message }
    return $response.result
}
function Invoke([string]$Name) {
    Wait-For { $client.Refresh(); $element = [WindowsUseSmokeAccessibility]::Find($client.MainWindowHandle, $Name, 43); [WindowsUseSmokeAccessibility]::Enabled($element) } "Button unavailable: $Name"
    [WindowsUseSmokeAccessibility]::Invoke([WindowsUseSmokeAccessibility]::Find($client.MainWindowHandle, $Name, 43))
}
try {
    $env:WINDOWS_USE_HOME = $state
    # Deliberately exclude any global Node/npm installation from the client environment.
    $env:PATH = "$env:WINDIR\System32;$env:WINDIR;$env:WINDIR\System32\WindowsPowerShell\v1.0"
    $client = Start-Process $exe -PassThru
    Wait-For { Test-Path (Join-Path $state 'server.json') } 'Client did not register a desktop broker.'
    Wait-For { (Invoke-ClientCommand 'status').state -eq 'running' } 'Client did not become ready.'
    if (!(Invoke-ClientCommand 'doctor').desktop.ok) { throw 'Desktop enumeration failed.' }
    $results.Add('bundled Node and real desktop enumeration without Node on PATH')
    Invoke '일시 중지'
    Wait-For { (Invoke-ClientCommand 'status').state -eq 'paused' } 'Pause did not revoke access.'
    $rejected = (& $runtime $cli apps | ConvertFrom-Json)
    if ($rejected.ok -or $rejected.error.code -ne 'desktop_paused') { throw 'Paused client accepted a desktop request.' }
    $results.Add('accessible pause button rejects desktop requests')
    Invoke '재개'
    Wait-For { (Invoke-ClientCommand 'status').state -eq 'running' } 'Resume failed.'
    $results.Add('accessible resume button restores access')
    $alias = [WindowsUseSmokeAccessibility]::Find($client.MainWindowHandle, 'SSH 연결 이름', 42)
    if(!$alias) { throw 'Connection alias input is not accessible.' }
    [WindowsUseSmokeAccessibility]::SetValue($alias, 'windows-use-smoke')
    Invoke '연결 설정 저장'
    Wait-For { (Get-Content (Join-Path $state 'settings.json') -Raw | ConvertFrom-Json).connection.alias -eq 'windows-use-smoke' } 'Connection profile was not saved.'
    Invoke '연결 테스트'
    Wait-For { [WindowsUseSmokeAccessibility]::ConnectionResult($client.MainWindowHandle).Contains('데스크톱: 성공') } 'Connection test did not report successful desktop access.'
    $connectionResult = [WindowsUseSmokeAccessibility]::ConnectionResult($client.MainWindowHandle)
    if(!$AllowUnavailableSsh -and !$connectionResult.Contains('SSH 응답: 성공')) { throw ('Local SSH connection test failed: ' + $connectionResult) }
    $results.Add('accessible connection settings save and connection test finish')
    $startup = [WindowsUseSmokeAccessibility]::Find($client.MainWindowHandle, 'Windows 로그인 시 자동 시작', 44)
    if(!$startup) { throw 'Startup checkbox is not accessible.' }
    [WindowsUseSmokeAccessibility]::Invoke($startup)
    Start-Sleep -Milliseconds 200
    $expectedEnabled = [WindowsUseSmokeAccessibility]::Checked($startup)
    $registered = (Get-ItemProperty $runKey -Name WindowsUse -ErrorAction SilentlyContinue).WindowsUse
    if ($expectedEnabled -ne ($registered -eq ('"' + $exe + '" --background'))) { throw 'Login startup checkbox and registry differ.' }
    $results.Add('login startup checkbox updates the per-user Run registration (not an actual relogin)')
    Invoke '일시 중지'
    Wait-For { (Invoke-ClientCommand 'status').state -eq 'paused' } 'Second pause failed.'
    Invoke 'Windows Use 종료'
    if (!$client.WaitForExit(70000)) { throw 'Client did not exit cleanly.' }
    if (Test-Path (Join-Path $state 'server.json')) { throw 'Broker registration survived graceful exit.' }
    $client = Start-Process $exe -ArgumentList '--background' -PassThru
    Wait-For { Test-Path (Join-Path $state 'server.json') } 'Background restart failed.'
    Wait-For { (Invoke-ClientCommand 'status').state -eq 'paused' } 'Background restart did not preserve pause.'
    $results.Add('background launch preserves pause and graceful exit cleans up IPC')
    $shutdown = Start-Process $exe -ArgumentList '--shutdown' -PassThru -Wait
    if ($shutdown.ExitCode -ne 0 -or !$client.WaitForExit(70000)) { throw 'Installer shutdown command failed.' }
    $unverified=@('actual logout/login', 'SSH from another PC', 'installer wizard and uninstall', 'tray icon visual appearance')
    if ($AllowUnavailableSsh) { $unverified += 'local SSH listener (optional probe not required)' }
    if ($SanitizeReport) { $connectionResult='desktop verified; connection details omitted' }
    [ordered]@{ run=[ordered]@{ completedAtUtc=[DateTime]::UtcNow.ToString('o'); packageManifestSha256=$manifestHash }; ok=$true; checked=$results; connectionTest=$connectionResult; unverified=$unverified } |
        ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $ReportPath
} finally {
    if ($client -and !$client.HasExited) {
        $shutdown = Start-Process $exe -ArgumentList '--shutdown' -PassThru -Wait
        if (!$client.WaitForExit(70000)) { throw 'Test client is still running; preserve its state for inspection.' }
    }
    $env:WINDOWS_USE_HOME = $oldHome
    $env:PATH = $oldPath
    if ($null -eq $oldStartup) { Remove-ItemProperty $runKey -Name WindowsUse -ErrorAction SilentlyContinue }
    else { Set-ItemProperty $runKey -Name WindowsUse -Value $oldStartup }
    if (Test-Path $state) { Remove-Item -LiteralPath $state -Recurse -Force }
}
