# Disposable UI-only workflow. State contains generated test data; every process expires.
param(
 [Parameter(Mandatory=$true)][string]$StateDirectory,
 [string]$RunId=([Guid]::NewGuid().ToString('N')),
 [ValidateSet('Source','Destination','Decoy')][string]$Mode='Source',
 [ValidateRange(30,5400)][int]$LifetimeSeconds=5400
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
New-Item -ItemType Directory -Force -Path $StateDirectory|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
$statePath=Join-Path $StateDirectory ($Mode.ToLowerInvariant()+'.json')
$script:events=[Collections.Generic.List[object]]::new()
$script:children=[Collections.Generic.List[Diagnostics.Process]]::new()
$script:expanded=0;$script:selections=0;$script:connects=0;$script:focuses=0;$script:selected=''
$window=[Windows.Window]::new()
$window.Title="windows-use Transition $Mode $RunId"
$window.Width=620;$window.Height=420;$window.WindowStartupLocation='CenterScreen'
$panel=[Windows.Controls.StackPanel]::new();$panel.Margin=[Windows.Thickness]::new(20)
$window.Content=$panel
$script:input=$null;$script:otherInput=$null
function Save-State([string]$event='snapshot',[bool]$closed=$false){
 $script:events.Add([ordered]@{event=$event;at=[DateTime]::UtcNow.ToString('o')})
 $state=[ordered]@{fixture='windows-transition';mode=$Mode;runId=$RunId;pid=$PID;title=$window.Title;
  sessionId=(Get-Process -Id $PID).SessionId;expanded=$script:expanded;selections=$script:selections;
  selected=$script:selected;connects=$script:connects;focuses=$script:focuses;closed=$closed;
  text=$(if($script:input){$script:input.Text}else{''});
  otherText=$(if($script:otherInput){$script:otherInput.Text}else{''});events=@($script:events.ToArray())}
 $temporary=$statePath+'.tmp'
 [IO.File]::WriteAllText($temporary,($state|ConvertTo-Json -Depth 5 -Compress),$utf8)
 Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
function Start-FixtureChild([string]$childMode){
 $quote={param($value) "'"+$value.Replace("'","''")+"'"}
 $command='& '+(& $quote $PSCommandPath)+' -StateDirectory '+(& $quote $StateDirectory)+
  ' -RunId '+(& $quote $RunId)+' -Mode '+$childMode+' -LifetimeSeconds '+$LifetimeSeconds
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
 $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-STA','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru
 $script:children.Add($child)
}
if($Mode -eq 'Source'){
 $tree=[Windows.Controls.TreeView]::new();$tree.Height=250
 $group=[Windows.Controls.TreeViewItem]::new();$group.Header='Test Servers';$group.Name='ServerGroup';$group.IsExpanded=$false
 [Windows.Automation.AutomationProperties]::SetName($group,'Test Servers')
 $group.Add_Expanded({$script:expanded++;Save-State 'expand'})
 foreach($name in @('Test Server A','Test Server B')){
  $item=[Windows.Controls.TreeViewItem]::new();$item.Header=$name
  [Windows.Automation.AutomationProperties]::SetName($item,$name)
  $menu=[Windows.Controls.ContextMenu]::new()
  $connect=[Windows.Controls.MenuItem]::new();$connect.Header='Connect'
  [Windows.Automation.AutomationProperties]::SetName($connect,'Connect')
  $connect.Add_Click({
   if($script:selected -ne 'Test Server B'){Save-State 'connect-rejected';return}
   $script:connects++;Save-State 'connect';Start-FixtureChild 'Destination'
  })
  [void]$menu.Items.Add($connect);$item.ContextMenu=$menu
  [void]$group.Items.Add($item)
 }
 $tree.Add_SelectedItemChanged({$script:selected=[string]$tree.SelectedItem.Header;$script:selections++;Save-State 'select'})
 [void]$tree.Items.Add($group);[void]$panel.Children.Add($tree)
 $window.Add_ContentRendered({Save-State 'ready';Start-FixtureChild 'Decoy'})
}else{
 $label=[Windows.Controls.TextBlock]::new();$label.Text="Generated $Mode fixture";[void]$panel.Children.Add($label)
 $script:otherInput=[Windows.Controls.TextBox]::new();$script:otherInput.Text='untouched';$script:otherInput.Height=40
 [Windows.Automation.AutomationProperties]::SetName($script:otherInput,'Other input')
 $script:input=[Windows.Controls.TextBox]::new();$script:input.Text='initial';$script:input.Height=60
 [Windows.Automation.AutomationProperties]::SetName($script:input,'Destination input')
 $script:input.Add_TextChanged({Save-State 'text'})
 $script:otherInput.Add_TextChanged({Save-State 'other-text'})
 $script:input.Add_GotKeyboardFocus({$script:focuses++;Save-State 'focus'})
 [void]$panel.Children.Add($script:otherInput);[void]$panel.Children.Add($script:input)
 $window.Add_ContentRendered({[void]$script:otherInput.Focus();Save-State 'ready'})
}
$close=[Windows.Controls.Button]::new();$close.Content='Close fixture';$close.Height=35
[Windows.Automation.AutomationProperties]::SetName($close,'Close fixture')
$close.Add_Click({$window.Close()});[void]$panel.Children.Add($close)
$window.Add_Closed({Save-State 'closed' $true})
$deadline=[DateTime]::UtcNow.AddSeconds($LifetimeSeconds)
$stopPath=Join-Path $StateDirectory 'stop'
$timer=[Windows.Threading.DispatcherTimer]::new();$timer.Interval=[TimeSpan]::FromSeconds(1)
$timer.Add_Tick({if([DateTime]::UtcNow -ge $deadline -or (Test-Path -LiteralPath $stopPath)){$window.Close()}});$timer.Start()
try{[void]$window.ShowDialog()}finally{
 $timer.Stop()
 foreach($child in $script:children){try{if(-not $child.HasExited){[void]$child.CloseMainWindow()}}catch{}}
}
