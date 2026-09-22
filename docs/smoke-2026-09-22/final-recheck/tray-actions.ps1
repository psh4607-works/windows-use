Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class TrayNative {
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
}
'@
$root=Join-Path $env:TEMP 'WindowsUse-Verify-20260922-02'
$env:WINDOWS_USE_HOME=Join-Path $root 'TrayState'
$clientPid=[int][IO.File]::ReadAllText((Join-Path $root 'tray-pid.txt'))
$runtime=Join-Path $root 'Client/runtime/node.exe'
$entry=Join-Path $root 'Client/bin/windows-use.mjs'
function Condition([string]$name) { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name) }
function WaitFor([scriptblock]$condition,[string]$message) {
 $until=[DateTime]::UtcNow.AddSeconds(20)
 do { if(& $condition) { return };Start-Sleep -Milliseconds 150 } while([DateTime]::UtcNow -lt $until)
 throw $message
}
function Status { (& $runtime $entry status | ConvertFrom-Json).result.state }
function FindMenu {
 foreach($item in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
  if($item.Current.ProcessId -eq $clientPid -and $item.Current.Name -eq 'DropDown' -and !$item.Current.IsOffscreen) { return $item }
 }
}
function OpenMenu {
 $existing=FindMenu
 if($existing) { return $existing }
 $tray=[System.Windows.Automation.AutomationElement]::FromHandle([TrayNative]::FindWindow('Shell_TrayWnd',$null))
 $arrow=$tray.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(Condition '숨겨진 아이콘 표시'))
 if($arrow) { $arrow.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();Start-Sleep -Milliseconds 300 }
 $overflow=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'TopLevelWindowForOverflowXamlIsland')))
 if(!$overflow) { throw 'Tray overflow unavailable' }
 $icon=$null
 foreach($item in $overflow.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)) {
  if($item.Current.Name.StartsWith('Windows Use') -and $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $icon=$item;break }
 }
 if(!$icon) { throw 'Windows Use tray icon unavailable' }
 $script:iconName=$icon.Current.Name
 $icon.SetFocus()
 if(![System.Windows.Automation.Automation]::Compare([System.Windows.Automation.AutomationElement]::FocusedElement,$icon)) { throw 'Tray icon focus failed' }
 [System.Windows.Forms.SendKeys]::SendWait('+{F10}')
 WaitFor { $null -ne (FindMenu) } 'Context menu did not open'
 return FindMenu
}
function InvokeMenu($menu,[string]$name) {
 $item=$menu.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(Condition $name))
 if(!$item -or !$item.Current.IsEnabled) { throw ('Menu action unavailable: '+$name) }
 $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function AssertLabel($menu,[string]$name) {
 if(!$menu.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(Condition $name))) { throw ('Status label missing: '+$name) }
}
function CaptureMenu($menu,[string]$filename) {
 $handle=[IntPtr]$menu.Current.NativeWindowHandle
 $rect=New-Object TrayNative+Rect
 if(![TrayNative]::GetWindowRect($handle,[ref]$rect)) { throw 'Cannot size own tray menu' }
 $bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 $dc=$graphics.GetHdc()
 try { if(![TrayNative]::PrintWindow($handle,$dc,2)) { throw 'Own menu PrintWindow failed' } }
 finally { $graphics.ReleaseHdc($dc);$graphics.Dispose() }
 try { $bitmap.Save((Join-Path $root $filename),[Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
}
$menu=OpenMenu
AssertLabel $menu '실행 중'
CaptureMenu $menu 'tray-menu-running.png'
InvokeMenu $menu '일시 중지'
WaitFor { (Status) -eq 'paused' } 'Tray pause did not revoke access'
$denied=& $runtime $entry apps | ConvertFrom-Json
if($denied.ok -or $denied.error.code -ne 'desktop_paused') { throw 'Paused tray allowed desktop access' }
$menu=OpenMenu
AssertLabel $menu '일시 중지됨'
$pausedIcon=$script:iconName
CaptureMenu $menu 'tray-menu-paused.png'
InvokeMenu $menu '재개'
WaitFor { (Status) -eq 'running' } 'Tray resume failed'
$doctor=& $runtime $entry doctor | ConvertFrom-Json
if(!$doctor.result.desktop.ok) { throw 'Desktop did not recover after tray resume' }
$menu=OpenMenu
AssertLabel $menu '실행 중'
InvokeMenu $menu '종료'
WaitFor { !(Get-Process -Id $clientPid -ErrorAction SilentlyContinue) } 'Tray exit did not stop the app'
if(Test-Path (Join-Path $env:WINDOWS_USE_HOME 'server.json')) { throw 'Tray exit left its desktop registration' }
$tray=[System.Windows.Automation.AutomationElement]::FromHandle([TrayNative]::FindWindow('Shell_TrayWnd',$null))
$arrow=$tray.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(Condition '숨겨진 아이콘 표시 숨기기'))
if($arrow) { $arrow.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
[ordered]@{ok=$true;runningStatusLabel=$true;pausedStatusLabel=$true;pausedTrayIconName=$pausedIcon;pauseRejectsDesktop=$true;resumeRestoresDesktop=$true;exitStopsProcessAndRemovesRegistration=$true;interaction='UIA Invoke; verified tray-icon focus followed by Shift+F10; no pointer movement or coordinate clicks';captures=@('tray-menu-running.png','tray-menu-paused.png')}
