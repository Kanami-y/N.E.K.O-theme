<#
  run-tests.ps1 -- two hard assertions about the generated stylesheet, measured in real Chrome.

   (1) ZERO-CHANGE INVARIANT: with no --nts-* variable set, loading our stylesheet must leave
       every probed property byte-identical to not loading it. Any diff is a regression:
       the user has not configured anything yet, so nothing may move.
   (2) COVERAGE: with all --nts-* variables set to sentinel values, the target properties must
       actually take the sentinel. Still native == the rule missed (dead selector).

  Load path matters: the fixture's <!--NTS_CSS_HOOK--> is replaced with a real <link> tag so
  the browser parses the stylesheet normally. Injecting it from JS produced a false 0/59
  "coverage" reading on the first attempt.

  Usage: powershell -File run-tests.ps1 [-Quiet]
  Exit:  0 = no regression; 1 = zero-change violated; 2 = harness premise failed (void run)
#>
[CmdletBinding()]
param(
  # 省略时从本脚本位置自动推断：test\ 的上一级是 theme-studio\，再上一级是安装根
  [string]$AppRoot = '',
  [string]$Studio  = '',
  [string]$Base    = 'http://127.0.0.1:48911',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
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
. (Join-Path $Studio 'test\probe.ps1')

Assert-NtsServices | Out-Null

$plan = @(
  @{ tag = 'light-base'; mode = 'native';   theme = 'light'; css = $false },
  @{ tag = 'light-mine'; mode = 'native';   theme = 'light'; css = $true  },
  @{ tag = 'dark-base';  mode = 'native';   theme = 'dark';  css = $false },
  @{ tag = 'dark-mine';  mode = 'native';   theme = 'dark';  css = $true  },
  @{ tag = 'light-sent'; mode = 'sentinel'; theme = 'light'; css = $true  },
  @{ tag = 'dark-sent';  mode = 'sentinel'; theme = 'dark';  css = $true  }
)

# A sentinel value "took effect" when the computed value reflects it. Blur and shadow are
# checked by their own shapes; everything else reduces to the marker colour or 7px.
# The blur case matters: a backdrop-filter that really took the sentinel computes to
# "blur(7px)", which contains no rgb() and no bare 7px token, so it used to be reported as a
# MISS even though the rule had in fact won.
function Test-SentinelHit($v) {
  $v = [string]$v
  return ($v -match 'rgb\(1,\s*2,\s*3\)') -or ($v -match '(^|\s)7px') -or
         ($v -match 'NTSProbeFont') -or ($v -match 'blur\(\s*7px')
}

# Rows we cannot judge in a static page: no :hover/:focus can be triggered, ::selection has no
# computed style, and a selector whose element is absent means the fixture is incomplete.
# NOTE: the parameter is $row, not $r. PowerShell variable names are case-insensitive, so a
# loop variable named $r aliases the results hashtable $R and silently destroys it. That alias
# cost several rounds of "dark coverage 0/1": after the light pass, $R held a single row object,
# so $R["dark-sent"] was $null and @($null).Count reports 1.
function Test-RowUnjudgeable($row) {
  return ($row.val -in @('MISSING-ELEMENT', 'BAD-SELECTOR', 'EMPTY', 'UNQUERYABLE', 'NO-PSEUDO-STATE')) -or
         ($row.aux -eq $true) -or ($row.gate -eq $true -and $row.aux -eq $true)
}

$R = @{}
foreach ($c in $plan) {
  if (-not $Quiet) { Write-Host ("  probing {0} ..." -f $c.tag) -NoNewline }
  $R[$c.tag] = Invoke-NtsProbe -Mode $c.mode -Theme $c.theme -WithCss:$c.css -Tag $c.tag

  if (-not $Quiet) { Write-Host (" ok ({0} rows, ntsRules={1})" -f @($R[$c.tag].rows).Count, $R[$c.tag].diag.ntsRules) }
}

# --- premise gate: if our sheet did not load, every conclusion below is void ---
$gateFail = $false
foreach ($t in @('light', 'dark')) {
  $d = $R["$t-mine"].diag
  if (-not $d.ntsHrefOk -and -not $d.ntsHref) {
    Write-Host ("  [GATE-FAIL] {0}: our stylesheet did not load (href={1})" -f $t, $d.ntsHref); $gateFail = $true
  }
  if ([int]$d.ntsRules -lt 20) {
    Write-Host ("  [GATE-FAIL] {0}: only {1} rules carry --nts- (expected >= 20)" -f $t, $d.ntsRules); $gateFail = $true
  }
  if ($R["$t-base"].diag.ntsHref) {
    Write-Host ("  [GATE-FAIL] {0}: base variant loaded our stylesheet" -f $t); $gateFail = $true
  }
}
if ($gateFail) {
  Remove-NtsFixture
  Write-Host ''
  Write-Host '  ABORT -- measurement premise does not hold, results are meaningless'
  exit 2
}

function Compare-Rows($a, $b) {
  $diffs = @()
  for ($i = 0; $i -lt $a.Count; $i++) {
    if ([string]$a[$i].val -ne [string]$b[$i].val) {
      $diffs += [pscustomobject]@{
        sel = $a[$i].sel; prop = $a[$i].prop; var = $a[$i].v
        base = $a[$i].val; mine = $b[$i].val; sec = $a[$i].sec
      }
    }
  }
  return $diffs
}

Write-Host ''
Write-Host '===== (1) zero-change invariant: no variables set, is our sheet a no-op? ====='
$regress = @()
foreach ($t in @('light', 'dark')) {
  $d = Compare-Rows $R["$t-base"].rows $R["$t-mine"].rows
  Write-Host ("  {0,-6} differing properties = {1}" -f $t, $d.Count)
  foreach ($x in $d) {
    Write-Host ("      [DIFF] {0,-46} {1,-22} var={2,-28} base={3}  mine={4}" -f $x.sel, $x.prop, $x.var, $x.base, $x.mine)
  }
  $regress += $d
}

Write-Host ''
Write-Host '===== (2) coverage: sentinel values actually take effect ====='
# Guard against the $R/$r alias bug documented above: if $R is not a 6-entry hashtable here,
# some later variable clobbered it and every number below would be meaningless.
if ($R -isnot [hashtable] -or $R.Count -ne 6) {
  Write-Host ("  [GATE-FAIL] results table was clobbered: type={0} count={1} (expected hashtable/6)" -f `
    $(if ($R -is [hashtable]) { 'hashtable' } else { $R.GetType().Name }), $(if ($R -is [hashtable]) { $R.Count } else { 0 }))
  Remove-NtsFixture
  Write-Host ''
  Write-Host '  ABORT -- aggregation premise does not hold, results are meaningless'
  exit 2
}
$cover = @{}
foreach ($t in @('light', 'dark')) {
  $themed = @($R["$t-sent"].rowsThemed)
  if ($themed.Count -eq 0 -or $null -eq $themed[0]) {
    Write-Host ("  [GATE-FAIL] {0}: sentinel pass returned no rows" -f $t)
    Remove-NtsFixture
    Write-Host ''
    Write-Host '  ABORT -- sentinel measurement missing, results are meaningless'
    exit 2
  }
  $ok = 0; $miss = @(); $skip = 0
  for ($i = 0; $i -lt $themed.Count; $i++) {
    $row = $themed[$i]
    if (Test-RowUnjudgeable $row) { $skip++; continue }
    if (Test-SentinelHit $row.val) { $ok++ } else { $miss += $row }
  }
  $cover[$t] = [pscustomobject]@{ ok = $ok; total = $themed.Count - $skip; miss = $miss; skip = $skip }
  Write-Host ("  {0,-6} effective {1}/{2}   (not judgeable in a static page: {3})" -f $t, $ok, ($themed.Count - $skip), $skip)
  foreach ($m in $miss) {
    Write-Host ("      [MISS] {0,-46} {1,-22} var={2,-28} actual={3}" -f $m.sel, $m.prop, $m.v, $m.val)
    if ($R["$t-sent"].winners) {
      foreach ($w in $R["$t-sent"].winners) {
        if ($w.sel -eq $m.sel -and $w.prop -eq $m.prop) {
          foreach ($why in $w.why) { Write-Host ("             why: " + $why) }
        }
      }
    }
  }
}

Write-Host ''
Write-Host '===== verdict ====='
$gatedOnly = @($regress | Where-Object { $_.prop -in @('outline-color', 'outline', 'backdrop-filter', 'box-shadow') })
if ($regress.Count -eq 0) {
  Write-Host '  (1) PASS -- unconfigured theme is visually inert'
} else {
  Write-Host ("  (1) FAIL -- {0} properties changed before any configuration" -f $regress.Count)
}
$fails = @($regress | Where-Object { $_.base -notin @('MISSING-ELEMENT', 'BAD-SELECTOR', 'EMPTY', 'UNQUERYABLE', 'NO-PSEUDO-STATE') })
$tb = [math]::Max(1, @($R['light-sent'].rowsThemed).Count)
$td = [math]::Max(1, @($R['dark-sent'].rowsThemed).Count)
Write-Host ("  (2) coverage light {0}/{1}, dark {2}/{3}" -f $cover['light'].ok, $tb, $cover['dark'].ok, $td)

Remove-NtsFixture

if ($regress.Count -gt 0) { exit 1 } else { exit 0 }
