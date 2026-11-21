#requires -version 5.1
<#
.SYNOPSIS
    Build a deterministic, whitelisted distribution zip of the theme studio.

.DESCRIPTION
    Outputs (into -OutDir, default <repo>\dist):
      neko-theme-studio-<version>.zip   deterministic zip (entries sorted by path,
                                        fixed 1980-01-01 timestamps, '/' separators)
      neko-theme-studio-<version>.sha256  sha256 of the zip actually written
      MANIFEST.json                     per-file sha256 + size of the zip contents

    Determinism: running the script twice on the same inputs produces the same
    zip bytes and therefore the same .sha256. No timestamps, machine names or
    absolute paths are embedded.

    Package whitelist:
      plugin/plugin.toml, plugin/__init__.py, plugin/_app_patch.py,
      plugin/materials.py, plugin/build_info.py, plugin/i18n/**,
      plugin/static/**,
      install.ps1, uninstall.ps1, root documentation (*.md),
      .neko-plugin/** (optional, when present)
    _app_patch.py / build_info.py / i18n are runtime necessities of
    plugin/__init__.py and plugin.toml ([plugin.i18n]); they are shipped even
    though the original whitelist sketch only named plugin.toml/__init__.py.

    Excluded everywhere: __pycache__, *.pyc, *.pyo, *.tmp, .bak, _work, test,
    tools, research, app, app-patch, dist, backup, .git, node_modules.

.PARAMETER OutDir
    Output directory. Default: <repo>\dist

.PARAMETER SkipManifest
    Do not write MANIFEST.json.

.EXAMPLE
    powershell -NoProfile -File tools\package-dist.ps1
    powershell -NoProfile -File tools\package-dist.ps1 -OutDir $env:TEMP\dist-test
#>
[CmdletBinding()]
param(
    [string]$OutDir = '',
    [switch]$SkipManifest
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $repoRoot 'dist'
}

function Write-Step([string]$Text) { Write-Host "== $Text" }
function Write-Fail([string]$Text) { Write-Host "FAIL: $Text" -ForegroundColor Red }

# ---- version -------------------------------------------------------------
$tomlPath = Join-Path $repoRoot 'plugin\plugin.toml'
if (-not (Test-Path -LiteralPath $tomlPath -PathType Leaf)) {
    Write-Fail "missing plugin/plugin.toml under $repoRoot"
    exit 1
}
$tomlText = [System.IO.File]::ReadAllText($tomlPath)
$verMatch = [regex]::Match($tomlText, '(?m)^\s*version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)"')
if (-not $verMatch.Success) {
    Write-Fail 'plugin/plugin.toml has no semantic version'
    exit 1
}
$version = $verMatch.Groups[1].Value

# ---- explicit whitelist --------------------------------------------------
$rootFiles = @(
    'plugin/plugin.toml',
    'plugin/__init__.py',
    'plugin/_app_patch.py',
    'plugin/materials.py',
    'plugin/build_info.py',
    'plugin/README.md',
    'install.ps1',
    'uninstall.ps1',
    'README.md',
    'CHANGELOG.md',
    'DISTRIBUTION.md',
    'TROUBLESHOOT.md',
    'THEME_CONTRACT.md',
    'PARAMETER-REFERENCE.md',
    'AI-THEME-GUIDE.md',
    'USER-GUIDE.md'
)
$recursiveDirs = @(
    'plugin/static',
    'plugin/i18n'
)
$optionalRecursiveDirs = @(
    '.neko-plugin'
)

$requiredEntries = @(
    'plugin/plugin.toml',
    'plugin/__init__.py',
    'plugin/materials.py',
    'plugin/static/index.html',
    'plugin/static/app.js',
    'plugin/static/style.css',
    'plugin/static/materials.js',
    'plugin/static/materials.css',
    'plugin/static/theme.json',
    'plugin/static/loader/neko-theme-studio.js',
    'plugin/static/loader/neko-theme-studio.css',
    'install.ps1',
    'uninstall.ps1',
    'README.md',
    'CHANGELOG.md',
    'DISTRIBUTION.md',
    'USER-GUIDE.md'
)

$excludeDirNames = @('__pycache__', '_work', 'test', 'tools', 'research', 'app', 'app-patch', 'dist', 'backup', '.git', 'node_modules', '.github', '.vscode')
$excludeFilePatterns = @('*.pyc', '*.pyo', '*.tmp', '*.bak', '*.meta.json')

function Test-Excluded([string]$relPath) {
    $parts = $relPath -split '/'
    foreach ($p in $parts) {
        if ($excludeDirNames -contains $p) { return $true }
    }
    $leaf = $parts[$parts.Count - 1]
    foreach ($pattern in $excludeFilePatterns) {
        if ($leaf -like $pattern) { return $true }
    }
    return $false
}

$names = New-Object 'System.Collections.Generic.List[string]'
$sources = @{}
foreach ($rel in $rootFiles) {
    $abs = Join-Path $repoRoot ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $abs -PathType Leaf) {
        $names.Add($rel)
        $sources[$rel] = $abs
    }
}
foreach ($relDir in $recursiveDirs) {
    $absDir = Join-Path $repoRoot ($relDir -replace '/', '\')
    if (-not (Test-Path -LiteralPath $absDir -PathType Container)) { continue }
    Get-ChildItem -LiteralPath $absDir -Recurse -File | ForEach-Object {
        $rel = $relDir + '/' + $_.FullName.Substring($absDir.Length + 1).Replace('\', '/')
        if (-not (Test-Excluded $rel)) {
            $names.Add($rel)
            $sources[$rel] = $_.FullName
        }
    }
}
foreach ($relDir in $optionalRecursiveDirs) {
    $absDir = Join-Path $repoRoot ($relDir -replace '/', '\')
    if (-not (Test-Path -LiteralPath $absDir -PathType Container)) { continue }
    Get-ChildItem -LiteralPath $absDir -Recurse -File | ForEach-Object {
        $rel = $relDir + '/' + $_.FullName.Substring($absDir.Length + 1).Replace('\', '/')
        if (-not (Test-Excluded $rel)) {
            $names.Add($rel)
            $sources[$rel] = $_.FullName
        }
    }
}

$missing = @()
foreach ($req in $requiredEntries) {
    if (-not $sources.ContainsKey($req)) { $missing += $req }
}
if ($missing.Count -gt 0) {
    Write-Fail ('missing required package file(s): ' + ($missing -join ', '))
    exit 1
}

# ---- deterministic ordering (ordinal, never culture-dependent) ----------
$entryNames = $names.ToArray()
[System.Array]::Sort($entryNames, [System.StringComparer]::Ordinal)

# ---- build zip -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$zipName = "neko-theme-studio-$version.zip"
$zipPath = Join-Path $OutDir $zipName
$shaPath = Join-Path $OutDir ($zipName -replace '\.zip$', '.sha256')
$manifestPath = Join-Path $OutDir 'MANIFEST.json'

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

# DOS timestamps are local-time based; pin the *local* wall clock to 1980-01-01
# 00:00:00 so the archive bytes do not depend on the build machine's time zone.
$fixedTime = [DateTimeOffset]::new([DateTime]::new(1980, 1, 1, 0, 0, 0, [DateTimeKind]::Unspecified))
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$manifestFiles = New-Object System.Collections.ArrayList
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($rel in $entryNames) {
            $abs = $sources[$rel]
            $bytes = [System.IO.File]::ReadAllBytes($abs)
            $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $fixedTime
            $entryStream = $entry.Open()
            try {
                $entryStream.Write($bytes, 0, $bytes.Length)
            } finally {
                $entryStream.Dispose()
            }
            $fileHash = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLowerInvariant()
            [void]$manifestFiles.Add([pscustomobject]@{
                path   = $rel
                size   = $bytes.Length
                sha256 = $fileHash
            })
        }
    } finally {
        $archive.Dispose()
    }
} finally {
    $zipStream.Dispose()
}

# ---- sha256 of the actual zip bytes -------------------------------------
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($shaPath, "$zipHash  $zipName`n", $utf8NoBom)

if (-not $SkipManifest) {
    $manifest = [ordered]@{
        package   = $zipName
        version   = $version
        sha256    = $zipHash
        fileCount = $manifestFiles.Count
        files     = @($manifestFiles)
    }
    $json = $manifest | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($manifestPath, $json + "`n", $utf8NoBom)
}

# ---- self-verification: reopen and confirm contents ---------------------
$verifyErrors = New-Object System.Collections.ArrayList
$zipRead = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $actual = @($zipRead.Entries | ForEach-Object { $_.FullName })
    if ($actual.Count -ne $entryNames.Count) {
        [void]$verifyErrors.Add("entry count $($actual.Count) != expected $($entryNames.Count)")
    }
    $actualSorted = $actual.Clone()
    [System.Array]::Sort($actualSorted, [System.StringComparer]::Ordinal)
    for ($i = 0; $i -lt $entryNames.Count; $i++) {
        if ($actualSorted[$i] -ne $entryNames[$i]) {
            [void]$verifyErrors.Add("entry mismatch at $i : $($actualSorted[$i]) != $($entryNames[$i])")
            break
        }
    }
    foreach ($req in $requiredEntries) {
        if (-not ($actual -contains $req)) { [void]$verifyErrors.Add("required entry missing from zip: $req") }
    }
} finally {
    $zipRead.Dispose()
}

if ($verifyErrors.Count -gt 0) {
    $verifyErrors | ForEach-Object { Write-Fail $_ }
    exit 1
}

Write-Step "package v$version"
Write-Host ("zip     : {0}  ({1} bytes, {2} files)" -f $zipPath, (Get-Item -LiteralPath $zipPath).Length, $entryNames.Count)
Write-Host ("sha256  : {0}" -f $zipHash)
Write-Host ("sha file: {0}" -f $shaPath)
if (-not $SkipManifest) { Write-Host ("manifest: {0}" -f $manifestPath) }
Write-Host 'PASS: deterministic package built and verified.'
exit 0
