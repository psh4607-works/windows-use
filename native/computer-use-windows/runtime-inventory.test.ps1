$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'),[ref]$null,[ref]$null)
foreach($def in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $def.Extent.Text}
Add-Type -TypeDefinition @'
using System;
public static class OrcaDesktopWin32 {
 public static bool Churn=false;
 public static bool AfterLookup=false;
 public static uint ReplacementOwner=2;
 public static long[] ProcessWindows(uint pid) { if(pid!=0) throw new Exception("Must enumerate desktop HWNDs"); return new long[]{11,12,13,14}; }
 public static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid=AfterLookup && h.ToInt64()>=13?ReplacementOwner:Churn && h.ToInt64()==12?0u:(h.ToInt64()>=13?2u:1u); return 10; }
}
'@
$script:processReads=0
$script:processTable=@([pscustomobject]@{Id=1;ProcessName='fixture';MainWindowHandle=[IntPtr]0},[pscustomobject]@{Id=2;ProcessName='fixture';MainWindowHandle=[IntPtr]0})
$script:targetedReads=0
$script:lateProcess=$null
function Get-Process {
 param($Id)
 if($null -ne $Id){
  $script:targetedReads++
  [OrcaDesktopWin32]::AfterLookup=$true
  if($script:lateProcess -and $script:lateProcess.Id -eq $Id){return $script:lateProcess}
  $found=@($script:processTable | Where-Object Id -eq $Id)
  if($found.Count -eq 0){throw 'Process disappeared'}
  return $found
 }
 $script:processReads++
 $script:processTable
}
$processes=@(Get-OrcaDesktopWindowProcesses)
if($processes.Count -ne 2 -or $processes[0].MainWindowHandle -ne 0){throw 'Desktop inventory must discover unique owners without MainWindowHandle'}
if($script:targetedReads -ne 0){throw 'Known owners must not require targeted lookups'}
Write-Output 'PASS: HWND-first desktop inventory includes popup-only processes'
if(@(Get-OrcaWindowProcesses).Count -ne 2){throw 'App resolution must include popup-only window owners'}
Write-Output 'PASS: popup-only owners remain targetable'
[OrcaDesktopWin32]::Churn=$true
$script:processTable=@($script:processTable | Where-Object Id -eq 1)
$script:processReads=0
$survivors=@(Get-OrcaWindowProcesses)
if($survivors.Count -ne 1 -or $survivors[0].Id -ne 1){throw 'App resolution must tolerate vanished unrelated windows and processes'}
if($script:processReads -ne 1){throw 'App discovery must read one process table'}
$rejected=$false
try { Get-OrcaDesktopWindowProcesses -Strict | Out-Null } catch { $rejected=$_.Exception.Message -like '*window_inventory_incomplete*' }
if(-not $rejected){throw 'Strict global inventory must reject desktop churn'}
[OrcaDesktopWin32]::Churn=$false
$rejected=$false
try { Get-OrcaDesktopWindowProcesses -Strict | Out-Null } catch { $rejected=$_.Exception.Message -like '*window_inventory_incomplete*' }
if(-not $rejected){throw 'Strict global inventory must reject missing owner process'}
Write-Output 'PASS: app discovery tolerates churn while strict inventory rejects it'
$script:lateProcess=[pscustomobject]@{Id=2;ProcessName='new-fixture';MainWindowHandle=[IntPtr]0}
foreach($strict in @($false,$true)) {
 $script:processReads=0; $script:targetedReads=0; [OrcaDesktopWin32]::AfterLookup=$false
 $lateOwners=@(Get-OrcaDesktopWindowProcesses -Strict:$strict)
 if($lateOwners.Count -ne 2 -or $lateOwners[1].Id -ne 2){throw 'New window owner absent from initial process table must resolve in both modes'}
 if($script:processReads -ne 1 -or $script:targetedReads -ne 1){throw 'Fallback must read missing owner once and preserve one bulk read'}
}
Write-Output 'PASS: late-created owner resolves once in normal and strict inventories'
foreach($replacement in @(0,3)) {
 [OrcaDesktopWin32]::ReplacementOwner=$replacement
 [OrcaDesktopWin32]::AfterLookup=$false
 $survivors=@(Get-OrcaDesktopWindowProcesses)
 if($survivors.Id -contains 2){throw 'Late lookup must not accept an owner after original HWND changes owner or disappears'}
 [OrcaDesktopWin32]::AfterLookup=$false
 $rejected=$false
 try { Get-OrcaDesktopWindowProcesses -Strict | Out-Null } catch { $rejected=$_.Exception.Message -like '*window_inventory_incomplete*' }
 if(-not $rejected){throw 'Strict inventory must reject owner changes during late lookup'}
}
[OrcaDesktopWin32]::ReplacementOwner=2
[OrcaDesktopWin32]::AfterLookup=$false
Write-Output 'PASS: fallback rechecks original HWND owner; changed or destroyed windows cannot adopt stale owner'
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
Add-Type -TypeDefinition @'
using System;
public static class RectangleProbe {
 public struct RECT { public int Left,Top,Right,Bottom; }
 public static bool Live=false;
 public static long[] ProcessWindows(uint pid) { return new long[]{12}; }
 public static bool GetWindowRect(IntPtr h, ref RECT r) { return false; }
 public static bool IsWindow(IntPtr h) { return Live; }
}
'@
$windowDef=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-OrcaProcessWindows'},$true)[0].Extent.Text
Invoke-Expression ($windowDef.Replace('Get-OrcaProcessWindows','Get-ProbeWindows').Replace('OrcaDesktopWin32','RectangleProbe'))
$fixture=[pscustomobject]@{Id=1}
if(@(Get-ProbeWindows $fixture).Count -ne 0){throw 'Destroyed popup must be skipped in app mode'}
$rejected=$false
try { Get-ProbeWindows $fixture -Strict | Out-Null } catch { $rejected=$_.Exception.Message -like '*window_inventory_incomplete*' }
if(-not $rejected){throw 'Strict inventory must reject missing rectangle'}
[RectangleProbe]::Live=$true
$rejected=$false
try { Get-ProbeWindows $fixture | Out-Null } catch { $rejected=$_.Exception.Message -like '*window_inventory_incomplete*' }
if(-not $rejected){throw 'Unreadable live window must fail closed in app mode'}
Write-Output 'PASS: destroyed popup skipped only in app mode; live failures and strict inventory reject'
