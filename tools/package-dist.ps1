#Requires -Version 5.1
<#
.SYNOPSIS
  把 theme-studio 打成可分发 zip（dist\neko-theme-studio-<版本>.zip）。

.DESCRIPTION
  只打包「用户真正需要的东西」：安装脚本、应用侧两件套、插件源、文档、测试与工具。
  刻意排除：dist\（避免自我嵌套）、_work\（探针草稿）、backup\（本机备份产物）、
  build\（中间 JSON）、__pycache__\、*.pyc、以及所有 .bak / .meta.json。

  zip 内只有唯一的顶层目录 theme-studio\，解压到 N.E.K.O 安装根即可与原目录同构。

.PARAMETER OutDir
  输出目录，默认 <ThemeRoot>\dist。
.PARAMETER IncludePackage
  若 .neko-plugin 构建产物存在，一并放进 zip 根（便于绕过 install.ps1 手工导入）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\package-dist.ps1
#>
[CmdletBinding()]
param(
  [string]$ThemeRoot,
  [string]$OutDir,
  [switch]$IncludePackage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

if (-not $ThemeRoot) {
  $here = $PSScriptRoot
  if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $ThemeRoot = Split-Path -Parent $here
}

if (-not $OutDir) { $OutDir = Join-Path $ThemeRoot 'dist' }

function Write-Step([string]$Text) { Write-Host "  $Text" }
function Write-Fail([string]$Text) { Write-Host "  $Text" -ForegroundColor Red }

# ---- 版本号：只认 plugin.toml ----------------------------------------------
$TomlPath = Join-Path $ThemeRoot 'plugin\plugin.toml'
if (-not (Test-Path -LiteralPath $TomlPath)) {
  Write-Fail "找不到 $TomlPath"
  exit 1
}
$TomlText = Get-Content -LiteralPath $TomlPath -Raw -Encoding UTF8
$m = [regex]::Match($TomlText, '(?m)^\s*version\s*=\s*"([^"]+)"')
if (-not $m.Success) {
  Write-Fail 'plugin.toml 里没有 version 字段'
  exit 1
}
$Version = $m.Groups[1].Value

Write-Host ''
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  打包 theme-studio v$Version" -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan

# ---- 收集文件 --------------------------------------------------------------
$ExcludeDirs  = @('dist', '_work', 'backup', 'build', '__pycache__', '.git', 'node_modules')
$ExcludeExt   = @('.pyc', '.bak', '.pyo')
$ExcludeNames = @('.DS_Store', 'Thumbs.db')

$files = New-Object System.Collections.Generic.List[object]
$skipped = 0

foreach ($f in (Get-ChildItem -LiteralPath $ThemeRoot -Recurse -File -Force)) {
  $rel = $f.FullName.Substring($ThemeRoot.Length).TrimStart('\')
  $parts = $rel -split '\\'
  $drop = $false
  foreach ($p in $parts) { if ($ExcludeDirs -contains $p) { $drop = $true; break } }
  if (-not $drop -and ($ExcludeExt -contains $f.Extension)) { $drop = $true }
  if (-not $drop -and ($ExcludeNames -contains $f.Name)) { $drop = $true }
  if (-not $drop -and $f.Name -like '*.meta.json') { $drop = $true }
  if ($drop) { $skipped++; continue }
  $files.Add([pscustomobject]@{ Full = $f.FullName; Rel = $rel; Size = $f.Length })
}

if ($files.Count -eq 0) {
  Write-Fail '没有可打包的文件'
  exit 1
}

# ---- 写 zip ----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$ZipPath = Join-Path $OutDir "neko-theme-studio-$Version.zip"
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$fs = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::CreateNew)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($item in $files) {
      $entryName = 'theme-studio/' + ($item.Rel -replace '\\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $item.Full, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }

    if ($IncludePackage) {
      $pkg = Join-Path $env:LOCALAPPDATA 'N.E.K.O\.neko-plugin-packages\neko_theme_studio.neko-plugin'
      if (Test-Path -LiteralPath $pkg) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $zip, $pkg, 'theme-studio/neko_theme_studio.neko-plugin', [System.IO.Compression.CompressionLevel]::Optimal)
        Write-Step '已附上预构建的 neko_theme_studio.neko-plugin'
      } else {
        Write-Step '（未附 .neko-plugin：构建产物不存在，忽略）'
      }
    }
  } finally { $zip.Dispose() }
} finally { $fs.Dispose() }

$size = (Get-Item -LiteralPath $ZipPath).Length
$count = $files.Count
if ($IncludePackage) { $count++ }

$kb = [math]::Round($size / 1KB, 0)
Write-Host ''
Write-Step "打包完成：$ZipPath"
Write-Step "  $count 个文件，$kb KB（跳过 $skipped 个排除项）"

# ---- 自检：关键文件必须在包里 ----------------------------------------------
$must = @(
  'theme-studio/install.ps1',
  'theme-studio/uninstall.ps1',
  'theme-studio/plugin/plugin.toml',
  'theme-studio/plugin/__init__.py',
  'theme-studio/plugin/_app_patch.py',
  'theme-studio/plugin/static/app.js',
  'theme-studio/plugin/static/index.html',
  'theme-studio/plugin/static/loader/neko-theme-studio.js',
  'theme-studio/plugin/static/loader/neko-theme-studio.css',
  'theme-studio/app/neko-theme-studio.js',
  'theme-studio/app/css/neko-theme-studio.css',
  'theme-studio/THEME_CONTRACT.md',
  'theme-studio/TROUBLESHOOT.md',
  'theme-studio/DISTRIBUTION.md',
  'theme-studio/test/accept.ps1'
)

$zr = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  $names = @{}
  foreach ($e in $zr.Entries) { $names[$e.FullName] = $true }
  $missing = @()
  foreach ($k in $must) { if (-not $names.ContainsKey($k)) { $missing += $k } }
} finally { $zr.Dispose() }

if ($missing.Count -gt 0) {
  Write-Host ''
  Write-Fail '❌ 缺少关键文件：'
  foreach ($k in $missing) { Write-Fail "   $k" }
  exit 1
}

Write-Step '✅ 关键文件齐全'
Write-Host ''
Write-Host "  解压：Expand-Archive '$ZipPath' -DestinationPath '<N.E.K.O 安装根>' -Force" -ForegroundColor DarkGray
Write-Host "  安装：powershell -NoProfile -ExecutionPolicy Bypass -File '<安装根>\theme-studio\install.ps1'" -ForegroundColor DarkGray
Write-Host ''
exit 0