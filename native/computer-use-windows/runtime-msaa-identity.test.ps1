$ErrorActionPreference='Stop'
# Exercise the Windows-only fixture's real process stub without creating a form.
foreach ($file in @('runtime.ps1','runtime-msaa.test.ps1')) {
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$null,[ref]$null)
    foreach($definition in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {
        if (($file -eq 'runtime.ps1' -and $definition.Name -eq 'Get-OrcaProcessInstance') -or
            ($file -eq 'runtime-msaa.test.ps1' -and $definition.Name -eq 'Find-OrcaProcess')) {
            Invoke-Expression $definition.Extent.Text
        }
    }
}
$form=[pscustomobject]@{Handle=[IntPtr]123;Text='fixture'}
$fixture=Find-OrcaProcess ([string]$PID)
$expected=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')
if((Get-OrcaProcessInstance $fixture) -cne $expected){throw 'Native MSAA fixture must expose the real current process start identity'}
Write-Output 'PASS: native MSAA fixture carries the actual process start identity'
