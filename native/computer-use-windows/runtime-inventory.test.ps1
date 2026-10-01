$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'),[ref]$null,[ref]$null)
foreach($def in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $def.Extent.Text}
Add-Type -TypeDefinition @'
using System;
public static class OrcaDesktopWin32 {
 public static long[] ProcessWindows(uint pid) { if(pid!=0) throw new Exception("Must enumerate desktop HWNDs"); return new long[]{11,12,13}; }
 public static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid=h.ToInt64()==13?2u:1u; return 10; }
}
'@
function Get-Process { param($Id) [pscustomobject]@{Id=$Id;ProcessName='fixture';MainWindowHandle=[IntPtr]0} }
$processes=@(Get-OrcaDesktopWindowProcesses)
if($processes.Count -ne 2 -or $processes[0].MainWindowHandle -ne 0){throw 'Desktop inventory must discover unique owners without MainWindowHandle'}
Write-Output 'PASS: HWND-first desktop inventory includes popup-only processes'
if(@(Get-OrcaWindowProcesses).Count -ne 2){throw 'App resolution must include popup-only window owners'}
Write-Output 'PASS: popup-only owners remain targetable'
$source=Get-Content (Join-Path $PSScriptRoot 'runtime.ps1') -Raw
$method=[regex]::Match($source,'(?s)public static long\[\] ProcessWindows\(.*?\n    }').Value
Add-Type -TypeDefinition (@'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InventoryNativeProbe {
 public delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
 public static bool EnumWindows(EnumWindowCallback callback, IntPtr parameter) { return false; }
 public static uint GetWindowThreadProcessId(IntPtr window, out uint owner) { owner=1; return 1; }
 public static bool IsWindowVisible(IntPtr window) { return true; }
'@ + $method + '}')
$rejected=$false
try { [InventoryNativeProbe]::ProcessWindows(0) | Out-Null } catch { $rejected=$_.Exception.GetBaseException().Message -like '*window_inventory_incomplete*' }
if(-not $rejected){throw 'EnumWindows failure must not report complete empty inventory'}
Write-Output 'PASS: native enumeration failure rejects inventory'
