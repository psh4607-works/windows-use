$ErrorActionPreference = 'Stop'
# Real traversal and snapshot code with managed UIA/oleacc boundaries. This is
# deterministic error injection, not proof of Windows COM integration.
function Assert-Test($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-ObservationError($Tree, [string]$Code, [int]$Count = 1) {
    $errors = @($Tree.observationErrors)
    Assert-Test ($errors.Count -eq 1 -and $errors[0].code -eq $Code -and $errors[0].count -eq $Count) "Missing structured $Code count=$Count"
    $serialized = ConvertTo-Json -InputObject $errors -Depth 5 -Compress
    Assert-Test ($serialized -notmatch 'fixture-sensitive|provider failure') 'Observation errors exposed provider text'
    Assert-Test ((@($errors[0].PSObject.Properties.Name | Sort-Object) -join ',') -eq 'code,count') 'Observation errors must contain only code and count'
}

$msaaSource = Get-Content (Join-Path $PSScriptRoot 'msaa.cs') -Raw
$imports = '(?s)\[DllImport\("oleacc.dll"\)\]\s+private static extern int (AccessibleObjectFromWindow|AccessibleChildren)\(.*?;'
$msaaSource = [regex]::Replace($msaaSource, $imports, '').Replace('AccessibleObjectFromWindow(', 'MsaaFixtureNative.AccessibleObjectFromWindow(').Replace('AccessibleChildren(', 'MsaaFixtureNative.AccessibleChildren(')
Add-Type -TypeDefinition ($msaaSource + (Get-Content (Join-Path $PSScriptRoot 'msaa-fixture.cs') -Raw))
function Read-Msaa($Root, [int]$Nodes = 100, [int]$Depth = 10) {
    [MsaaFixtureNative]::Root = $Root
    [OrcaMsaa]::Read([IntPtr]123, 0, 0, $Nodes, $Depth, 100)
}
$root = [IdentifiedMsaaFixture]::new(); $root.ObjectId = 1; $root.Role = 10; $root.Name = 'Root'
$broken = [IdentifiedMsaaFixture]::new(); $broken.ObjectId = 2; $broken.Name = 'Save'
$healthy = [IdentifiedMsaaFixture]::new(); $healthy.ObjectId = 3; $healthy.Name = 'Save'
$root.Children = @($broken, $healthy)
$broken.Unsupported = 'state'; $broken.Error = -2147417848; $broken.ErrorMessage = 'fixture-sensitive-provider failure'
$tree = Read-Msaa $root
Assert-Test ($tree.elements.Count -eq 2 -and $tree.errors -eq 1) 'An inaccessible MSAA node must preserve its healthy sibling'
Assert-ObservationError $tree 'msaa_node_unavailable'
$broken.Unsupported = ''
Assert-Test ((Read-Msaa $root).observationErrors.Count -eq 0) 'A complete MSAA tree must have no observation errors'

foreach ($failure in @('child-count', 'enumeration', 'short-read', 'null-child', 'invalid-child')) {
    $root.Unsupported = ''; $root.ChildrenError = 0; $root.ReturnedChildren = -1; $root.Children = @($broken, $healthy)
    switch ($failure) {
        'child-count' { $root.Unsupported = 'children'; $root.Error = -2147417848 }
        'enumeration' { $root.ChildrenError = -2147417848 }
        'short-read' { $root.ReturnedChildren = 1 }
        'null-child' { $root.Children = @($null, $healthy) }
        'invalid-child' { $root.Children = @('fixture-sensitive-invalid-child', $healthy) }
    }
    $tree = Read-Msaa $root
    $code = if ($failure -in @('null-child', 'invalid-child')) { 'msaa_node_unavailable' } else { 'msaa_children_unavailable' }
    Assert-ObservationError $tree $code
    Assert-Test ($tree.elements.Count -ge 1) "MSAA $failure must retain the root record"
}
$root.Unsupported = ''; $root.Children = @($broken, $healthy)
foreach ($property in @('name', 'value', 'description', 'help', 'defaultAction', 'location')) {
    $root.Role = 42; $root.Unsupported = $property; $root.Error = -2147467263
    $tree = Read-Msaa $root
    Assert-Test ($tree.observationErrors.Count -eq 0 -and $tree.elements.Count -eq 3) "Unsupported MSAA $property must preserve completeness"
}
# Windows COM interop maps E_NOTIMPL from an out-of-process provider to this
# managed exception, rather than necessarily leaving it as COMException.
$root.MapNotImplemented = $true
foreach ($property in @('name', 'value', 'description', 'help', 'defaultAction', 'location')) {
    $root.Unsupported = $property
    $readFailed = $false
    try { $tree = Read-Msaa $root } catch { $readFailed = $true }
    Assert-Test (-not $readFailed) "Mapped E_NOTIMPL for optional MSAA $property must not fail the observation"
    Assert-Test ($tree.observationErrors.Count -eq 0 -and $tree.elements.Count -eq 3) "Mapped E_NOTIMPL for optional MSAA $property must preserve completeness"
}
$root.MapNotImplemented = $false
$root.Unsupported = ''; $root.Role = 10; $root.IdentityUnavailable = $true
Assert-Test ((Read-Msaa $root).observationErrors.Count -eq 0) 'Missing optional identity must not mark a visible MSAA node as omitted'
$tree = Read-Msaa $root 1
Assert-Test ($tree.truncated -and $tree.observationErrors.Count -eq 0) 'Node limits must remain separate from MSAA access failures'
$tree = Read-Msaa $root 100 0
Assert-Test ($tree.maxDepthReached -and $tree.observationErrors.Count -eq 0) 'Depth limits must remain separate from MSAA access failures'
Write-Output 'PASS: MSAA node/subtree omissions, short reads, optional properties, limits, and sanitized metadata'

Add-Type -TypeDefinition @'
namespace Windows.Automation {
    public enum TreeScope { Children }
    public static class Condition { public static readonly object TrueCondition = new object(); }
    public static class ValuePattern { public static readonly object Pattern = new object(); }
    public static class SelectionItemPattern { public static readonly object Pattern = new object(); }
}
'@
$source = Get-Content (Join-Path $PSScriptRoot 'runtime.ps1') -Raw
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -in @('Get-OrcaProperty', 'Get-OrcaRuntimeId', 'Test-OrcaSensitiveElement', 'Get-OrcaValueText', 'Get-OrcaActions', 'Get-OrcaMeaningfulActions', 'Format-OrcaSnapshotText', 'Format-OrcaValueSegment', 'Test-OrcaSuppressChildren', 'Get-OrcaTextSnippets', 'Test-OrcaPlainTextSubtree', 'New-OrcaElementRecord', 'Test-OrcaElementSelected', 'Get-OrcaElementFrame', 'Render-OrcaTree', 'Get-OrcaMsaaTree', 'New-OrcaSnapshot')) {
        Invoke-Expression $definition.Extent.Text
    }
}
$MaxNodes = 100; $MaxDepth = 10; $TextLimit = 100
function New-Uia([int]$Id, [string]$Name = 'Save', [string]$Role = 'document', [object[]]$Children = @()) {
    $element = [pscustomobject]@{
        Id = $Id; FailChildren = $false; FailNode = $false; Children = $Children
        Current = [pscustomobject]@{ Name = $Name; AutomationId = ''; LocalizedControlType = $Role; ControlType = [pscustomobject]@{ ProgrammaticName = "ControlType.$Role" }; IsPassword = $false; NativeWindowHandle = 0; ClassName = 'Fixture' }
    }
    $element | Add-Member ScriptMethod GetRuntimeId { @($this.Id) }
    $element | Add-Member ScriptMethod GetSupportedPatterns { if ($this.FailNode) { throw 'fixture-sensitive-node failure' }; @() }
    $element | Add-Member ScriptMethod GetCurrentPattern { param($pattern) throw [System.NotSupportedException]::new('fixture-sensitive-optional property') }
    $element | Add-Member ScriptMethod FindAll { param($scope, $condition) if ($this.FailChildren) { throw 'fixture-sensitive-children failure' }; $this.Children }
    $element
}
$leaf = New-Uia 2
$rootUia = New-Uia 1 'Root' 'document' @($leaf)
$tree = Render-OrcaTree $rootUia $null
Assert-Test ($tree.elements.Count -eq 2 -and $tree.observationErrors.Count -eq 0) 'Unsupported UIA patterns must preserve complete traversal'
$leaf.FailChildren = $true
$tree = Render-OrcaTree $rootUia $null
Assert-Test ($tree.elements.Count -eq 2) 'UIA FindAll failure must preserve readable records'
Assert-ObservationError $tree 'uia_children_unavailable'
$leaf.FailChildren = $false; $leaf.FailNode = $true
$tree = Render-OrcaTree $rootUia $null
Assert-Test ($tree.elements.Count -eq 1) 'A failed UIA record must be omitted without losing its parent'
Assert-ObservationError $tree 'uia_node_unavailable'
$leaf.FailNode = $false
$tree = Render-OrcaTree (New-Uia 3 'Continue' 'button') $null
Assert-Test ($tree.observationErrors.Count -eq 0) 'Normal UIA leaf controls must remain complete'
$button = New-Uia 3 'Continue' 'button'; $button.FailChildren = $true
Assert-Test ((Render-OrcaTree $button $null).observationErrors.Count -eq 0) 'Intentional compact leaf suppression must not create a subtree omission'

# A failed summary probe must not make the renderer hide a partially read subtree.
$alpha = New-Uia 4 'Alpha' 'text'; $beta = New-Uia 5 'Beta' 'text'; $beta.FailChildren = $true
$anonymous = New-Uia 6 '' 'group' @($alpha, $beta)
$tree = Render-OrcaTree $anonymous $null
Assert-Test ($tree.elements.Count -eq 3) 'A failed plain-text probe must not collapse an incomplete subtree'
Assert-ObservationError $tree 'uia_children_unavailable'
Write-Output 'PASS: UIA omissions, optional patterns, compact summaries, and sanitized metadata'

# Exercise the actual native snapshot wrapper without selecting or modifying a desktop.
function Find-OrcaProcess($Query) { [pscustomobject]@{ MainWindowHandle = 123; MainWindowTitle = 'Fixture'; WindowIndex = 0 } }
function Select-OrcaWindowTarget($Process, $WindowId, $WindowIndex) { $Process }
function Assert-OrcaWindowTarget($Process, $WindowId, $Other) {}
function Get-OrcaWindowId($Process) { 123 }
function Get-OrcaRootElement($Process) { $rootUia }
function Get-OrcaWindowFrame($Process, $Root) { [pscustomobject]@{ x = 0; y = 0; width = 100; height = 100 } }
function Get-OrcaScreenshot($IncludeScreenshot, $WindowFrame) { $null }
function New-OrcaAppRecord($Process) { [pscustomobject]@{ pid = 123 } }
function Test-OrcaBrowserProcess($Process) { $false }
$leaf.FailChildren = $true
Assert-ObservationError (New-OrcaSnapshot 'Fixture' $false) 'uia_children_unavailable'
$root.Unsupported = 'children'; $root.Error = -2147417848
[MsaaFixtureNative]::Root = $root
Assert-ObservationError (New-OrcaSnapshot 'Fixture' $false $null $null $false 'msaa') 'msaa_children_unavailable'
Write-Output 'PASS: native UIA/MSAA snapshot wrappers preserve structured observation errors'
