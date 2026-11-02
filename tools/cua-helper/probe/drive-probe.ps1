#requires -version 5.1
# End-to-end feasibility probe for the OurCode CUA helper MVP (Windows).
#   target window -> UIA observe -> ValuePattern -> InvokePattern -> SendInput fallback
#   -> read-back -> screenshot -> teardown
# Only touches a helper window this script spawns itself.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  public static void TypeUnicode(string text) {
    foreach (char ch in text) {
      INPUT[] down = new INPUT[1];
      down[0].type = INPUT_KEYBOARD;
      down[0].U.ki.wVk = 0;
      down[0].U.ki.wScan = (ushort)ch;
      down[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
      SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
      INPUT[] up = new INPUT[1];
      up[0].type = INPUT_KEYBOARD;
      up[0].U.ki.wVk = 0;
      up[0].U.ki.wScan = (ushort)ch;
      up[0].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@

[void][Native]::SetProcessDpiAwarenessContext([IntPtr](-4))
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$C = [System.Windows.Automation.Condition]
$P = [System.Windows.Automation.AutomationPattern]
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$title = 'CUA Probe WPF 42'
$child = Start-Process powershell.exe -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot 'target-wpf.ps1'), '-Suffix', '42'
)

$win = $null
for ($i = 0; $i -lt 75 -and -not $win; $i++) {
  Start-Sleep -Milliseconds 200
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $title)
    $win = $A::RootElement.FindFirst($T::Children, $cond)
  } catch { }
}
if (-not $win) { Write-Output 'FAIL: target window not found'; try { $child.Kill() } catch {}; exit 1 }
Write-Output ("window_found_ms={0} name='{1}' class='{2}' pid={3}" -f $sw.ElapsedMilliseconds, $win.Current.Name, $win.Current.ClassName, $win.Current.ProcessId)
$hwnd = [IntPtr]$win.Current.NativeWindowHandle

function Find-All($root, [int]$limit) {
  $out = @()
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  while ($queue.Count -gt 0 -and $out.Count -lt $limit) {
    $pair = $queue.Dequeue(); $el = $pair[0]; $depth = $pair[1]
    $out += @{ el = $el; depth = $depth }
    if ($depth -ge 10) { continue }
    try { $c = $walker.GetFirstChild($el) } catch { $c = $null }
    while ($c) {
      $queue.Enqueue(@($c, $depth + 1))
      try { $c = $walker.GetNextSibling($c) } catch { break }
    }
  }
  return $out
}

$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$nodes = Find-All $win 120
$idx = 0
foreach ($n in $nodes) {
  $cur = $n.el.Current
  $role = ($cur.ControlType.ProgrammaticName -replace 'ControlType\.', '').ToLower()
  $val = ''
  try { $vp0 = $null; if ($n.el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp0)) { $val = $vp0.Current.Value } } catch { }
  Write-Output ("  [{0}] {1} '{2}' id='{3}'{4}" -f $idx, $role, $cur.Name, $cur.AutomationId, $(if ($val) { " value='" + $val + "'" } else { '' }))
  $idx++
}
Write-Output ("tree_nodes={0} capture_ms={1}" -f $nodes.Count, $sw2.ElapsedMilliseconds)

$box = $nodes | Where-Object { $_.el.Current.AutomationId -eq 'probeInput' } | Select-Object -First 1
$btn = $nodes | Where-Object { $_.el.Current.AutomationId -eq 'probeSubmit' } | Select-Object -First 1
$echo = $nodes | Where-Object { $_.el.Current.AutomationId -eq 'probeEcho' } | Select-Object -First 1
if (-not $box -or -not $btn -or -not $echo) { Write-Output 'FAIL: missing element(s)'; try { $child.Kill() } catch {}; exit 1 }

$vp = $null
if ($box.el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
  $vp.SetValue('Hello 中文')
  Write-Output 'set_value=ok'
} else { Write-Output 'set_value=unavailable' }

$ip = $null
if ($btn.el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
  $ip.Invoke(); Start-Sleep -Milliseconds 300
  Write-Output ("after_invoke echo='{0}'" -f $echo.el.Current.Name)
} else { Write-Output 'invoke=unavailable' }

# Fallback path: focus the window, focus the edit control, synthesize unicode keys.
[void][Native]::ShowWindow($hwnd, 9)
[void][Native]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 250
try { $box.el.SetFocus(); Start-Sleep -Milliseconds 150 } catch { Write-Output ('setfocus failed: ' + $_.Exception.Message) }
$fg = [Native]::GetForegroundWindow()
Write-Output ("foreground_match={0}" -f ($fg -eq $hwnd))
if ($fg -eq $hwnd) { [Native]::TypeUnicode(' XYZ'); Start-Sleep -Milliseconds 300 } else { Write-Output 'sendinput skipped' }
if ($ip) { $ip.Invoke(); Start-Sleep -Milliseconds 300 }
Write-Output ("after_typing echo='{0}'" -f $echo.el.Current.Name)

# Screenshot the window rect through GDI.
$r = $win.Current.BoundingRectangle
$w = [int]$r.Width; $h = [int]$r.Height
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, (New-Object System.Drawing.Size $w, $h))
$outPng = Join-Path $env:TEMP 'ourcode-cua-probe.png'
$bmp.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("screenshot={0}x{1} bytes={2} path={3}" -f $w, $h, (Get-Item $outPng).Length, $outPng)

try { $child.Kill() } catch {}
Write-Output ("total_ms={0}" -f $sw.ElapsedMilliseconds)
