# Owned interactive fixture for real cross-process MSAA/oleacc failure tests.
# The accessibility provider deliberately returns failing HRESULTs; production
# provider code and oleacc imports remain unchanged. This is fault injection,
# not evidence that an ordinary application naturally produced these failures.
param(
    [Parameter(Mandatory=$true)][string]$Title,
    [Parameter(Mandatory=$true)][string]$ModeFile,
    [Parameter(Mandatory=$true)][string]$EvidencePath,
    [ValidateRange(30,1800)][int]$LifetimeSeconds = 600
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or
    ![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) {
    throw 'Run the fixture in an interactive Windows desktop session.'
}
if ([string]::IsNullOrWhiteSpace($Title)) { throw 'A unique fixture title is required.' }
if (Test-Path -LiteralPath $EvidencePath) { throw 'EvidencePath must be a new file.' }
foreach ($path in @($ModeFile, $EvidencePath)) {
    if (!(Test-Path -LiteralPath (Split-Path -Parent $path) -PathType Container)) {
        throw 'Fixture control and evidence directories must already exist.'
    }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies @(
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Drawing.Rectangle].Assembly.Location,
    [Accessibility.IAccessible].Assembly.Location
) -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class CompletenessFixtureForm : Form {
    public string Mode = "normal";
    public int NodeFailures, ChildrenFailures, OptionalFailures, LastFailureHResult;
    private readonly Button ready, firstSave, secondSave;
    private readonly Panel faultRegion;

    public CompletenessFixtureForm(string title) {
        Text = title;
        ClientSize = new Size(430, 205);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(80, 80);
        ShowInTaskbar = true;
        ready = new Button { Text = "Ready", Location = new Point(15, 15), Size = new Size(180, 35) };
        firstSave = new Button { Text = "Save", Location = new Point(15, 60), Size = new Size(180, 35) };
        faultRegion = new Panel { AccessibleName = "Fault region", Location = new Point(15, 105), Size = new Size(390, 70), BorderStyle = BorderStyle.FixedSingle };
        secondSave = new Button { Text = "Save", Location = new Point(10, 15), Size = new Size(180, 35) };
        faultRegion.Controls.Add(secondSave);
        Controls.Add(ready);
        Controls.Add(firstSave);
        Controls.Add(faultRegion);
    }

    protected override AccessibleObject CreateAccessibilityInstance() {
        var root = new CompletenessFixtureAccessible(this, this, null, Text, AccessibleRole.Client, false);
        var region = new CompletenessFixtureAccessible(this, faultRegion, root, "Fault region", AccessibleRole.Grouping, true);
        region.Children = new AccessibleObject[] {
            new CompletenessFixtureAccessible(this, secondSave, region, "Save", AccessibleRole.PushButton, false)
        };
        root.Children = new AccessibleObject[] {
            new CompletenessFixtureAccessible(this, ready, root, "Ready", AccessibleRole.PushButton, false),
            new CompletenessFixtureAccessible(this, firstSave, root, "Save", AccessibleRole.PushButton, false),
            region
        };
        return root;
    }
}

[ComVisible(true)]
public sealed class CompletenessFixtureAccessible : Control.ControlAccessibleObject {
    private readonly CompletenessFixtureForm form;
    private readonly AccessibleObject parent;
    private readonly string label;
    private readonly AccessibleRole role;
    private readonly bool faultRegion;
    public AccessibleObject[] Children = new AccessibleObject[0];

    public CompletenessFixtureAccessible(CompletenessFixtureForm form, Control control,
        AccessibleObject parent, string label, AccessibleRole role, bool faultRegion) : base(control) {
        this.form = form; this.parent = parent; this.label = label;
        this.role = role; this.faultRegion = faultRegion;
    }

    public override string Name { get { return label; } set { } }
    public override AccessibleRole Role { get { return role; } }
    public override AccessibleObject Parent { get { return parent ?? base.Parent; } }
    public override Rectangle Bounds { get { return Owner.RectangleToScreen(Owner.ClientRectangle); } }
    public override string Description { get { return "Owned accessibility completeness fixture"; } }
    public override string Help { get { return ""; } }
    public override string Value { get { return ""; } set { } }
    private int FailureHResult() {
        // The provider returns HRESULTs across the real COM boundary. The
        // caller's interop layer chooses the corresponding managed exception.
        if (form.Mode.EndsWith("-notimpl")) return unchecked((int)0x80004001);
        if (form.Mode.EndsWith("-invalidarg")) return unchecked((int)0x80070057);
        if (form.Mode.EndsWith("-invalidcast")) return unchecked((int)0x80004002);
        return unchecked((int)0x80010108);
    }
    public override string DefaultAction {
        get {
            if (faultRegion && form.Mode == "optional") {
                form.OptionalFailures++;
                form.LastFailureHResult = unchecked((int)0x80004001);
                throw new COMException("Fixture optional metadata is unsupported", form.LastFailureHResult);
            }
            return "";
        }
    }
    public override AccessibleStates State {
        get {
            if (faultRegion && (form.Mode == "node" || form.Mode.StartsWith("node-"))) {
                form.NodeFailures++;
                form.LastFailureHResult = FailureHResult();
                throw new COMException("Fixture node is unavailable", form.LastFailureHResult);
            }
            return AccessibleStates.None;
        }
    }
    public override int GetChildCount() {
        if (faultRegion && (form.Mode == "children" || form.Mode.StartsWith("children-"))) {
            form.ChildrenFailures++;
            form.LastFailureHResult = FailureHResult();
            throw new COMException("Fixture subtree is unavailable", form.LastFailureHResult);
        }
        return Children.Length;
    }
    public override AccessibleObject GetChild(int index) {
        return index >= 0 && index < Children.Length ? Children[index] : null;
    }
}
'@

$utf8 = [Text.UTF8Encoding]::new($false)
if (!(Test-Path -LiteralPath $ModeFile)) { [IO.File]::WriteAllText($ModeFile, 'normal', $utf8) }
$form = [CompletenessFixtureForm]::new($Title)
$started = [DateTime]::UtcNow
$script:fixtureClosed = $false
$script:fixtureError = $null
function Save-FixtureEvidence {
    $state = [ordered]@{
        fixture = 'windows-completeness'; pid = $PID
        sessionId = (Get-Process -Id $PID).SessionId
        windowId = if ($form.IsHandleCreated) { $form.Handle.ToInt64() } else { 0 }
        title = $Title; mode = $form.Mode; closed = $script:fixtureClosed
        nodeFailures = $form.NodeFailures; childrenFailures = $form.ChildrenFailures
        optionalFailures = $form.OptionalFailures
        lastFailureHResult = $form.LastFailureHResult
        error = $script:fixtureError
        updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText($EvidencePath, ($state | ConvertTo-Json -Compress), $utf8)
}
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
    try {
        if (([DateTime]::UtcNow - $started).TotalSeconds -ge $LifetimeSeconds) {
            $form.Close()
            return
        }
        # A caller may be replacing the mode file during this timer tick.
        # Retry a transient sharing violation or empty write on the next tick.
        try { $requested = [IO.File]::ReadAllText($ModeFile).Trim().ToLowerInvariant() }
        catch [IO.IOException] { return }
        if ($requested -eq '') { return }
        if ($requested -notin @('normal', 'node', 'children', 'optional', 'stop',
            'node-notimpl', 'node-invalidarg', 'node-invalidcast',
            'children-notimpl', 'children-invalidarg', 'children-invalidcast')) { throw 'Unknown fixture mode.' }
        if ($requested -eq 'stop') {
            $form.Close()
            return
        }
        $form.Mode = $requested
        Save-FixtureEvidence
    } catch {
        $script:fixtureError = 'fixture_control_failed'
        $form.Close()
    }
})
$form.Add_Shown({ Save-FixtureEvidence; $timer.Start() })
$form.Add_FormClosed({ $script:fixtureClosed = $true })
try { [System.Windows.Forms.Application]::Run($form) }
finally {
    $timer.Stop()
    Save-FixtureEvidence
    $timer.Dispose()
    $form.Dispose()
}
if ($script:fixtureError) { throw $script:fixtureError }
