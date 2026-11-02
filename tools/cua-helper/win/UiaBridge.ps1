#requires -version 5.1
<#
.SYNOPSIS
  OurCode Computer Use helper (Windows) — UI Automation + SendInput over NDJSON.

.DESCRIPTION
  One JSON object per line on stdin/stdout. The first request must be
  {"method":"hello","params":{"token":...}}; everything else is refused until
  that handshake succeeds.

  Methods:
    broker_info, permission_status, list_apps, capture_app, screenshot,
    click, element_perform_action, set_value, select_text, type_text,
    press_key, scroll, drag, paste, activate_window, launch_app,
    controller_stop, shutdown

  Notes that matter:
    - The process declares per-monitor-v2 DPI awareness before touching any UI,
      otherwise every coordinate is wrong on scaled displays.
    - Element indexes are only valid for the LATEST capture of that window.
    - The helper never decides policy or approvals: it executes what it is told.
      Approval, denylists, leases and the stop latch live in the main process.
    - Must be saved as UTF-8 with BOM: PowerShell 5.1 reads non-BOM files as ANSI
      and mangles Chinese literals (this broke an earlier probe).
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CuaNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki.wVk = vk;
    input.U.ki.wScan = scan;
    input.U.ki.dwFlags = flags;
    return input;
  }

  public static void KeyDown(ushort vk) { INPUT[] a = new INPUT[] { Key(vk, 0, 0) }; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void KeyUp(ushort vk) { INPUT[] a = new INPUT[] { Key(vk, 0, KEYEVENTF_KEYUP) }; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }

  public static void TypeUnicode(string text) {
    foreach (char ch in text) {
      INPUT[] down = new INPUT[] { Key(0, (ushort)ch, KEYEVENTF_UNICODE) };
      SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
      INPUT[] up = new INPUT[] { Key(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) };
      SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  static INPUT Mouse(uint flags, int data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.U.mi.dwFlags = flags;
    input.U.mi.mouseData = (uint)data;
    return input;
  }

  public static void MouseButton(uint down, uint up, int count) {
    for (int i = 0; i < count; i++) {
      INPUT[] d = new INPUT[] { Mouse(down, 0) }; SendInput(1, d, Marshal.SizeOf(typeof(INPUT)));
      INPUT[] u = new INPUT[] { Mouse(up, 0) }; SendInput(1, u, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(30);
    }
  }

  public static void Wheel(int delta) {
    INPUT[] a = new INPUT[] { Mouse(MOUSEEVENTF_WHEEL, delta) };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

[void][CuaNative]::SetProcessDpiAwarenessContext([IntPtr](-4))

$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$C = [System.Windows.Automation.Condition]
$P = [System.Windows.Automation.AutomationPattern]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$script:session = @{}     # "pid:windowId" -> @{ elements = AutomationElement[]; window = hashtable }
$script:lastKey = $null
$script:token = $env:OURCODE_CUA_TOKEN

function Write-Line($obj) {
  $json = $obj | ConvertTo-Json -Depth 20 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
function Ok($id, $result) { Write-Line @{ id = $id; ok = $true; result = $result } }
function Fail($id, $code, $message, $actionSent = $false) {
  Write-Line @{ id = $id; ok = $false; error = @{ code = $code; message = $message; actionSent = [bool]$actionSent } }
}

function Get-ProcessName([int]$processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-Bounds($element) {
  try {
    $r = $element.Current.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    return @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
  } catch { return $null }
}

function Get-WindowList {
  $out = New-Object System.Collections.ArrayList
  $root = $A::RootElement
  $kids = $root.FindAll($T::Children, $C::TrueCondition)
  foreach ($w in $kids) {
    try {
      $cur = $w.Current
      if ($cur.ProcessId -le 0) { continue }
      $hwnd = [IntPtr]$cur.NativeWindowHandle
      if ($hwnd -eq [IntPtr]::Zero) { continue }
      $bounds = Get-Bounds $w
      $visible = [CuaNative]::IsWindowVisible($hwnd)
      $minimized = [CuaNative]::IsIconic($hwnd)
      if (-not $visible -and -not $minimized) { continue }
      if (-not $cur.Name -and -not $cur.ClassName) { continue }
      [void]$out.Add([pscustomobject]@{
        pid = [int]$cur.ProcessId
        name = (Get-ProcessName ([int]$cur.ProcessId))
        title = [string]$cur.Name
        className = [string]$cur.ClassName
        windowId = [int64]$hwnd
        visible = [bool]$visible
        minimized = [bool]$minimized
        bounds = $bounds
      })
    } catch { continue }
  }
  return $out
}

function Resolve-Window($ref) {
  $pid_ = 0; $wid = 0; $name = ''
  if ($ref) {
    if ($ref.pid) { $pid_ = [int]$ref.pid }
    if ($ref.windowId) { $wid = [int64]$ref.windowId }
    if ($ref.name) { $name = [string]$ref.name }
  }
  $windows = Get-WindowList
  foreach ($w in $windows) {
    if ($wid -ne 0 -and $w.windowId -eq $wid) { return $w }
  }
  foreach ($w in $windows) {
    if ($pid_ -ne 0 -and $w.pid -eq $pid_) { return $w }
  }
  if ($name) {
    foreach ($w in $windows) {
      $hay = ($w.name + ' ' + $w.title)
      if ($hay -like ('*' + $name + '*')) { return $w }
    }
  }
  if ($pid_ -eq 0 -and $wid -eq 0 -and -not $name) { return $windows | Select-Object -First 1 }
  return $null
}

function Get-Element($ref, [int]$index) {
  $window = Resolve-Window $ref
  if (-not $window) { throw [pscustomobject]@{ code = 'WINDOW_NOT_FOUND'; message = '找不到目标窗口' } }
  $key = "$($window.pid):$($window.windowId)"
  $entry = $script:session[$key]
  if (-not $entry) { throw [pscustomobject]@{ code = 'TARGET_STALE'; message = '请先 capture_app 观察该窗口' } }
  if ($index -lt 0 -or $index -ge $entry.elements.Count) {
    throw [pscustomobject]@{ code = 'TARGET_STALE'; message = "元素索引 $index 不在最新观察里（共 $($entry.elements.Count) 个）" }
  }
  return @{ window = $window; element = $entry.elements[$index]; key = $key }
}

function Get-Actions($el) {
  $names = New-Object System.Collections.ArrayList
  foreach ($pair in @(
      @('press', [System.Windows.Automation.InvokePattern]::Pattern),
      @('set_value', [System.Windows.Automation.ValuePattern]::Pattern),
      @('toggle', [System.Windows.Automation.TogglePattern]::Pattern),
      @('select', [System.Windows.Automation.SelectionItemPattern]::Pattern),
      @('expand', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
      @('scroll', [System.Windows.Automation.ScrollPattern]::Pattern),
      @('select_text', [System.Windows.Automation.TextPattern]::Pattern))) {
    try {
      $obj = $null
      if (-not $el.TryGetCurrentPattern($pair[1], [ref]$obj)) { continue }
      # A read-only ValuePattern is not an action the model can use; advertising
      # it invites "set_value" calls that can only fail.
      if ($pair[0] -eq 'set_value' -and $obj.Current.IsReadOnly) { continue }
      [void]$names.Add($pair[0])
    } catch { }
  }
  return , $names.ToArray()
}

function Get-ElementValue($el) {
  try {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $v = $vp.Current.Value
      if ($null -ne $v) { return [string]$v }
    }
  } catch { }
  return ''
}

function Capture-App($params) {
  $window = Resolve-Window $params.app
  if (-not $window) { throw [pscustomobject]@{ code = 'WINDOW_NOT_FOUND'; message = '找不到目标窗口（先 list_apps）' } }
  if ($window.minimized) { throw [pscustomobject]@{ code = 'WINDOW_NOT_VISIBLE'; message = '窗口已最小化，先恢复窗口再观察' } }
  $hwnd = [IntPtr]$window.windowId
  $winEl = $A::FromHandle($hwnd)
  if (-not $winEl) { throw [pscustomobject]@{ code = 'WINDOW_NOT_FOUND'; message = '窗口句柄无效' } }

  $maxNodes = 300
  if ($params.maxNodes) { $maxNodes = [int]$params.maxNodes }
  if ($maxNodes -lt 20) { $maxNodes = 20 }

  $elements = New-Object System.Collections.ArrayList
  $native = New-Object System.Collections.ArrayList
  $truncated = $false

  # Depth-first, noise-pruned walk. BFS put dozens of unnamed shells before the
  # menu/button rows that actually matter, so the node cap was spent on nothing.
  # A node is kept when it carries a name, exposes an action, or is a top-level
  # child; containers with neither are traversed without taking an index.
  function Add-Node($node, [int]$depth) {
    if ($script:cuaStop) { return }
    if ($elements.Count -ge $maxNodes) { $script:cuaTruncated = $true; return }
    try { $cur = $node.Current } catch { return }
    $role = ($cur.ControlType.ProgrammaticName -replace 'ControlType\.', '').ToLower()
    $name = [string]$cur.Name
    $actions = Get-Actions $node
    $keep = ($name -ne '') -or ($actions.Count -gt 0) -or ($depth -le 1)
    if ($keep) {
      $idx = $elements.Count
      [void]$elements.Add([pscustomobject]@{
        index = $idx
        role = $role
        name = $name
        value = (Get-ElementValue $node)
        automationId = [string]$cur.AutomationId
        enabled = [bool]$cur.IsEnabled
        actions = $actions
        bounds = (Get-Bounds $node)
      })
      [void]$native.Add($node)
    }
    if ($depth -ge 12) { return }
    try { $child = $Walker.GetFirstChild($node) } catch { $child = $null }
    while ($child) {
      Add-Node $child ($depth + 1)
      if ($elements.Count -ge $maxNodes) { $script:cuaTruncated = $true; return }
      try { $child = $Walker.GetNextSibling($child) } catch { break }
    }
  }
  $script:cuaStop = $false
  $script:cuaTruncated = $false
  Add-Node $winEl 0
  $truncated = $script:cuaTruncated


  $key = "$($window.pid):$($window.windowId)"
  $script:session[$key] = @{
    elements = $native.ToArray()
    window = $window
    at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  }
  $script:lastKey = $key

  $image = $null
  if ($params.includeScreenshot -eq $true) {
    $shot = Save-WindowPng $window
    $image = @{ path = $shot.path; width = $shot.width; height = $shot.height; scale = 1 }
  }

  return @{
    app = @{ pid = $window.pid; name = $window.name }
    window = @{
      windowId = $window.windowId
      title = $window.title
      className = $window.className
      main = $true
      focused = ((Get-ForegroundPid) -eq $window.pid)
      visible = $window.visible
      minimized = $window.minimized
      bounds = $window.bounds
    }
    elements = $elements.ToArray()
    nodeCount = $elements.Count
    truncated = $truncated
    image = $image
  }
}

function Get-ForegroundPid {
  $hwnd = [CuaNative]::GetForegroundWindow()
  $pidOut = 0
  [void][CuaNative]::GetWindowThreadProcessId($hwnd, [ref]$pidOut)
  return [int]$pidOut
}

function Save-WindowPng($window) {
  $bounds = $window.bounds
  if (-not $bounds) { throw [pscustomobject]@{ code = 'WINDOW_NOT_VISIBLE'; message = '窗口没有可截图的区域' } }
  $x = $bounds[0]; $y = $bounds[1]; $w = $bounds[2]; $h = $bounds[3]
  if ($w -le 0 -or $h -le 0) { throw [pscustomobject]@{ code = 'WINDOW_NOT_VISIBLE'; message = '窗口尺寸为 0' } }
  $dir = Join-Path $env:TEMP 'ourcode-cua'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $path = Join-Path $dir ('frame-' + [guid]::NewGuid().ToString('n') + '.png')
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return @{ path = $path; width = $w; height = $h }
}

function Get-Center($bounds) {
  if (-not $bounds) { return $null }
  return @{ x = [int]($bounds[0] + $bounds[2] / 2); y = [int]($bounds[1] + $bounds[3] / 2) }
}

function Click-Point([int]$x, [int]$y, [string]$button, [int]$count) {
  [void][CuaNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
  switch ($button) {
    'right' { [CuaNative]::MouseButton([CuaNative]::MOUSEEVENTF_RIGHTDOWN, [CuaNative]::MOUSEEVENTF_RIGHTUP, $count) }
    'middle' { [CuaNative]::MouseButton([CuaNative]::MOUSEEVENTF_MIDDLEDOWN, [CuaNative]::MOUSEEVENTF_MIDDLEUP, $count) }
    default { [CuaNative]::MouseButton([CuaNative]::MOUSEEVENTF_LEFTDOWN, [CuaNative]::MOUSEEVENTF_LEFTUP, $count) }
  }
}

$VK = @{
  'return' = 0x0D; 'enter' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B; 'space' = 0x20
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'home' = 0x24; 'end' = 0x23
  'pageup' = 0x21; 'pagedown' = 0x22; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'control_l' = 0xA2; 'control' = 0xA2; 'ctrl' = 0xA2; 'shift_l' = 0xA0; 'shift' = 0xA0; 'alt_l' = 0xA4; 'alt' = 0xA4
}
function ConvertTo-Vk([string]$key) {
  $k = $key.Trim()
  if (-not $k) { throw [pscustomobject]@{ code = 'ACTION_UNAVAILABLE'; message = '空按键' } }
  if ($k -imatch '^(win|meta|lwin|rwin)$') {
    throw [pscustomobject]@{ code = 'FOREGROUND_REQUIRED'; message = '拒绝 Win/Meta 组合键（会与系统全局快捷键冲突）' }
  }
  $lower = $k.ToLower()
  if ($VK.ContainsKey($lower)) { return [uint16]$VK[$lower] }
  if ($k.Length -eq 1) {
    $ch = $k.ToUpper()
    if ($ch -match '[A-Z]') { return [uint16]([int][char]$ch) }
    if ($ch -match '[0-9]') { return [uint16]([int][char]$ch) }
  }
  throw [pscustomobject]@{ code = 'ACTION_UNAVAILABLE'; message = "不认识的按键：$key" }
}

function Press-Chord([string]$keys) {
  $parts = $keys -split '\+'
  $codes = @()
  foreach ($p in $parts) { $codes += (ConvertTo-Vk $p) }
  foreach ($c in $codes) { [CuaNative]::KeyDown($c); Start-Sleep -Milliseconds 20 }
  for ($i = $codes.Count - 1; $i -ge 0; $i--) { [CuaNative]::KeyUp($codes[$i]); Start-Sleep -Milliseconds 20 }
}

function Ensure-Foreground($window) {
  $fg = Get-ForegroundPid
  if ($fg -ne $window.pid) {
    throw [pscustomobject]@{ code = 'FOREGROUND_REQUIRED'; message = '目标窗口不在前台：先用 activate_window，或改用元素动作' }
  }
}

# ── main loop ───────────────────────────────────────────────────────────────
$handshaken = $false
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $id = $req.id
  try {
    if (-not $handshaken) {
      if ($req.method -ne 'hello' -or -not $script:token -or [string]$req.params.token -ne $script:token) {
        Fail $id 'PERMISSION_DENIED' 'handshake 失败：token 不匹配'
        break
      }
      $handshaken = $true
      Ok $id @{
        protocol = 'cua-ips/1'
        platform = 'win32'
        capabilities = @('uia', 'sendinput', 'gdi', 'clipboard')
        permission = @{
          interactiveSession = $true
          dpiAware = $true
          screenCapture = $true
          accessibility = 'not_required'
          screenRecording = 'not_required'
        }
      }
      continue
    }

    switch ($req.method) {
      'broker_info' {
        Ok $id @{
          protocol = 'cua-ips/1'; platform = 'win32'
          capabilities = @('uia', 'sendinput', 'gdi', 'clipboard')
        }
      }
      'permission_status' {
        Ok $id @{ interactiveSession = $true; dpiAware = $true; screenCapture = $true; accessibility = 'not_required'; screenRecording = 'not_required' }
      }
      'list_apps' {
        $apps = @()
        foreach ($w in Get-WindowList) {
          $apps += @{
            pid = $w.pid; name = $w.name; title = $w.title; windowId = $w.windowId
            visible = $w.visible; minimized = $w.minimized; bounds = $w.bounds
          }
        }
        Ok $id @{ apps = $apps }
      }
      'capture_app' { Ok $id (Capture-App $req.params) }
      'screenshot' {
        if ($req.params.target -eq 'screen') {
          $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
          $window = @{ bounds = @([int]$vs.X, [int]$vs.Y, [int]$vs.Width, [int]$vs.Height) }
          $shot = Save-WindowPng $window
        } else {
          $window = Resolve-Window $req.params.app
          if (-not $window) { throw [pscustomobject]@{ code = 'WINDOW_NOT_FOUND'; message = '找不到目标窗口' } }
          $shot = Save-WindowPng $window
        }
        Ok $id @{ path = $shot.path; width = $shot.width; height = $shot.height; scale = 1; unit = 'physical_pixel' }
      }
      'click' {
        $params = $req.params
        if ($null -ne $params.elementIndex) {
          $found = Get-Element $params.app ([int]$params.elementIndex)
          $el = $found.element
          $strategy = [string]$params.strategy
          $invoked = $false
          if ($strategy -ne 'event') {
            try {
              $ip = $null
              if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
                $ip.Invoke(); $invoked = $true
              }
            } catch { $invoked = $false }
          }
          if (-not $invoked) {
            $center = Get-Center (Get-Bounds $el)
            if (-not $center) { throw [pscustomobject]@{ code = 'ELEMENT_UNAVAILABLE'; message = '元素没有可点击区域' } }
            Click-Point $center.x $center.y ([string]$params.button) ([int]$params.count)
          }
          Ok $id @{ ok = $true; strategy = $(if ($invoked) { 'a11y' } else { 'event' }) }
        } else {
          if ($null -eq $params.x -or $null -eq $params.y) {
            throw [pscustomobject]@{ code = 'TARGET_STALE'; message = '需要 elementIndex 或 x/y 坐标' }
          }
          Click-Point ([int]$params.x) ([int]$params.y) ([string]$params.button) ([int]$params.count)
          Ok $id @{ ok = $true; strategy = 'event' }
        }
      }
      'set_value' {
        $found = Get-Element $req.params.app ([int]$req.params.elementIndex)
        $vp = $null
        if (-not $found.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
          throw [pscustomobject]@{ code = 'NOT_SETTABLE'; message = '该元素不支持 set_value' }
        }
        if ($vp.Current.IsReadOnly) { throw [pscustomobject]@{ code = 'NOT_SETTABLE'; message = '该元素是只读的' } }
        $vp.SetValue([string]$req.params.value)
        Ok $id @{ ok = $true }
      }
      'select_text' {
        $found = Get-Element $req.params.app ([int]$req.params.elementIndex)
        $tp = $null
        if (-not $found.element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
          throw [pscustomobject]@{ code = 'NOT_SELECTABLE'; message = '该元素不支持文本选择' }
        }
        $tp.DocumentRange.Select()
        Ok $id @{ ok = $true }
      }
      'element_perform_action' {
        $found = Get-Element $req.params.app ([int]$req.params.elementIndex)
        $el = $found.element
        $action = ([string]$req.params.action).ToLower()
        $done = $false
        if ($action -in @('press', 'invoke', 'click')) {
          $ip = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); $done = $true }
        } elseif ($action -in @('expand', 'collapse')) {
          $ep = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ep)) {
            if ($action -eq 'expand') { $ep.Expand() } else { $ep.Collapse() }
            $done = $true
          }
        } elseif ($action -eq 'select') {
          $sp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $sp.Select(); $done = $true }
        } elseif ($action -eq 'toggle') {
          $tp2 = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp2)) { $tp2.Toggle(); $done = $true }
        }
        if (-not $done) { throw [pscustomobject]@{ code = 'ACTION_UNAVAILABLE'; message = "元素不支持 action=$action" } }
        Ok $id @{ ok = $true }
      }
      'type_text' {
        $window = Resolve-Window $req.params.app
        if ($window) { Ensure-Foreground $window }
        [CuaNative]::TypeUnicode([string]$req.params.text)
        Ok $id @{ ok = $true }
      }
      'press_key' {
        $window = Resolve-Window $req.params.app
        if ($window) { Ensure-Foreground $window }
        Press-Chord ([string]$req.params.keys)
        Ok $id @{ ok = $true }
      }
      'paste' {
        $window = Resolve-Window $req.params.app
        if ($window) { Ensure-Foreground $window }
        $previous = ''
        try { $previous = [System.Windows.Forms.Clipboard]::GetText() } catch { }
        [System.Windows.Forms.Clipboard]::SetText([string]$req.params.text)
        Press-Chord 'Control_L+v'
        Start-Sleep -Milliseconds 80
        try { [System.Windows.Forms.Clipboard]::SetText([string]$previous) } catch { }
        Ok $id @{ ok = $true }
      }
      'scroll' {
        $amount = 1
        if ($req.params.amount) { $amount = [int]$req.params.amount }
        $delta = $(if ([string]$req.params.direction -eq 'up') { 120 } else { -120 }) * $amount
        if ($null -ne $req.params.elementIndex) {
          $found = Get-Element $req.params.app ([int]$req.params.elementIndex)
          $center = Get-Center (Get-Bounds $found.element)
          if ($center) { [void][CuaNative]::SetCursorPos($center.x, $center.y); Start-Sleep -Milliseconds 40 }
        } elseif ($null -ne $req.params.x -and $null -ne $req.params.y) {
          [void][CuaNative]::SetCursorPos([int]$req.params.x, [int]$req.params.y)
          Start-Sleep -Milliseconds 40
        }
        [CuaNative]::Wheel($delta)
        Ok $id @{ ok = $true }
      }
      'drag' {
        $from = $req.params.from; $to = $req.params.to
        if (-not $from -or -not $to) { throw [pscustomobject]@{ code = 'TARGET_STALE'; message = 'drag 需要 from/to' } }
        [void][CuaNative]::SetCursorPos([int]$from.x, [int]$from.y)
        Start-Sleep -Milliseconds 60
        [CuaNative]::MouseButton([CuaNative]::MOUSEEVENTF_LEFTDOWN, 0, 1)
        for ($i = 1; $i -le 10; $i++) {
          $x = [int]$from.x + ([int]$to.x - [int]$from.x) * $i / 10
          $y = [int]$from.y + ([int]$to.y - [int]$from.y) * $i / 10
          [void][CuaNative]::SetCursorPos($x, $y)
          Start-Sleep -Milliseconds 20
        }
        [CuaNative]::MouseButton(0, [CuaNative]::MOUSEEVENTF_LEFTUP, 1)
        Ok $id @{ ok = $true }
      }
      'activate_window' {
        $window = Resolve-Window $req.params.app
        if (-not $window) { throw [pscustomobject]@{ code = 'WINDOW_NOT_FOUND'; message = '找不到目标窗口' } }
        [void][CuaNative]::ShowWindow([IntPtr]$window.windowId, 9)
        [void][CuaNative]::SetForegroundWindow([IntPtr]$window.windowId)
        Ok $id @{ ok = $true; windowId = $window.windowId }
      }
      'launch_app' {
        $target = [string]$req.params.target
        $path = [string]$req.params.path
        $argList = @()
        if ($path) { Start-Process -FilePath $path | Out-Null }
        elseif ($target) { Start-Process -FilePath $target | Out-Null }
        else { throw [pscustomobject]@{ code = 'WINDOW_NOT_FOUND'; message = 'launch 需要 target 或 path' } }
        $deadline = (Get-Date).AddSeconds(12)
        $window = $null
        while ((Get-Date) -lt $deadline -and -not $window) {
          Start-Sleep -Milliseconds 300
          $window = Resolve-Window @{ name = $target }
        }
        if (-not $window) { Ok $id @{ ok = $false; pending = $true } }
        else { Ok $id @{ ok = $true; app = @{ pid = $window.pid; name = $window.name; windowId = $window.windowId; title = $window.title } } }
      }
      'controller_stop' { Ok $id @{ ok = $true } }
      'shutdown' { Ok $id @{ ok = $true }; exit 0 }
      default { Fail $id 'UNSUPPORTED' "未实现的方法：$($req.method)" }
    }
  } catch {
    $code = 'INTERNAL'
    $message = $_.Exception.Message
    if ($_.TargetObject -and $_.TargetObject.PSObject.Properties['code']) {
      $code = [string]$_.TargetObject.code
      $message = [string]$_.TargetObject.message
    } elseif ($_.Exception.PSObject.Properties['code']) {
      $code = [string]$_.Exception.code
      $message = [string]$_.Exception.message
    } elseif ($_.Exception.InnerException -and $_.Exception.InnerException.PSObject.Properties['code']) {
      $code = [string]$_.Exception.InnerException.code
      $message = [string]$_.Exception.InnerException.message
    }
    if ($code -eq 'INTERNAL') {
      $msg = [string]$message
      if ($msg -match 'ElementNotAvailable|0x80040201') { $code = 'ELEMENT_UNAVAILABLE' }
      elseif ($msg -match 'ElementNotEnabled') { $code = 'ACTION_UNAVAILABLE' }
      elseif ($msg -match 'InvalidOperation|Unsupported') { $code = 'ACTION_UNAVAILABLE' }
    }
    $isWrite = $req.method -in @('click','type_text','press_key','set_value','scroll','drag','paste','element_perform_action','select_text','activate_window','launch_app')
    Fail $id $code $message $isWrite
  }
}
