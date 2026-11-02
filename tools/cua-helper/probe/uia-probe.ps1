#requires -version 5.1
# Feasibility probe: can a plain Windows PowerShell 5.1 process act as a
# UI Automation backend for OurCode's computer-use helper?
# Read-only: enumerates top-level windows, then prints a capped ControlView
# subtree of one window. No input is synthesized.
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -Namespace Win32 -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
'@
$dpiOk = [Win32.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))

$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$C = [System.Windows.Automation.Condition]
$P = [System.Windows.Automation.AutomationPattern]

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$root = $A::RootElement
$tops = $root.FindAll($T::Children, $C::TrueCondition)
Write-Output ("dpi_v2={0} top_windows={1} enum_ms={2}" -f $dpiOk, $tops.Count, $sw.ElapsedMilliseconds)

$rows = foreach ($w in $tops) {
  try {
    $cur = $w.Current
    [pscustomobject]@{
      name = $cur.Name
      cls = $cur.ClassName
      pid = $cur.ProcessId
      type = $cur.ControlType.ProgrammaticName
      rect = $cur.BoundingRectangle
      el = $w
    }
  } catch { }
}
$rows | Select-Object -First 12 | ForEach-Object {
  Write-Output ("  win name='{0}' class='{1}' pid={2} type={3} rect={4}" -f $_.name, $_.cls, $_.pid, $_.type, $_.rect)
}

# Pick the first window that actually exposes a subtree (optional argv[0] = name substring).
$filter = if ($args.Count -gt 0 -and $args[0]) { [string]$args[0] } else { '' }
$target = $rows | Where-Object {
  (!$filter -or $_.name -like ('*' + $filter + '*')) -and
  $_.name -and $_.el.FindAll($T::Children, $C::TrueCondition).Count -gt 0
} | Select-Object -First 1
if (-not $target) { Write-Output 'no target window with children'; exit 0 }

Write-Output ("TARGET name='{0}' pid={1}" -f $target.name, $target.pid)

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:count = 0
$script:limit = 80

function Get-Actions($el) {
  $names = @()
  foreach ($pair in @(
      @('Invoke', $P::InvokePattern),
      @('set_value', $P::ValuePattern),
      @('toggle', $P::TogglePattern),
      @('select', $P::SelectionItemPattern),
      @('expand_collapse', $P::ExpandCollapsePattern),
      @('scroll', $P::ScrollPattern),
      @('select_text', $P::TextPattern))) {
    try {
      $obj = $null
      if ($el.TryGetCurrentPattern($pair[1], [ref]$obj)) { $names += $pair[0] }
    } catch { }
  }
  return $names
}

function Walk($el, [int]$depth, [string]$prefix) {
  if ($script:count -ge $script:limit) { return }
  try { $cur = $el.Current } catch { return }
  $script:count++
  $role = ($cur.ControlType.ProgrammaticName -replace 'ControlType\.', '').ToLower()
  $name = if ($cur.Name) { $cur.Name } else { '' }
  $value = ''
  try {
    $vp = $null
    if ($el.TryGetCurrentPattern($P::ValuePattern, [ref]$vp)) { $value = $vp.Current.Value }
  } catch { }
  $acts = (Get-Actions $el) -join ','
  $line = $prefix + '[' + ($script:count - 1) + '] ' + $role + ' "' + ($name -replace "`n", ' ') + '"'
  if ($value) { $line += ' value="' + ($value -replace "`n", ' ') + '"' }
  if ($acts) { $line += ' actions=[' + $acts + ']' }
  Write-Output $line
  if ($depth -le 0) { return }
  try { $child = $walker.GetFirstChild($el) } catch { return }
  while ($child -and $script:count -lt $script:limit) {
    Walk $child ($depth - 1) ($prefix + '  ')
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
}

Walk $target.el 4 ''
Write-Output ("walked={0} total_ms={1}" -f $script:count, $sw.ElapsedMilliseconds)
