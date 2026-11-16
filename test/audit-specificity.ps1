<#
  audit-specificity.ps1 -- find every target where a native rule OUTRANKS ours.

  Generated CSS uses fixed prefixes (:root:root body / :root[data-theme="dark"]:root:root body).
  That wins by a wide margin in most places, but a native selector with more !important-weighted
  specificity can still beat it, which shows up as "sentinel value had no effect".
  Instead of guessing which one, this enumerates the actual cascade and reports the winner.

  Usage: powershell -File audit-specificity.ps1 [-Theme light|dark] [-JsonPath <file>]
  Exit: 0 always (this is diagnostic); read the table it prints.
#>
[CmdletBinding()]
param(
  [string]$AppRoot = '',
  [string]$Studio  = '',
  [string]$Base    = 'http://127.0.0.1:48911',
  [ValidateSet('light', 'dark')] [string]$Theme = 'light',
  [string]$JsonPath = ''
)

# 路径推导：省略参数时从本脚本位置反推（theme-studio\ 的上一级是 N.E.K.O 安装根），
# 这样整目录拷到别的机器 / 别的盘符都能直接跑，不需要改脚本。
if ([string]::IsNullOrWhiteSpace($Studio)) {
    $Studio = Split-Path -Parent $PSScriptRoot
    if ((Split-Path -Leaf $Studio) -ne 'theme-studio') {
        # 兼容脚本被放在 theme-studio\test\ 或 theme-studio\tools\ 下的情形
        $maybe = Split-Path -Parent $Studio
        if ((Split-Path -Leaf $maybe) -eq 'theme-studio') { $Studio = $maybe }
    }
}
if ([string]::IsNullOrWhiteSpace($AppRoot)) { $AppRoot = Split-Path -Parent $Studio }
$Studio  = $Studio.TrimEnd('\')
$AppRoot = $AppRoot.TrimEnd('\')
$ErrorActionPreference = 'Stop'
. (Join-Path $Studio 'test\probe.ps1')

$src = [System.IO.File]::ReadAllText((Join-Path $Studio 'test\specificity-audit.html'))
$targetsJs = [System.IO.File]::ReadAllText((Join-Path $Studio 'test\targets.js'))
$targetsJs = $targetsJs -replace '(?s)if \(typeof module[\s\S]*$', ''
$src = $src.Replace('/*NTS_TARGETS_JS*/', $targetsJs)

$cssUrl = "$Base/static/css/neko-theme-studio.css"
$src = $src.Replace('<!--NTS_CSS_HOOK-->', "<link rel=`"stylesheet`" href=`"$cssUrl`">")

$probeName = '_nts_audit.html'
$probePath = Join-Path $AppRoot ('resources\bin\static\' + $probeName)
[System.IO.File]::WriteAllText($probePath, $src, (New-Object System.Text.UTF8Encoding($false)))

$chrome = Get-NtsChrome
$tmp = Join-Path $env:TEMP ('nts-audit-' + $Theme)
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$dom = Join-Path $tmp 'out.dom.html'
$url = "$Base/static/$probeName" + $(if ($Theme -eq 'dark') { '?theme=dark' } else { '' })
& $chrome @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', "--user-data-dir=$tmp\udd", '--virtual-time-budget=15000',
  '--allow-file-access-from-files', '--dump-dom', $url
) 2>$null | Set-Content -LiteralPath $dom -Encoding UTF8

Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue

$txt = [System.IO.File]::ReadAllText($dom)
$m = [regex]::Match($txt, '(?s)<pre id="nts-out"[^>]*>(.*?)</pre>')
if (-not $m.Success) { throw 'audit page produced no #nts-out' }
$json = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
$r = $json | ConvertFrom-Json
if ($JsonPath) { [System.IO.File]::WriteAllText($JsonPath, $json, (New-Object System.Text.UTF8Encoding($false))) }

Write-Host ("theme={0}  problem rows={1}" -f $r.theme, @($r.winners).Count)
if ($r.error) { Write-Host ("PAGE ERROR: {0}" -f $r.error) }
Write-Host ''
foreach ($w in $r.winners) {
  $flag = if ($w.outranked) { 'OUTRANKED' } elseif ($w.ambiguous) { 'AMBIGUOUS' } else { 'note' }
  Write-Host ("[{0}] {1}   prop={2}   var={3}" -f $flag, $w.target, $w.prop, $w.ourVar)
  if ($w.ours) { Write-Host ("        ours : {0} {1}{2}  [{3}]" -f $w.ours.spec, $w.ours.sel, $(if ($w.ours.important) { ' !important' } else { '' }), $w.ours.sheet) }
  Write-Host ("        top  : {0} {1}{2}  [{3}] = {4}" -f $w.top.spec, $w.top.sel, $(if ($w.top.important) { ' !important' } else { '' }), $w.top.sheet, $w.top.val)
  foreach ($line in $w.all) { Write-Host ("          {0}" -f $line) }
  Write-Host ''
}
