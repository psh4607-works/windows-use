$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'), [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $definition.Extent.Text }
function Assert-Test($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Assert-OrcaProcessAllowed($Process) {}
function Get-OrcaWindowProcesses { @([pscustomobject]@{Id=11;ProcessName='putty';MainWindowTitle='one'},[pscustomobject]@{Id=12;ProcessName='putty';MainWindowTitle='two'}) }
$rejected = $false
try { Find-OrcaProcess 'putty' | Out-Null } catch { $rejected = $_.Exception.Message -like '*ambiguous_app*' }
Assert-Test $rejected 'Ambiguous process names must be rejected'
Assert-Test ((Find-OrcaProcess 'pid:12').Id -eq 12) 'Explicit PID must resolve'
Write-Output 'PASS: strict process resolution'
function Get-OrcaWindowProcesses { @([pscustomobject]@{Id=11;ProcessName='notepad';MainWindowTitle='Document'},[pscustomobject]@{Id=12;ProcessName='browser';MainWindowTitle='notepad.txt'}) }
Assert-Test ((Find-OrcaProcess 'notepad').Id -eq 11) 'Exact process name must precede title substring'
Assert-Test ((Find-OrcaProcess 'notepad.exe').Id -eq 11) 'Executable suffix must resolve exact process name'
function Get-OrcaWindowProcesses { @([pscustomobject]@{Id=11;ProcessName='editor';MainWindowTitle='Target'},[pscustomobject]@{Id=12;ProcessName='browser';MainWindowTitle='Target docs'}) }
Assert-Test ((Find-OrcaProcess 'Target').Id -eq 11) 'Exact title must precede title substring'
$rejected=$false
try { Find-OrcaProcess 'pid:99' | Out-Null } catch { $rejected=$_.Exception.Message -like 'appNotFound*' }
Assert-Test $rejected 'Missing numeric PID must never fall back to title'
function Get-OrcaWindowProcesses { @([pscustomobject]@{Id=11;ProcessName='putty';MainWindowTitle='one'},[pscustomobject]@{Id=12;ProcessName='putty';MainWindowTitle='two'}) }
Write-Output 'PASS: tiered name resolution'
$fixture = [pscustomobject]@{Id=11;StartTime=[datetime]'2026-01-01T00:00:00Z'}
Assert-Test ((Get-OrcaProcessInstance $fixture) -eq '2026-01-01T00:00:00.0000000Z') 'Process instance must be UTC start time'
$rejected = $false
try { Assert-OrcaProcessInstance $fixture 'old' } catch { $rejected = $_.Exception.Message -like '*process_instance_changed*' }
Assert-Test $rejected 'Reused PID must be rejected'
Assert-OrcaProcessInstance $fixture '2026-01-01T00:00:00.0000000Z'
Write-Output 'PASS: process incarnation guard'
function New-OrcaAppRecord($Process) { [pscustomobject]@{pid=$Process.Id;name=$Process.ProcessName} }
function Get-OrcaProcessWindows($Process) { [pscustomobject]@{id=$Process.Id*10;app=(New-OrcaAppRecord $Process);processInstance='instance';className='PuTTY';ownerWindowId=0;rootOwnerWindowId=$Process.Id*10;isForeground=$false} }
function Get-OrcaDesktopWindowProcesses { Get-OrcaWindowProcesses }
$all = Get-OrcaWindowList '' $true
Assert-Test (@($all.windows).Count -eq 2 -and $null -eq $all.app) 'Desktop inventory must include all process windows'
Write-Output 'PASS: desktop inventory'
Add-Type -TypeDefinition @'
namespace Windows.Automation {
 public static class ExpandCollapsePattern { public static readonly object Pattern = new object(); }
}
'@
$element = [pscustomobject]@{Current=[pscustomobject]@{IsEnabled=$true;IsOffscreen=$false;IsKeyboardFocusable=$true;HasKeyboardFocus=$false};Expanded=$false}
$element | Add-Member ScriptMethod GetSupportedPatterns { @([pscustomobject]@{ProgrammaticName='ExpandCollapsePatternIdentifiers.Pattern'}) }
$element | Add-Member ScriptMethod GetCurrentPattern { param($p) $this }
$element | Add-Member ScriptMethod Expand { $this.Expanded=$true }
$element | Add-Member ScriptMethod Collapse { $this.Expanded=$false }
$element | Add-Member ScriptMethod SetFocus { $this.Current.HasKeyboardFocus=$true }
Assert-Test ((Get-OrcaActions $element) -contains 'Expand') 'Tree must advertise Expand'
Assert-Test (Invoke-OrcaNamedAction $element 'expand') 'Expand must be supported'
Assert-Test $element.Expanded 'Expand must reach element'
Assert-Test (Invoke-OrcaNamedAction $element 'collapse') 'Collapse must be supported'
Assert-Test (-not $element.Expanded) 'Collapse must reach element'
Assert-Test (Invoke-OrcaNamedAction $element 'focus') 'Focus must be supported'
Assert-Test $element.Current.HasKeyboardFocus 'Focus must reach element'
Write-Output 'PASS: explicit UIA focus and expansion'
$element.Current.HasKeyboardFocus=$false
$rejected=$false
try { Assert-OrcaElementKeyboardFocus $element } catch { $rejected=$_.Exception.Message -like '*element_not_focused*' }
Assert-Test $rejected 'Keyboard must reject an unfocused element without changing focus'
Assert-Test (-not $element.Current.HasKeyboardFocus) 'Keyboard preflight must not focus implicitly'
$element.Current.HasKeyboardFocus=$true
Assert-OrcaElementKeyboardFocus $element
Write-Output 'PASS: keyboard element focus assertion'
function Test-OrcaSensitiveElement($Element) { $false }
function Get-OrcaValueText($Element,$Sensitive,[switch]$Metadata) { @{value='';valueAvailable=$false;valueTruncated=$false} }
function Get-OrcaRuntimeId($Element) { @(1) }
function Test-OrcaElementSelected($Element) { $false }
function Get-OrcaElementFrame($Element,$Frame) { $null }
$record=New-OrcaElementRecord $element 1 $null
Assert-Test ($record.hasKeyboardFocus -and $record.isKeyboardFocusable -and $record.isEnabled) 'UIA focus and enabled state must be observable'
$element.Current.IsEnabled=$false
$record=New-OrcaElementRecord $element 1 $null
Assert-Test ($record.actionabilityReason -eq 'disabled' -and @($record.actions).Count -eq 0) 'Disabled elements must explain unavailable actions'
Write-Output 'PASS: UIA actionability metadata'
$rejected=$false
try { Assert-OrcaProcessInstance $fixture '' } catch { $rejected=$_.Exception.Message -like '*process_instance*' }
Assert-Test $rejected 'Missing expected process incarnation must fail closed'
Write-Output 'PASS: missing process incarnation rejection'
function Find-OrcaProcess($Query) { [pscustomobject]@{Id=11;ProcessName='fixture';MainWindowHandle=[IntPtr]110;processInstance='instance'} }
function Select-OrcaWindowTarget($Process,$WindowId,$WindowIndex) { $Process }
function Assert-OrcaWindowTarget($Process,$WindowId,$WindowIndex) {}
function Get-OrcaRootElement($Process) { $null }
function Get-OrcaWindowFrame($Process,$Root) { $null }
function Find-OrcaElement($Root,$Record) { if ($null -ne $Record) { $element } }
function Invoke-OrcaNamedAction($Element,$Action) { $true }
function New-OrcaSnapshot { throw 'windowNotFound("closed")' }
$result = Invoke-OrcaOperation ([pscustomobject]@{tool='perform_secondary_action';app='11';windowId=110;expectedProcessInstance='instance';element=@{index=1};action='invoke';noScreenshot=$true})
Assert-Test ($result.ok -and $null -eq $result.snapshot -and $result.action.verification.reason -eq 'window_changed') 'Successful dispatch must survive source window closure without retargeting'
Write-Output 'PASS: source closure preserves action result'
function Test-OrcaWindowFocused($Handle) { $true }
function Get-OrcaPointerTarget($Point) { [pscustomobject]@{windowId=999;pid=99} }
$rejected=$false
try { Assert-OrcaPointerTarget ([pscustomobject]@{Id=11;MainWindowHandle=[IntPtr]110;processInstance='instance'}) @{x=10;y=10} 'instance' } catch { $rejected=$_.Exception.Message -like '*pointer_target_mismatch*' }
Assert-Test $rejected 'Pointer must reject a point obscured by another window'
function Get-OrcaPointerTarget($Point) { [pscustomobject]@{windowId=110;pid=11} }
Assert-OrcaPointerTarget ([pscustomobject]@{Id=11;MainWindowHandle=[IntPtr]110;processInstance='instance'}) @{x=10;y=10} 'instance'
function Test-OrcaWindowFocused($Handle) { $false }
$rejected=$false
try { Assert-OrcaPointerTarget ([pscustomobject]@{Id=11;MainWindowHandle=[IntPtr]110;processInstance='instance'}) @{x=10;y=10} 'instance' } catch { $rejected=$_.Exception.Message -like '*window_not_focused*' }
Assert-Test $rejected 'Pointer must reject failed foreground activation'
Write-Output 'PASS: pointer hit-test and foreground guard'
function Get-OrcaProcessWindows($Process) { if ($Process.Id -eq 11) { throw 'inventory_fixture_failure' }; [pscustomobject]@{id=120} }
$rejected=$false
try { Get-OrcaWindowList '' $true | Out-Null } catch { $rejected=$_.Exception.Message -like '*inventory_fixture_failure*' }
Assert-Test $rejected 'Incomplete inventory must not be accepted as a new-window baseline'
Write-Output 'PASS: incomplete inventory fails closed'
