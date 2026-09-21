$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'), [ref]$null, [ref]$null)
$names = @('Get-OrcaWindowId', 'Assert-OrcaWindowTarget', 'Select-OrcaWindowTarget', 'Assert-OrcaProcessAllowed')
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -in $names) { Invoke-Expression $definition.Extent.Text }
}
$BlockedAppFragments = @('password-manager')
$process = [pscustomobject]@{Id=42;ProcessName='fixture';MainWindowHandle=[IntPtr]111;MainWindowTitle='Main'}
$script:windows = @(
    [pscustomobject]@{id=222;title='Owned dialog';index=0},
    [pscustomobject]@{id=111;title='Main';index=1}
)
function Get-OrcaProcessWindows($Process) { @($script:windows) }
function Get-OrcaForegroundWindow { [IntPtr]222 }
# Existing MainWindowHandle-only validation incorrectly rejects the owned popup.
Assert-OrcaWindowTarget $process 222 $null
$selected = Select-OrcaWindowTarget $process 222 $null
if ($selected.MainWindowHandle -ne 222 -or $selected.MainWindowTitle -ne 'Owned dialog') { throw 'Explicit popup was not selected' }
if ((Select-OrcaWindowTarget $process $null 1).MainWindowHandle -ne 111) { throw 'Window index was ignored' }
if ((Select-OrcaWindowTarget $process $null $null).MainWindowHandle -ne 222) { throw 'Foreground owned popup was not preferred' }
foreach ($target in @(@(333,$null), @(222,1), @($null,-1), @($null,2))) {
    $rejected = $false
    try { Assert-OrcaWindowTarget $process $target[0] $target[1] } catch { $rejected = $_.Exception.Message -like 'windowNotFound*' }
    if (-not $rejected) { throw 'Foreign, mismatched, or invalid window target was accepted' }
}
$script:windows = @($script:windows | Where-Object id -eq 111)
$rejected = $false
try { Assert-OrcaWindowTarget $selected 222 $null } catch { $rejected = $_.Exception.Message -like 'windowNotFound*' }
if (-not $rejected) { throw 'Closed popup was accepted' }
Write-Output 'PASS: owned popup ID/index/default targeting, foreign IDs, and closed-popup rejection'
