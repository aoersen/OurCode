#requires -version 5.1
# WPF target window for the CUA probe. WPF has first-class UI Automation peers,
# so AutomationId / ValuePattern / InvokePattern all behave like a modern app.
param([string]$Suffix = '42')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="CUA Probe WPF $Suffix" Width="460" Height="260"
        WindowStartupLocation="CenterScreen">
  <StackPanel Margin="16">
    <TextBox x:Name="probeInput" AutomationProperties.AutomationId="probeInput" Height="30"/>
    <Button x:Name="probeSubmit" AutomationProperties.AutomationId="probeSubmit" Content="Submit" Width="120" Height="32" Margin="0,12,0,0" HorizontalAlignment="Left"/>
    <TextBlock x:Name="probeEcho" AutomationProperties.AutomationId="probeEcho" Text="(empty)" Margin="0,12,0,0"/>
  </StackPanel>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)
$box = $win.FindName('probeInput')
$btn = $win.FindName('probeSubmit')
$echo = $win.FindName('probeEcho')
$btn.Add_Click({ $echo.Text = 'echo:' + $box.Text })
$win.Add_ContentRendered({ $box.Focus() | Out-Null })
[void]$win.ShowDialog()
