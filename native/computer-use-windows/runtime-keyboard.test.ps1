$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'), [ref]$null, [ref]$null)
$names = @('ConvertTo-OrcaSendKeysText', 'ConvertTo-OrcaSendKeysKey', 'ConvertTo-OrcaSendKeysModifier', 'Get-OrcaVirtualKey')
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -in $names) { Invoke-Expression $definition.Extent.Text }
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', received '$Actual'" }
}
Assert-Equal (ConvertTo-OrcaSendKeysKey Enter) '{ENTER}'
Assert-Equal ((ConvertTo-OrcaSendKeysModifier Shift) + (ConvertTo-OrcaSendKeysKey F10)) '+{F10}'
foreach ($number in 1..16) {
    Assert-Equal (ConvertTo-OrcaSendKeysKey "f$number") "{F$number}"
    Assert-Equal (Get-OrcaVirtualKey "F$number") (0x6F + $number)
}
foreach ($invalid in @('F0', 'F17', 'F01', 'F10}', 'F10+Enter')) {
    foreach ($function in @('ConvertTo-OrcaSendKeysKey', 'Get-OrcaVirtualKey')) {
        $rejected = $false
        try { & $function $invalid | Out-Null } catch { $rejected = $_.Exception.Message -like 'Unsupported key:*' }
        if (-not $rejected) { throw "$function did not reject '$invalid'" }
    }
}
Write-Output 'PASS: F1-F16, Shift+F10, existing Enter, and malformed key rejection'
