#requires -version 5.1
<#
.SYNOPSIS
    Read-only consistency check between the theme-studio source tree and an
    installed N.E.K.O application directory.

.DESCRIPTION
    Verifies (no file is ever written):
      1. source plugin/static/loader/neko-theme-studio.js is byte-identical to
         <AppRoot>\resources\bin\static\neko-theme-studio.js (sha256);
      2. source plugin/static/loader/neko-theme-studio.css is byte-identical to
         <AppRoot>\resources\bin\static\css\neko-theme-studio.css (sha256);
      3. the deployed loader's SCRIPT_VERSION equals the source loader's;
      4. exactly 23 templates carry the dark-mode.css anchor and each one has
         exactly one NTS:BEGIN and one NTS:END marker;
      5. the deployed static files exist and their sizes equal the source sizes.

    Prints a PASS/FAIL table and exits 1 when any check fails. Used by CI and by
    the installer's post-install verification path; it never modifies the host.

.PARAMETER AppRoot
    Installed N.E.K.O root (contains N.E.K.O.exe). Default: D:\be

.PARAMETER ThemeRoot
    theme-studio source checkout. Default: <AppRoot>\theme-studio

.PARAMETER ExpectedTemplateCount
    Number of app templates that must carry the NTS anchor. Default: 23

.EXAMPLE
    powershell -NoProfile -File tools\verify-static.ps1
    powershell -NoProfile -File tools\verify-static.ps1 -AppRoot D:\be
#>
[CmdletBinding()]
param(
    [string]$AppRoot = 'D:\be',
    [string]$ThemeRoot = '',
    [int]$ExpectedTemplateCount = 23
)

$ErrorActionPreference = 'Stop'

function New-CheckRow {
    param([string]$Check, [string]$Expected, [string]$Actual, [bool]$Pass)
    [pscustomobject]@{
        Check    = $Check
        Expected = $Expected
        Actual   = $Actual
        Result   = $(if ($Pass) { 'PASS' } else { 'FAIL' })
    }
}

function Add-Check {
    param([string]$Check, [string]$Expected, [string]$Actual, [bool]$Pass)
    [void]$script:rows.Add((New-CheckRow -Check $Check -Expected $Expected -Actual $Actual -Pass $Pass))
}

function Get-Sha256Text {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-FileSizeOrMinusOne {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return (Get-Item -LiteralPath $Path).Length }
    return -1
}

function Get-ScriptVersion {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $text = [System.IO.File]::ReadAllText($Path)
    $m = [regex]::Match($text, "SCRIPT_VERSION\s*=\s*'([0-9]+(?:\.[0-9]+)*)'")
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

$script:rows = New-Object System.Collections.ArrayList
$appFull = [System.IO.Path]::GetFullPath($AppRoot)
if ([string]::IsNullOrWhiteSpace($ThemeRoot)) {
    # 仓库默认取脚本所在的 theme-studio（tools\ 的上一级），而不是 <AppRoot>\theme-studio：
    # 本机实测 N.E.K.O 装在 D:\o、仓库在 D:\be\theme-studio，按 AppRoot 推会误报「源缺失」。
    $repoCandidate = Split-Path -Parent $PSScriptRoot
    if ($repoCandidate -and (Test-Path -LiteralPath (Join-Path $repoCandidate 'plugin\static\loader\neko-theme-studio.js') -PathType Leaf)) {
        $themeFull = [System.IO.Path]::GetFullPath($repoCandidate)
    } else {
        $themeFull = Join-Path $appFull 'theme-studio'
    }
} else {
    $themeFull = [System.IO.Path]::GetFullPath($ThemeRoot)
}

$srcLoaderDir = Join-Path $themeFull 'plugin\static\loader'
$srcJs = Join-Path $srcLoaderDir 'neko-theme-studio.js'
$srcCss = Join-Path $srcLoaderDir 'neko-theme-studio.css'
$staticDir = Join-Path $appFull 'resources\bin\static'
$depJs = Join-Path $staticDir 'neko-theme-studio.js'
$depCss = Join-Path $staticDir 'css\neko-theme-studio.css'
$templateDir = Join-Path $appFull 'resources\bin\templates'

# ---- 0. source checkout present ------------------------------------------
Add-Check 'theme-studio source' $themeFull $(if (Test-Path -LiteralPath $themeFull -PathType Container) { 'found' } else { '(missing)' }) (Test-Path -LiteralPath $themeFull -PathType Container)

# ---- 1/2. byte identity of the two deployed assets -----------------------
$srcJsSha = Get-Sha256Text $srcJs
$depJsSha = Get-Sha256Text $depJs
Add-Check 'loader js sha256 (src vs deployed)' $(if ($srcJsSha) { $srcJsSha.Substring(0, 12) } else { '(source missing)' }) $(if ($depJsSha) { $depJsSha.Substring(0, 12) } else { '(deployed missing)' }) ($srcJsSha -ne '' -and $srcJsSha -eq $depJsSha)

$srcCssSha = Get-Sha256Text $srcCss
$depCssSha = Get-Sha256Text $depCss
Add-Check 'loader css sha256 (src vs deployed)' $(if ($srcCssSha) { $srcCssSha.Substring(0, 12) } else { '(source missing)' }) $(if ($depCssSha) { $depCssSha.Substring(0, 12) } else { '(deployed missing)' }) ($srcCssSha -ne '' -and $srcCssSha -eq $depCssSha)

# ---- 3. deployed SCRIPT_VERSION follows the source -----------------------
$srcVer = Get-ScriptVersion $srcJs
$depVer = Get-ScriptVersion $depJs
Add-Check 'deployed SCRIPT_VERSION' $(if ($srcVer) { "= source $srcVer" } else { '(source version not found)' }) $(if ($depVer) { $depVer } else { '(not found)' }) ($srcVer -ne '' -and $srcVer -eq $depVer)

# ---- 4. template markers -------------------------------------------------
if (-not (Test-Path -LiteralPath $templateDir -PathType Container)) {
    Add-Check 'template NTS markers' "$ExpectedTemplateCount anchor templates" '(template dir missing)' $false
} else {
    $templates = @(Get-ChildItem -LiteralPath $templateDir -Filter '*.html' -File)
    $anchors = @()
    foreach ($t in $templates) {
        $text = [System.IO.File]::ReadAllText($t.FullName)
        if ($text.Contains('dark-mode.css')) { $anchors += $t }
    }
    $badMarkers = @()
    foreach ($t in $anchors) {
        $text = [System.IO.File]::ReadAllText($t.FullName)
        $begin = ([regex]::Matches($text, 'NTS:BEGIN')).Count
        $end = ([regex]::Matches($text, 'NTS:END')).Count
        if ($begin -ne 1 -or $end -ne 1) {
            $badMarkers += ('{0} (BEGIN={1} END={2})' -f $t.Name, $begin, $end)
        }
    }
    $markerOk = ($anchors.Count -eq $ExpectedTemplateCount) -and ($badMarkers.Count -eq 0)
    $actual = '{0} anchor template(s), marker problems: {1}' -f $anchors.Count, $badMarkers.Count
    if ($badMarkers.Count -gt 0) { $actual += ' [' + ($badMarkers -join '; ') + ']' }
    Add-Check 'template NTS markers' "$ExpectedTemplateCount anchors, each NTS:BEGIN/END exactly once" $actual $markerOk
    Add-Check 'template inventory' '(informational)' "$($templates.Count) html files / $($anchors.Count) anchored" $true
}

# ---- 5. deployed static file presence and size --------------------------
$depJsSize = Get-FileSizeOrMinusOne $depJs
$depCssSize = Get-FileSizeOrMinusOne $depCss
$srcJsSize = Get-FileSizeOrMinusOne $srcJs
$srcCssSize = Get-FileSizeOrMinusOne $srcCss
$sizeOk = ($depJsSize -gt 0) -and ($depCssSize -gt 0) -and ($depJsSize -eq $srcJsSize) -and ($depCssSize -eq $srcCssSize)
Add-Check 'deployed static files (size)' "js $srcJsSize B / css $srcCssSize B" "js $depJsSize B / css $depCssSize B" $sizeOk

# ---- report --------------------------------------------------------------
''
"AppRoot : $appFull"
"ThemeRoot: $themeFull"
''
$script:rows | Format-Table -AutoSize -Wrap | Out-String -Width 240 | Write-Host
$failed = @($script:rows | Where-Object { $_.Result -eq 'FAIL' })
if ($failed.Count -gt 0) {
    Write-Host ("FAIL: {0} check(s) failed. The deployed host is out of sync with {1}." -f $failed.Count, $themeFull) -ForegroundColor Red
    exit 1
}
Write-Host 'PASS: source and deployed host are in sync.' -ForegroundColor Green
exit 0
