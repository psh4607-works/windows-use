# Disposable live smoke fixture. Run only in a logged-in Windows desktop session.
# Its test state contains generated text only; the window closes after ten minutes.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
$root=Join-Path $env:USERPROFILE '.windows-use/staging-smoke-20260906'
New-Item -ItemType Directory -Force -Path $root|Out-Null
$statePath=Join-Path $root 'ui-state.json'
$utf8=[Text.UTF8Encoding]::new($false)
$window=[Windows.Window]::new()
$window.Title='windows-use Smoke 20260906'
$window.Width=580;$window.Height=280
$window.WindowStartupLocation='CenterScreen'
$panel=[Windows.Controls.StackPanel]::new()
$panel.Margin=[Windows.Thickness]::new(20)
$textBox=[Windows.Controls.TextBox]::new()
$textBox.Name='SmokeInput'
[Windows.Automation.AutomationProperties]::SetName($textBox,'Smoke input')
$textBox.Height=60;$textBox.AcceptsReturn=$true;$textBox.Text='initial'
$button=[Windows.Controls.Button]::new()
$button.Name='SmokeApply';$button.Content='Apply smoke value';$button.Height=35
$label=[Windows.Controls.TextBlock]::new()
$label.Name='SmokeResult';$label.Text='Ready';$label.Height=30
$closeButton=[Windows.Controls.Button]::new()
$closeButton.Name='SmokeClose';$closeButton.Content='Close smoke window';$closeButton.Height=35
$script:clicks=0
function Save-State([bool]$closed=$false){
 $state=[ordered]@{pid=$PID;sessionId=(Get-Process -Id $PID).SessionId;text=$textBox.Text;clicks=$script:clicks;closed=$closed}
 [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Compress),$utf8)
}
$textBox.Add_TextChanged({Save-State})
$button.Add_Click({$script:clicks++;$label.Text='Applied: '+$script:clicks;Save-State})
$closeButton.Add_Click({$window.Close()})
$window.Add_ContentRendered({$textBox.Focus();Save-State})
$window.Add_Closed({Save-State $true})
foreach($c in @($textBox,$button,$label,$closeButton)){[void]$panel.Children.Add($c)}
$window.Content=$panel
$timer=[Windows.Threading.DispatcherTimer]::new()
$timer.Interval=[TimeSpan]::FromMinutes(10)
$timer.Add_Tick({$window.Close()})
$timer.Start()
try{[void]$window.ShowDialog()}finally{$timer.Stop()}
