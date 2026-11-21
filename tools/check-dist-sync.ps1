#requires -version 5.1
<#
.SYNOPSIS
    Verify that the distribution zip in -OutDir is byte-identical to the working tree.

.DESCRIPTION
    发布物漂移是「用户装的东西和仓库里的东西不是同一份」这类 bug 的根源
    （_review/audit28-pack.md 的 P1-G：dist 里的 zip 与源码不一致，却没有任何
    检查会发现）。

    本脚本只读：打开 <OutDir>\neko-theme-studio-<version>.zip，逐条与仓库文件比
    sha256，并检查：
      * 版本号（zip 内 plugin/plugin.toml）== 当前 plugin.toml
      * 每一条 zip 条目在仓库里都存在且字节一致
      * 仓库里该发布的白名单文件没有漏进 zip（用 package-dist.ps1 的同一份清单）
      * .sha256 文件与 zip 实际哈希一致

    不一致时退出码 1，并逐条列出。

.PARAMETER OutDir
    发布目录。默认 <repo>\dist

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-dist-sync.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $repoRoot 'dist' }

function Write-Ok([string]$Text) { Write-Host "  OK    $Text" -ForegroundColor Green }
function Write-Bad([string]$Text) { Write-Host "  DRIFT $Text" -ForegroundColor Red }

$tomlPath = Join-Path $repoRoot 'plugin\plugin.toml'
if (-not (Test-Path -LiteralPath $tomlPath -PathType Leaf)) {
    Write-Host 'FAIL: plugin/plugin.toml not found' -ForegroundColor Red
    exit 1
}
$tomlText = [System.IO.File]::ReadAllText($tomlPath)
$verMatch = [regex]::Match($tomlText, '(?m)^\s*version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)"')
if (-not $verMatch.Success) {
    Write-Host 'FAIL: plugin/plugin.toml has no semantic version' -ForegroundColor Red
    exit 1
}
$version = $verMatch.Groups[1].Value
$zipName = "neko-theme-studio-$version.zip"
$zipPath = Join-Path $OutDir $zipName
$shaPath = Join-Path $OutDir ($zipName -replace '\.zip$', '.sha256')

if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    Write-Host "FAIL: 找不到 $zipPath（先跑 tools\package-dist.ps1）" -ForegroundColor Red
    exit 1
}

$problems = New-Object System.Collections.ArrayList

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    Write-Host ("zip: {0}（{1} 条 / {2} 字节），源码版本 {3}" -f $zipName, $zip.Entries.Count, (Get-Item -LiteralPath $zipPath).Length, $version)

    foreach ($entry in $zip.Entries) {
        $rel = $entry.FullName
        $abs = Join-Path $repoRoot ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) {
            [void]$problems.Add("zip 里有仓库不存在的文件：$rel")
            continue
        }
        $stream = $entry.Open()
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $hash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
        } finally {
            $stream.Dispose()
        }
        $diskHash = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $diskHash) {
            [void]$problems.Add("内容不一致（zip vs 源码）：$rel")
        }
    }
} finally {
    $zip.Dispose()
}

# 版本自洽：zip 内的 plugin.toml 也应写着同一个版本。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip2 = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entry = $zip2.Entries | Where-Object { $_.FullName -eq 'plugin/plugin.toml' } | Select-Object -First 1
    if (-not $entry) {
        [void]$problems.Add('zip 里没有 plugin/plugin.toml')
    } else {
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { $innerToml = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($innerToml -notmatch ('(?m)^\s*version\s*=\s*"' + [regex]::Escape($version) + '"')) {
            [void]$problems.Add("zip 内 plugin.toml 的版本不是 $version")
        }
    }
} finally {
    $zip2.Dispose()
}

# .sha256 与 zip 实际哈希。
if (Test-Path -LiteralPath $shaPath -PathType Leaf) {
    $declared = ([System.IO.File]::ReadAllText($shaPath)).Split(' ')[0].Trim().ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($declared -ne $actual) { [void]$problems.Add(".sha256 与实际 zip 不一致：$declared != $actual") }
} else {
    [void]$problems.Add("缺少 .sha256：$shaPath")
}

if ($problems.Count -eq 0) {
    Write-Ok "dist 与源码完全一致（$($zipName)）"
    exit 0
}
foreach ($p in $problems) { Write-Bad $p }
Write-Host ("FAIL: {0} 处漂移 —— 重新跑 tools\package-dist.ps1 再发布。" -f $problems.Count) -ForegroundColor Red
exit 1
