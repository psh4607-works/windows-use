$ErrorActionPreference = 'Stop'
# Compile the real traversal/resolver/action code with only the two oleacc imports
# replaced by managed fixtures. This runs without Windows; it does not test COM marshalling.
$source = Get-Content (Join-Path $PSScriptRoot 'msaa.cs') -Raw
$imports = '(?s)\[DllImport\("oleacc.dll"\)\]\s+private static extern int (AccessibleObjectFromWindow|AccessibleChildren)\(.*?;'
if ([regex]::Matches($source, $imports).Count -ne 2) { throw 'Unexpected MSAA interop declarations' }
$source = [regex]::Replace($source, $imports, '')
$source = $source.Replace('AccessibleObjectFromWindow(', 'MsaaFixtureNative.AccessibleObjectFromWindow(').Replace('AccessibleChildren(', 'MsaaFixtureNative.AccessibleChildren(')
Add-Type -TypeDefinition ($source + (Get-Content (Join-Path $PSScriptRoot 'msaa-fixture.cs') -Raw))

function Read-Fixture($Root) {
    [MsaaFixtureNative]::Root = $Root
    [OrcaMsaa]::Read([IntPtr]123, 0, 0, 100, 10, 100)
}
function Assert-Test($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$root = [IdentifiedMsaaFixture]::new(); $root.ObjectId = 1; $root.Role = 10
$button = [IdentifiedMsaaFixture]::new(); $button.ObjectId = 2
$root.Children = @($button); $root.Unsupported = 'defaultAction'
$tree = Read-Fixture $root
Assert-Test ($tree.elements.Count -eq 2) 'Unsupported default action on root dropped its accessible child'
Assert-Test ($tree.elements[0].actions -notcontains 'Invoke') 'Unsupported default action was advertised'
$target = [OrcaMsaa]::Resolve($tree, $tree.elements[1].runtimeId, 'Delete', 'MSAA.43')
[OrcaMsaa]::Act($target, 'invoke', $null)
Assert-Test ($button.Invocations -eq 1) 'Accessible child could not be invoked'
Write-Output 'PASS: unsupported default action preserves the container and actionable subtree'

foreach ($property in @('name', 'value', 'location')) {
    $root.Unsupported = $property
    $root.Role = if ($property -eq 'value') { 42 } else { 10 }
    $tree = Read-Fixture $root
    Assert-Test ($tree.elements.Count -eq 2) "Unsupported $property dropped its accessible child"
    Assert-Test ($tree.errors -eq 0) "Unsupported $property was reported as an inaccessible node"
}
$root.Unsupported = 'defaultAction'; $root.Error = -2147467263 # E_NOTIMPL
Assert-Test ((Read-Fixture $root).elements.Count -eq 2) 'E_NOTIMPL default action dropped the subtree'
$root.Error = -2147417848 # RPC_E_DISCONNECTED
Assert-Test ((Read-Fixture $root).errors -eq 1) 'Disconnected provider was silently treated as optional metadata'
Write-Output 'PASS: optional name/value/location and E_NOTIMPL preserve traversal; disconnection is reported'

function Assert-Stale($Tree, $Observed) {
    $rejected = $false
    try { $null = [OrcaMsaa]::Resolve($Tree, $Observed.runtimeId, $Observed.name, $Observed.controlType) }
    catch { $rejected = $_.Exception.Message -like '*stale MSAA element*' }
    Assert-Test $rejected 'A stale or unidentifiable MSAA element was accepted'
}

$root = [IdentifiedMsaaFixture]::new(); $root.ObjectId = 10; $root.Role = 10
$root.Children = @(17, 93) # MSAA child IDs are not sibling ordinals.
$observed = (Read-Fixture $root).elements[1]
$root.Children = @(93)
Assert-Stale (Read-Fixture $root) $observed
Assert-Test ($root.Invocations -eq 0) 'Replacement received input'
$root.Children = @(93, 17)
$tree = Read-Fixture $root
$target = [OrcaMsaa]::Resolve($tree, $observed.runtimeId, $observed.name, $observed.controlType)
[OrcaMsaa]::Act($target, 'invoke', $null)
Assert-Test ($root.LastChild -eq 17) 'Reordered siblings redirected input to a different native child'
Write-Output 'PASS: native child IDs survive reorder and reject removal with identical names/roles'

$first = [IdentifiedMsaaFixture]::new(); $first.ObjectId = 21
$second = [IdentifiedMsaaFixture]::new(); $second.ObjectId = 22
$root.Children = @($first, $second)
$observed = (Read-Fixture $root).elements[1]
$root.Children = @($second)
Assert-Stale (Read-Fixture $root) $observed
$root.Children = @($second, $first)
$tree = Read-Fixture $root
$target = [OrcaMsaa]::Resolve($tree, $observed.runtimeId, $observed.name, $observed.controlType)
[OrcaMsaa]::Act($target, 'invoke', $null)
Assert-Test ($first.Invocations -eq 1 -and $second.Invocations -eq 0) 'Reordered COM objects redirected input'
# A new wrapper for the same native object must still resolve after serialization.
$replacementWrapper = [IdentifiedMsaaFixture]::new(); $replacementWrapper.ObjectId = 21
$root.Children = @($replacementWrapper)
$saved = $observed | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$target = [OrcaMsaa]::Resolve((Read-Fixture $root), [int[]]$saved.runtimeId, $saved.name, $saved.controlType)
[OrcaMsaa]::Act($target, 'invoke', $null)
Assert-Test ($replacementWrapper.Invocations -eq 1) 'Native identity was tied to a wrapper instance'
$root.Children = @($first, $replacementWrapper)
Assert-Stale (Read-Fixture $root) $observed
$root.Children = @($first)
$first.Name = 'Changed control'
Assert-Stale (Read-Fixture $root) $observed
$first.Name = 'Delete'; $first.Role = 42
Assert-Stale (Read-Fixture $root) $observed
Write-Output 'PASS: object identity survives rewrapping/serialization and rejects removed, changed, or ambiguous targets'

foreach ($unidentified in @([MsaaFixture]::new(), [IdentifiedMsaaFixture]::new())) {
    if ($unidentified -is [IdentifiedMsaaFixture]) { $unidentified.IdentityUnavailable = $true }
    $unidentified.Children = @($button)
    $tree = Read-Fixture $unidentified
    Assert-Test ($tree.elements.Count -eq 2) 'Missing identity hid accessible descendants'
    Assert-Test ($null -eq $tree.elements[0].runtimeId -and $tree.elements[0].actions.Count -eq 0) 'Unidentified control advertised actionable identity'
    Assert-Stale $tree $tree.elements[0]
    $rejected = $false
    try { [OrcaMsaa]::Act($tree.elements[0], 'invoke', $null) }
    catch { $rejected = $_.Exception.Message -like '*native identity unavailable*' }
    Assert-Test ($rejected -and $unidentified.Invocations -eq 0) 'Unidentified control received input'
}
$root.Children = @($button)
Assert-Stale (Read-Fixture $root) ([pscustomobject]@{runtimeId=@(-33,123,0,0);name='Delete';controlType='MSAA.43'})
Write-Output 'PASS: unavailable identities remain visible but non-actionable; legacy ordinal IDs are rejected'

$secret = [IdentifiedMsaaFixture]::new(); $secret.ObjectId = 30; $secret.Role = 42
$secret.State = 0x20000000; $secret.Unsupported = 'name'; $secret.Error = -2147417848
$tree = Read-Fixture $secret
Assert-Test ($tree.elements[0].name -eq '[redacted]' -and $tree.elements[0].value -eq '[redacted]') 'Protected name/value queried or exposed'
$secret.State = 1; $secret.Unsupported = $null
$tree = Read-Fixture $secret
$rejected = $false
try { [OrcaMsaa]::Act($tree.elements[0], 'setValue', 'test') }
catch { $rejected = $_.Exception.Message -like '*hidden or disabled*' }
Assert-Test ($rejected -and $secret.Value -eq '') 'Disabled control received input'
Write-Output 'PASS: protected metadata stays redacted and disabled controls reject input'

# Compare the real UIA classifier with MSAA, including normalization and PIN boundaries.
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'runtime.ps1'), [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -in @('Get-OrcaProperty', 'Test-OrcaSensitiveElement')) { Invoke-Expression $definition.Extent.Text }
}
foreach ($label in @('Verification code', 'PASSWORD', 'Passcode', 'client_secret', "One-Time`n  Code", "verification`tcode", 'PIN', 'Enter PIN:', (('x' * 120) + ' verification code'))) {
    $uia = [pscustomobject]@{Current=[pscustomobject]@{IsPassword=$false;Name=$label;LocalizedControlType='edit';ControlType=[pscustomobject]@{ProgrammaticName='ControlType.Edit'};AutomationId='';ClassName=''}}
    Assert-Test (Test-OrcaSensitiveElement $uia) 'Fixture does not exercise the existing UIA sensitivity rule'
    $field = [IdentifiedMsaaFixture]::new(); $field.ObjectId = 40; $field.Role = 42
    $field.Name = $label; $field.Value = 'fixture-sensitive-value-must-not-be-read'
    $tree = Read-Fixture $field
    Assert-Test ($field.ValueReads -eq 0) "MSAA queried a sensitive value for '$label' without STATE_SYSTEM_PROTECTED"
    Assert-Test ($tree.elements[0].value -eq '[redacted]') 'MSAA did not redact a field classified as sensitive by UIA'
    Assert-Test (($tree | ConvertTo-Json -Depth 10) -notmatch 'fixture-sensitive-value-must-not-be-read') 'Sensitive value leaked into serialized snapshot/session data'
}
foreach ($label in @('Shipping address', 'pinned item', 'pinCode', 'spin', 'Account name')) {
    $field = [IdentifiedMsaaFixture]::new(); $field.ObjectId = 41; $field.Role = 42
    $field.Name = $label; $field.Value = 'public value'
    $tree = Read-Fixture $field
    Assert-Test ($field.ValueReads -eq 1 -and $tree.elements[0].value -eq 'public value') "Ordinary field '$label' was unnecessarily redacted"
}
Write-Output 'PASS: UIA/MSAA sensitive-name parity, no secret value reads or serialization, and ordinary edit values'

foreach ($property in @('Description', 'Help')) {
    $field = [IdentifiedMsaaFixture]::new(); $field.ObjectId = 42; $field.Role = 42
    $field.Name = 'Input'; $field.$property = "Enter your verification`ncode"
    $tree = Read-Fixture $field
    Assert-Test ($field.ValueReads -eq 0 -and $tree.elements[0].value -eq '[redacted]') "MSAA ignored sensitive $property metadata"
}
foreach ($property in @('description', 'help')) {
    $field = [IdentifiedMsaaFixture]::new(); $field.ObjectId = 43; $field.Role = 42
    $field.Name = 'Account name'; $field.Value = 'public value'; $field.Unsupported = $property
    $field.Children = @($button)
    $tree = Read-Fixture $field
    Assert-Test ($tree.elements.Count -eq 2 -and $tree.elements[0].value -eq 'public value') "Unsupported $property broke traversal/value reading"
}
Write-Output 'PASS: sensitive description/help prevents value reads; unsupported optional metadata preserves traversal'

$root = [IdentifiedMsaaFixture]::new(); $root.ObjectId = 50; $root.Role = 10
$custom = [IdentifiedMsaaFixture]::new(); $custom.ObjectId = 51; $custom.Role = 'CustomWidget'
$nested = [IdentifiedMsaaFixture]::new(); $nested.ObjectId = 52
$following = [IdentifiedMsaaFixture]::new(); $following.ObjectId = 53
$custom.Children = @($nested); $root.Children = @($custom, $following)
$tree = Read-Fixture $root
Assert-Test ($tree.elements.Count -eq 4 -and $tree.errors -eq 0) 'Custom role aborted child/sibling traversal'
Assert-Test ($tree.elements[1].localizedControlType -eq 'CustomWidget') 'Custom role label was lost'
Assert-Test ($custom.ValueReads -eq 0 -and $tree.elements[1].actions -notcontains 'SetValue') 'Custom role was treated as an edit control'
foreach ($node in $tree.elements[1..3]) {
    $target = [OrcaMsaa]::Resolve($tree, $node.runtimeId, $node.name, $node.controlType)
    [OrcaMsaa]::Act($target, 'invoke', $null)
}
Assert-Test ($custom.Invocations -eq 1 -and $nested.Invocations -eq 1 -and $following.Invocations -eq 1) 'Custom role prevented MSAA actions'
$observed = $tree.elements[1]
$custom.Role = 'OtherWidget'
Assert-Stale (Read-Fixture $root) $observed
# A string containing a number is a custom role, not a system-role constant.
$custom.Role = '42'
$tree = Read-Fixture $custom
Assert-Test ($custom.ValueReads -eq 0 -and $tree.elements[0].actions -notcontains 'SetValue') 'Numeric string role was coerced to ROLE_SYSTEM_TEXT'
$observed = $tree.elements[0]; $custom.Role = 42
Assert-Stale (Read-Fixture $custom) $observed
Write-Output 'PASS: custom string roles preserve traversal/actions and remain distinct from integer roles'

$field = [IdentifiedMsaaFixture]::new(); $field.ObjectId = 70; $field.Role = 42; $field.Name = 'Password'
Assert-Test ((Read-Fixture $field).elements[0].isSensitive -eq $true) 'MSAA sensitivity metadata missing from observation'
$field.Name = 'Account name'; $field.Value = '[redacted]'
Assert-Test ((Read-Fixture $field).elements[0].isSensitive -eq $false) 'Literal display value was mistaken for sensitivity metadata'
# Exercise the real UIA record builder with only OS-dependent accessors stubbed.
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -eq 'New-OrcaElementRecord') { Invoke-Expression $definition.Extent.Text }
}
function Get-OrcaRuntimeId($Element) { @(42, 88) }
function Get-OrcaValueText($Element) { if (Test-OrcaSensitiveElement $Element) { '[redacted]' } else { 'public' } }
function Test-OrcaElementSelected($Element) { $false }
function Get-OrcaElementFrame($Element, $WindowFrame) { $null }
function Get-OrcaActions($Element) { @('SetValue') }
$uia.Current.Name = 'Password'
Assert-Test ((New-OrcaElementRecord $uia 2 $null).isSensitive -eq $true) 'UIA sensitivity metadata missing from observation'
$uia.Current.Name = 'Account name'
Assert-Test ((New-OrcaElementRecord $uia 2 $null).isSensitive -eq $false) 'UIA ordinary record marked sensitive'
Write-Output 'PASS: UIA/MSAA serialized records carry explicit sensitivity metadata'

# Real record/value functions must share one classification (including its decision).
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -eq 'Get-OrcaValueText') { Invoke-Expression $definition.Extent.Text }
}
$script:sensitivityReads = 0
$script:classifyElement = ${function:Test-OrcaSensitiveElement}
function Test-OrcaSensitiveElement($Element) { $script:sensitivityReads++; & $script:classifyElement $Element }
$uia.Current.Name = 'Password'
$record = New-OrcaElementRecord $uia 2 $null
Assert-Test ($script:sensitivityReads -eq 1) 'UIA record/value read classified the same element more than once'
Assert-Test ($record.isSensitive -and $record.value -eq '[redacted]') 'Precomputed classification failed to protect the value'
$script:sensitivityReads = 0
$null = Get-OrcaValueText $uia
Assert-Test ($script:sensitivityReads -eq 1) 'Standalone value reads must still classify when no flag is supplied'
Write-Output 'PASS: UIA record/value share one classification; standalone callers remain protected'
$treeItem = [IdentifiedMsaaFixture]::new(); $treeItem.ObjectId=80; $treeItem.Role=36; $treeItem.State=0x100400
$node=(Read-Fixture $treeItem).elements[0]
Assert-Test ($node.actions -contains 'Focus') 'MSAA focusable nodes must advertise Focus'
Assert-Test ($node.expansionState -eq 'collapsed') 'MSAA must expose collapsed state'
[OrcaMsaa]::Act($node,'focus',$null)
Assert-Test ($treeItem.LastChild -eq 0) 'MSAA Focus must call accSelect on the target child'
$treeItem.State=0x100401
$node=(Read-Fixture $treeItem).elements[0]
Assert-Test ($node.actionabilityReason -eq 'disabled' -and $node.actions.Count -eq 0) 'MSAA disabled nodes must explain unavailable actions'
Write-Output 'PASS: MSAA focus and actionability state'
$treeItem.State=0x100004
$node=(Read-Fixture $treeItem).elements[0]
$treeItem.State=0x100000
Assert-Test (-not [OrcaMsaa]::IsFocused($node)) 'MSAA keyboard guard must read live focus after traversal'
Write-Output 'PASS: live MSAA focus state'
