#requires -version 5.1
<#
.SYNOPSIS
  Build the OurCode Computer Use helper (CuaHelper.exe) with the in-box compiler.

.DESCRIPTION
  Uses the .NET Framework 4.8 compiler that ships with Windows (no SDK needed) and
  compiles one self-contained exe against the framework's UIAutomation assemblies.
  Output: tools/cua-helper/win/CuaHelper.exe (same NDJSON protocol as UiaBridge.ps1).

  The source is deliberately C# 5: the in-box csc.exe does not accept C# 6+ syntax.

.PARAMETER Output
  Target exe path (default: CuaHelper.exe next to this script).
#>
param(
  [string]$Output = (Join-Path $PSScriptRoot 'CuaHelper.exe')
)

$ErrorActionPreference = 'Stop'
$fw = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) {
  # 32-bit Windows
  $fw = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319'
  $csc = Join-Path $fw 'csc.exe'
}
if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 编译器：$csc" }

$refs = @(
  (Join-Path $fw 'WPF\UIAutomationClient.dll'),
  (Join-Path $fw 'WPF\UIAutomationTypes.dll'),
  (Join-Path $fw 'WPF\WindowsBase.dll'),
  (Join-Path $fw 'System.Windows.Forms.dll'),
  (Join-Path $fw 'System.Drawing.dll'),
  (Join-Path $fw 'System.Web.Extensions.dll'),
  (Join-Path $fw 'System.Core.dll')
) | Where-Object { Test-Path $_ }

$refArgs = $refs | ForEach-Object { "/r:`"$_`"" }
$source = Join-Path $PSScriptRoot 'CuaHelper.cs'

& $csc /nologo /target:exe /platform:anycpu /optimize+ /warn:2 `
  "/out:$Output" `
  @refArgs `
  $source
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$item = Get-Item -LiteralPath $Output
"built: $($item.FullName)  ($([math]::Round($item.Length / 1KB, 1)) KB)"
