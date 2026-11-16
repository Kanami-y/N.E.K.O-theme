# cascade.ps1 -- "why did my declaration lose?" front door.
#
#   powershell -File cascade.ps1 -Sel ".composer-input-shell" -Prop background-color -Sentinel
#   powershell -File cascade.ps1 -Sel "#sendButton" -Prop background-color -Sentinel -Theme light
#
# Copies test/cascade.html into the app's served static dir, runs it in real Chrome, and prints
# the ranked candidate declarations (winner first) plus the computed value. ASCII only: PS 5.1
# mis-decodes BOM-less non-ASCII script files.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Sel,
  [Parameter(Mandatory = $true)][string]$Prop,
  [ValidateSet('light', 'dark')][string]$Theme = 'light',
  [switch]$Sentinel,
  [string]$AppRoot = '',
  [string]$Studio  = '',
  [string]$Base    = 'http://127.0.0.1:48911'
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

$src = Join-Path $Studio 'test\cascade.html'
$dst = Join-Path $AppRoot 'resources\bin\static\_nts_cascade.html'
[System.IO.File]::WriteAllText($dst, [System.IO.File]::ReadAllText($src), (New-Object System.Text.UTF8Encoding($false)))

$chromeCands = @()
if ($env:NTS_BROWSER_PATH) { $chromeCands += $env:NTS_BROWSER_PATH }
if ($env:CHROME_PATH)      { $chromeCands += $env:CHROME_PATH }
$chromeCands += @(
  $env:NTS_BROWSER_PATH
  $env:CHROME_PATH
  'C:\Program Files\Chrome\App\chrome.exe'
  'C:\Program Files\Google\Chrome\Application\chrome.exe'
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$chrome = $chromeCands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chrome) { throw 'no Chromium browser found: 用环境变量 NTS_BROWSER_PATH 指定 chrome.exe 完整路径（chrome-headless-shell 也可）。' }

$url = "$Base/static/_nts_cascade.html?sel=$([uri]::EscapeDataString($Sel))&prop=$([uri]::EscapeDataString($Prop))"
if ($Theme -eq 'dark') { $url += '&theme=dark' }
if ($Sentinel) { $url += '&sentinel=1' }

$tmp = Join-Path $env:TEMP ('nts-cascade-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$dom = Join-Path $tmp 'out.html'
& $chrome '--headless=new' '--disable-gpu' '--no-first-run' '--no-default-browser-check' '--disable-extensions' `
          "--user-data-dir=$(Join-Path $tmp 'udd')" '--virtual-time-budget=8000' '--dump-dom' $url 2>$null |
  Set-Content -LiteralPath $dom -Encoding UTF8

$txt = [System.IO.File]::ReadAllText($dom)
$m = [regex]::Match($txt, '(?s)<pre id="nts-out"[^>]*>(.*?)</pre>')
if (-not $m.Success) { throw 'cascade page produced no #nts-out' }
$o = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) | ConvertFrom-Json

Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("selector   : " + $o.sel)
Write-Host ("property   : " + $o.prop)
Write-Host ("theme      : " + $o.theme + "   sentinel=" + $o.sentinel)
Write-Host ("target el  : " + $o.target)
Write-Host ("var on root: '" + $o.varOnRoot + "'   var on el: '" + $o.varOnEl + "'")
Write-Host ("COMPUTED   : " + $o.computed)
if ($o.error) { Write-Host ("ERROR: " + $o.error); exit 1 }
Write-Host ''
Write-Host 'ranked candidates (cascade order, winner first):'
$i = 0
foreach ($c in $o.candidates) {
  $tag = if ($i -eq 0) { '=>' } else { '  ' }
  Write-Host ("  {0} {1} spec({2}) {3}" -f $tag, $(if ($c.imp) { '!imp' } else { '    ' }), $c.spec, $c.sheet)
  Write-Host ("       sel: " + $c.sel)
  Write-Host ("       val: " + $c.val)
  if ($c.at) { Write-Host ("       at : " + ($c.at -join ' >> ')) }
  $i++
}
