$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'),[ref]$null,[ref]$null)
foreach($def in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $def.Extent.Text}
function Assert-OrcaProcessAllowed($Process) {}
function Get-OrcaWindowProcesses { [pscustomobject]@{Id=13;ProcessName='putty';MainWindowTitle='server12'} }
$rejected=$false
try { Find-OrcaProcess 'pid:12' | Out-Null } catch { $rejected=$_.Exception.Message -like 'appNotFound*' }
if(-not $rejected){throw 'Explicit absent PID must not fall back to title matching'}
Write-Output 'PASS: absent PID never falls back to titles'
$rejected=$false
try { Invoke-OrcaOperation ([pscustomobject]@{tool='scroll';app='13';expectedProcessInstance='instance';noScreenshot=$true}) | Out-Null } catch { $rejected=$_.Exception.Message -like '*pointer_not_authorized*' }
if(-not $rejected){throw 'Native pointer input must require explicit allowPointer'}
Write-Output 'PASS: native pointer opt-in'
function Find-OrcaProcess($Query) { [pscustomobject]@{Id=13;processInstance='replacement';MainWindowHandle=[IntPtr]130;MainWindowTitle='fixture'} }
function Select-OrcaWindowTarget($Process,$WindowId,$WindowIndex) { $Process }
$rejected=$false
try { Assert-OrcaDispatchTarget ([pscustomobject]@{Id=13;MainWindowHandle=[IntPtr]130}) ([pscustomobject]@{expectedProcessInstance='observed'}) } catch { $rejected=$_.Exception.Message -like '*process_instance_changed*' }
if(-not $rejected){throw 'Dispatch preflight must read current process incarnation after tree traversal'}
Write-Output 'PASS: dispatch rechecks live process incarnation'
