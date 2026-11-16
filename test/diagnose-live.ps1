# diagnose-live.ps1 -- 从外部用真 Blink 跑一遍「面板 -> 主题色」链路自检。
# 用法：powershell -ExecutionPolicy Bypass -File .\theme-studio\test\diagnose-live.ps1
# 可选：-Url <页面地址> -Port <调试端口> -BrowserPath <chrome.exe 完整路径> -OutFile <保存 JSON>
[CmdletBinding()]
param(
  [string]$Url = "http://127.0.0.1:48911/chat",
  [int]$Port = 9355,
  [string]$BrowserPath = "",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$root   = Split-Path -Parent $here
$evalJs = Join-Path (Join-Path $root "tools") "page-eval.js"
$exprJs = Join-Path $here "diagnose-in-app.js"

function Stop-With([string]$msg, [string]$hint) {
  Write-Host ""
  Write-Host ("[X] " + $msg) -ForegroundColor Red
  if ($hint) { Write-Host ("    " + $hint) -ForegroundColor Yellow }
  exit 2
}

Write-Host "=== N.E.K.O 主题色链路自检 ===" -ForegroundColor Cyan
Write-Host ("页面 : " + $Url)
Write-Host ("脚本 : " + $exprJs)

if (-not (Test-Path $exprJs)) { Stop-With ("找不到 " + $exprJs) "请在主题插件包目录里运行。" }
if (-not (Test-Path $evalJs)) { Stop-With ("找不到 " + $evalJs) "包不完整（tools\page-eval.js 缺失）。" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-With "没有找到 node" "改用 DevTools 手动方案：应用窗口 Ctrl+Shift+I -> Console -> 粘贴 test\diagnose-in-app.js 全文。"
}

try { $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -Method Head }
catch { Write-Host ("[!] 访问 " + $Url + " 失败：" + $_.Exception.Message) -ForegroundColor Yellow }

$cands = @()
if ($BrowserPath) { $cands += $BrowserPath }
if ($env:NTS_BROWSER_PATH) { $cands += $env:NTS_BROWSER_PATH }
if ($env:CHROME_PATH)      { $cands += $env:CHROME_PATH }
$pf   = $env:ProgramFiles
$pf86 = ${env:ProgramFiles(x86)}
$lad  = $env:LOCALAPPDATA
$cands += 'C:\Program Files\Chrome\App\chrome.exe'   # Chrome++ 便携布局
if ($pf)   { $cands += (Join-Path $pf   'Google\Chrome\Application\chrome.exe') }
if ($pf86) { $cands += (Join-Path $pf86 'Google\Chrome\Application\chrome.exe') }
if ($lad)  { $cands += (Join-Path $lad  'Google\Chrome\Application\chrome.exe') }
if ($pf86) { $cands += (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe') }
if ($pf)   { $cands += (Join-Path $pf   'Microsoft\Edge\Application\msedge.exe') }
$browser = ""
foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $browser = $c; break } }
if (-not $browser) { Stop-With "没找到 Chrome / Edge" "用 -BrowserPath 或环境变量 NTS_BROWSER_PATH 指定 chrome.exe 的完整路径（chrome-headless-shell 也可）。" }
Write-Host ("浏览器: " + $browser)

$nodeArgs = @($evalJs, "--url", $Url, "--js", $exprJs, "--wait", "!!window.NekoThemeStudio", "--chrome", $browser, "--port", "$Port")
$raw  = & node $nodeArgs 2>&1
$code = $LASTEXITCODE
$text = ($raw | Out-String)
if ($OutFile) { $text | Set-Content -Path $OutFile -Encoding UTF8; Write-Host ("原始输出已写入 " + $OutFile) }

$i = $text.IndexOf("{")
if ($i -lt 0) { Write-Host $text; Stop-With "没有拿到 JSON 输出" ("page-eval.js 退出码 " + $code) }
$jsonText = $text.Substring($i)
$j = $jsonText.LastIndexOf("}")
if ($j -gt 0) { $jsonText = $jsonText.Substring(0, $j + 1) }
try { $r = $jsonText | ConvertFrom-Json } catch { Write-Host $jsonText; Stop-With "输出不是合法 JSON" "把上面内容整段发回即可。" }

$vc = "Yellow"
if ($r.verdict -eq "CHAIN OK") { $vc = "Green" }
Write-Host ""
Write-Host ("verdict : " + $r.verdict) -ForegroundColor $vc
if ($r.mode)   { Write-Host ("模式    : " + $r.mode) }
if ($r.counts) { Write-Host ("调色板  : 亮色 " + $r.counts.light + " 项 / 暗色 " + $r.counts.dark + " 项") }
Write-Host ""
foreach ($c in $r.checks) {
  if ($c.ok) { Write-Host ("[ok]   " + $c.name + " :: " + $c.detail) -ForegroundColor Gray }
  else {
    Write-Host ("[FAIL] " + $c.name + " :: " + $c.detail) -ForegroundColor Red
    if ($c.fix) { Write-Host ("       -> " + $c.fix) -ForegroundColor Yellow }
  }
}
Write-Host ""
if ($r.verdict -eq "CHAIN OK") {
  Write-Host "链路通：磁盘上的 theme.json 能被 loader 应用，元素颜色与配置一致。" -ForegroundColor Green
  Write-Host "注意无头浏览器是干净环境（默认亮色、无缓存），与你当前窗口的模式可能不同。"
  exit 0
} else {
  Write-Host ("断点： " + $r.verdict) -ForegroundColor Red
  Write-Host "把这份输出整段发回即可直接定位。" -ForegroundColor Yellow
  exit 1
}
