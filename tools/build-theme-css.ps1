<#
  build-theme-css.ps1 -- regenerate neko-theme-studio.css.

  Pipeline:  probe (real Chrome, light+dark)  ->  A/B measurement  ->  gen-css.js  ->  deploy  ->  verify

  This is the only supported way to produce the stylesheet.

  v3 note: the stylesheet carries NO fallback values. v1/v2 baked a measured "native"
  value into each declaration, but a synthetic fixture cannot measure the real page's
  computed value (the real cascade differs in at least four ways), so those fallbacks
  silently restyled unconfigured apps. Every rule is now gated on
  data-nts-l-<var> (light) / data-nts-d-<var> (dark), which makes
  "unconfigured == not loaded" structural instead of measured. The measurement step is
  now informational: it feeds the panel's reference values and the coverage harness.

  Usage (scripts in this repo are unsigned; do not teach -ExecutionPolicy Bypass):
      powershell -NoProfile -File build-theme-css.ps1              # regenerate + verify
      powershell -NoProfile -File build-theme-css.ps1 -SkipDeploy  # regenerate into build\ only
      If execution policy blocks the script, run it from an elevated PowerShell or sign it yourself.
  Exit: 0 = generated and zero-change invariant holds; 1 = regression; 2 = harness/setup failure
#>
[CmdletBinding()]
param(
  # 省略时从本脚本位置自动推断：tools\ 的上一级是 theme-studio\，再上一级是安装根
  [string]$AppRoot = '',
  [string]$Studio  = '',
  [switch]$SkipDeploy,
  [switch]$SkipVerify
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
# Build $node from $env:USERPROFILE rather than a literal path: this file must stay
# ASCII-only, because the repo is edited and run from Windows PowerShell 5.1, which
# mis-decodes BOM-less UTF-8 and turns a literal non-ASCII user name into garbage.
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'node.exe not found' }
}

. (Join-Path $Studio 'test\probe.ps1')

$buildDir = Join-Path $Studio 'build'
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

Write-Host '== [1/5] measure native computed styles (real Chrome, no --nts-* set) =='
Assert-NtsServices | Out-Null
$lightJson = Join-Path $buildDir 'native-light.json'
$darkJson  = Join-Path $buildDir 'native-dark.json'

$rl = Invoke-NtsProbe -Mode native -Theme light -Tag 'native-light'
$rd = Invoke-NtsProbe -Mode native -Theme dark  -Tag 'native-dark'
[System.IO.File]::WriteAllText($lightJson, ($rl | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($darkJson,  ($rd | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("   light rows={0}  dark rows={1}" -f $rl.rows.Count, $rd.rows.Count)

# Fail loudly on selector/fixture drift instead of silently emitting a wrong fallback.
foreach ($pair in @(@($rl, 'light'), @($rd, 'dark'))) {
  $r = $pair[0]; $which = $pair[1]
  foreach ($kind in @('MISSING-ELEMENT', 'BAD-SELECTOR', 'EMPTY', 'UNQUERYABLE', 'NO-PSEUDO-STATE')) {
    $n = $r.unavailable.$kind
    if ($n -and @($n).Count -gt 0) {
      Write-Host ("   [{0}] {1}: {2}" -f $which, $kind, (($n -join '; ')))
    }
  }
}

Write-Host ''
Write-Host '== [2/5] real-page A/B baseline (EVIDENCE ONLY -- v3 has no fallbacks to veto) =='
# History: v1/v2 baked a measured native value into every declaration and claimed that an
# unset variable would resolve to the native value. An independent verifier proved that
# false on the real page (4+ counterexamples), because a synthetic fixture cannot reproduce
# the app's cascade: the real <body> carries .electron-chat-window (disabling a whole
# `body:not(.electron-chat-window) ...` rule), .chat-body sits under
# .chat-surface-mode-compact (where a later equally-specific rule wins), and the app injects
# a runtime <style> layer with !important that no fixture can see.
#
# v3 therefore emits NO fallbacks at all: every rule is gated per (mode, variable) on
# data-nts-l-* / data-nts-d-* attributes, so "unconfigured" is constructively "no rule
# matches". Nothing needs vetoing any more.
#
# This step is kept as a MEASUREMENT for the report, and step [5/5] is the gate that
# matters. A non-zero diff count here is expected to be zero; if it is not, the invariant
# is broken and step [5/5] will fail the build.
$abJson = Join-Path $buildDir 'ab.json'
$evalJs = Join-Path $Studio 'tools\page-eval.js'
$abExpr = Join-Path $Studio 'test\expr-realab.js'
$abOut  = Join-Path $env:TEMP 'nts_ab_build.json'
Remove-Item $abOut -Force -ErrorAction SilentlyContinue

# A/B is only meaningful with an EMPTY palette (otherwise every diff is the user's own colour).
Invoke-NtsPaletteReset | Out-Null
& $node $evalJs --url 'http://127.0.0.1:48911/chat' --js $abExpr --port 9401 2>$null |
  Set-Content -LiteralPath $abOut -Encoding UTF8
if (-not (Test-Path $abOut)) { throw 'A/B harness produced no output (page-eval failed)' }
$abText = [System.IO.File]::ReadAllText($abOut)
$abText = $abText.Substring($abText.IndexOf('{'), $abText.LastIndexOf('}') - $abText.IndexOf('{') + 1)
[System.IO.File]::WriteAllText($abJson, $abText, (New-Object System.Text.UTF8Encoding($false)))
$ab = $abText | ConvertFrom-Json
Write-Host ("   verdict={0}  diffs={1}" -f $ab.verdict, $ab.diffCount)
if (-not $ab.paletteEmpty) { throw 'A/B ran with a NON-empty palette -- results are meaningless (reset it first)' }
foreach ($d in $ab.diffs) { Write-Host ("   [A/B] {0} {1} | {2} -> {3} (native {4})" -f $d.theme, $d.sel, $d.prop, $d.sheetOn, $d.sheetOff) }

Write-Host ''
Write-Host '== [3/5] generate css (every rule gated per mode+variable, zero fallbacks) =='
$outCss  = Join-Path $buildDir 'neko-theme-studio.css'
$outVars = Join-Path $buildDir 'vars.json'
& $node (Join-Path $Studio 'tools\gen-css.js') $lightJson $darkJson $outCss $outVars $abJson
if ($LASTEXITCODE -ne 0) { throw "gen-css.js failed ($LASTEXITCODE)" }

$gen = [System.IO.File]::ReadAllText($outCss)
if ($gen -match '\bnull\b|\bundefined\b') { throw 'generated CSS contains null/undefined -- generator bug' }
Write-Host ("   {0} bytes" -f $gen.Length)

if (-not $SkipDeploy) {
  Write-Host ''
  Write-Host '== [4/5] deploy =='
  $targets = @(
    (Join-Path $AppRoot 'resources\bin\static\css\neko-theme-studio.css'),
    (Join-Path $Studio  'app\css\neko-theme-studio.css'),
    (Join-Path $Studio  'app-patch\files\css\neko-theme-studio.css')
  )
  foreach ($t in $targets) {
    $dir = Split-Path -Parent $t
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Copy-Item -LiteralPath $outCss -Destination $t -Force
    Write-Host ("   -> {0}" -f $t)
  }
} else {
  Write-Host ''
  Write-Host '== [4/5] deploy skipped =='
}

if ($SkipVerify) { Remove-NtsFixture; return }

Write-Host ''
Write-Host '== [5/5] verify =='
& (Join-Path $Studio 'test\run-tests.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# The real-page A/B must end at ZERO diffs: that is the actual promise we ship
# ("an empty palette is byte-identical to not loading this sheet").
& $node $evalJs --url 'http://127.0.0.1:48911/chat' --js $abExpr --port 9403 2>$null |
  Set-Content -LiteralPath $abOut -Encoding UTF8
$t = [System.IO.File]::ReadAllText($abOut)
$t = $t.Substring($t.IndexOf('{'), $t.LastIndexOf('}') - $t.IndexOf('{') + 1)
$ab2 = $t | ConvertFrom-Json
foreach ($d in $ab2.diffs) { Write-Host ("   [A/B] {0} {1} | {2} -> {3} (native {4})" -f $d.theme, $d.sel, $d.prop, $d.sheetOn, $d.sheetOff) }
Write-Host ("   real-page zero-change: {0} ({1} diff(s))" -f $ab2.verdict, $ab2.diffCount)
if ($ab2.verdict -ne 'PASS') { Write-Host 'FAIL -- deployed stylesheet still changes the unconfigured app'; exit 1 }
exit 0
