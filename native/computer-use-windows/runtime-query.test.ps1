$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw (Join-Path $PSScriptRoot 'runtime.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
foreach ($name in @('New-OrcaElementRecord', 'Get-OrcaProperty', 'Test-OrcaSensitiveElement', 'Get-OrcaValueText')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $definition.Extent.Text
}
function Get-OrcaRuntimeId($Element) { @(1, 2) }
function Test-OrcaElementSelected($Element) { $false }
function Get-OrcaElementFrame($Element, $WindowFrame) { $null }
function Get-OrcaActions($Element) { @() }
$element = [pscustomobject]@{ Current = [pscustomobject]@{
    IsPassword = $true; AutomationId = 'editor'; Name = 'Field'; LocalizedControlType = 'edit';
    ControlType = [pscustomobject]@{ ProgrammaticName = 'ControlType.Edit' }; NativeWindowHandle = 0; ClassName = 'Edit'
} }
$record = New-OrcaElementRecord $element 3 $null
if ($record.isSensitive -ne $true) { throw 'Query metadata must explicitly mark sensitive UIA controls, even when value is empty.' }
$element.Current.IsPassword = $false
$record = New-OrcaElementRecord $element 3 $null
if ($record.isSensitive -ne $false) { throw 'Ordinary UIA controls must have a false sensitive marker.' }
if ($record.controlType -ne 'ControlType.Edit' -or $record.automationId -ne 'editor') { throw 'Native query metadata changed.' }
Write-Output 'runtime-query: passed (isolated metadata fixture; no Windows UI)'
# Exercise the real value-reader with only the UIA pattern constant replaced.
Add-Type 'namespace Windows.Automation { public static class ValuePattern { public static readonly object Pattern = new object(); } }'
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OrcaValueText' }, $true)
Invoke-Expression $definition.Extent.Text
$TextLimit = 5
$element | Add-Member NoteProperty FixtureValue 'abcdef'
$element | Add-Member ScriptMethod GetCurrentPattern { param($pattern) [pscustomobject]@{ Current = [pscustomobject]@{ Value = $this.FixtureValue } } }
$metadata = Get-OrcaValueText $element -Metadata
if ($metadata.valueAvailable -ne $true -or $metadata.valueTruncated -ne $true -or $metadata.value -ne 'abcde...') { throw 'Value metadata must distinguish a truncated value.' }
$element.FixtureValue = ''
$metadata = Get-OrcaValueText $element -Metadata
if ($metadata.valueAvailable -ne $true -or $metadata.valueTruncated -ne $false) { throw 'Empty values must remain readable.' }
$element | Add-Member -Force ScriptMethod GetCurrentPattern { param($pattern) throw 'unsupported' }
$metadata = Get-OrcaValueText $element -Metadata
if ($metadata.valueAvailable -ne $false) { throw 'Unsupported ValuePattern must not appear as an empty value.' }
Write-Output 'runtime-query: value availability/truncation passed (isolated fixture)'
$msaaSource = Get-Content (Join-Path $PSScriptRoot 'msaa.cs') -Raw
$imports = '(?s)\[DllImport\("oleacc.dll"\)\]\s+private static extern int (AccessibleObjectFromWindow|AccessibleChildren)\(.*?;'
$msaaSource = [regex]::Replace($msaaSource, $imports, '').Replace('AccessibleObjectFromWindow(', 'MsaaFixtureNative.AccessibleObjectFromWindow(').Replace('AccessibleChildren(', 'MsaaFixtureNative.AccessibleChildren(')
Add-Type -TypeDefinition ($msaaSource + (Get-Content (Join-Path $PSScriptRoot 'msaa-fixture.cs') -Raw))
$root = [IdentifiedMsaaFixture]::new(); $root.ObjectId = 1; $root.Role = 42; $root.Name = 'Editor'; $root.Value = 'abcdef'
[MsaaFixtureNative]::Root = $root
function Read-QueryMsaa { ([OrcaMsaa]::Read([IntPtr]123, 0, 0, 100, 10, 5)).elements[0] }
$node = Read-QueryMsaa
if ($node.valueAvailable -ne $true -or $node.valueTruncated -ne $true) { throw 'MSAA must report a truncated readable value.' }
$root.Unsupported = 'value'
if ((Read-QueryMsaa).valueAvailable -ne $false) { throw 'Unsupported MSAA value must not appear as empty.' }
$root.Unsupported = ''; $root.Role = 10
if ((Read-QueryMsaa).valueAvailable -ne $false) { throw 'MSAA container values are not queried.' }
Write-Output 'runtime-query: MSAA value metadata passed (isolated fixture)'
$root.Role = 42; $root.Name = 'Password'
if ((Read-QueryMsaa).isSensitive -ne $true) { throw 'MSAA must explicitly mark sensitive controls.' }
$root.Name = '[redacted]'; $root.Value = '[redacted]'
if ((Read-QueryMsaa).isSensitive -ne $false) { throw 'MSAA must explicitly mark ordinary literal redaction text as nonsensitive.' }
Write-Output 'runtime-query: explicit MSAA sensitivity passed'

$script:sensitivityChecks = 0
$script:classifySensitive = (Get-Command Test-OrcaSensitiveElement).ScriptBlock
function Test-OrcaSensitiveElement($Element) {
    $script:sensitivityChecks++
    & $script:classifySensitive $Element
}
$element.Current.IsPassword = $true
$record = New-OrcaElementRecord $element 3 $null
if ($script:sensitivityChecks -ne 1 -or $record.isSensitive -ne $true) { throw 'Each UIA record must classify sensitivity once and retain the marker.' }
Write-Output 'runtime-query: one UIA sensitivity read per record passed'
