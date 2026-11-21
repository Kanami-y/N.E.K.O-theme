<#
.SYNOPSIS
    构建 N.E.K.O 官方插件包（*.neko-plugin）—— 单一文件，可直接交给「插件管理 → 从文件安装」。

.DESCRIPTION
    install.ps1 会把「构建产物」留在 %LOCALAPPDATA%\N.E.K.O\.neko-plugin-packages\ 里，但那份是
    **为了升级保住用户数据**而打的：它把你当前的调色板、上传的背景图一起塞进了包。分发给别人时，
    对方装完会看到你的主题 —— 所以需要一个干净的官方包。

    本脚本产出的包：
      * 源码来自仓库 plugin/（排除 __pycache__ / .git / tests / *.pyc 等开发产物）；
      * static\theme.json 重置为出厂默认（空调色板，装完是各主题的默认样子）；
      * 排除 static\backgrounds\ / static\themes\ / static\exports\ / static\schedule.json（运行期用户数据）；
      * 打包动作交给宿主自己的 /plugin-cli/build（manifest / metadata / payload 哈希与官方一致）；
      * 产物复制到 dist\ 并写 .sha256；
      * 用 /plugin-cli/install-plan 做一次只读校验（不安装、不改当前插件）。

    为什么用 _nts_pkg_staging 这个临时目录名：
    宿主的 root_id=user 只认 .neko-plugin-installations\plugins\<directory_name>\ 这一个来源，
    而这个目录同时也是**已安装插件所在目录**。直接写 neko_theme_studio 会覆盖正在用的插件，
    所以本脚本用一个临时名字暂存，构建完立刻删掉；包里最终路径由 plugin.toml 的 id 决定
    （payload/plugins/neko_theme_studio/、metadata paths=["neko_theme_studio"]），与目录名无关。

    ⚠ 需要 N.E.K.O 正在运行（插件服务 48916），且当前没有别的安装/升级在进行。

.PARAMETER NekoDataDir
    N.E.K.O 数据目录，默认 %LOCALAPPDATA%\N.E.K.O。

.PARAMETER OutDir
    产物目录，默认 <仓库>\dist。

.PARAMETER SkipVerify
    跳过 /plugin-cli/install-plan 只读校验。

.PARAMETER KeepStaging
    保留构建暂存目录（默认删；保留会让下次 install.ps1 报 multiple_installations）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1
#>
[CmdletBinding()]
param(
    [string] $NekoDataDir = '',
    [string] $OutDir = '',
    [switch] $SkipVerify,
    [switch] $KeepStaging
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $NekoDataDir) { $NekoDataDir = Join-Path $env:LOCALAPPDATA 'N.E.K.O' }
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist' }

$PluginId     = 'neko_theme_studio'
$PluginSrc    = Join-Path $RepoRoot 'plugin'
$PluginPort   = 48916
$StagingName  = '_nts_pkg_staging'
$StagingDir   = Join-Path $NekoDataDir ('.neko-plugin-installations\plugins\' + $StagingName)
$PackageDir   = Join-Path $NekoDataDir '.neko-plugin-packages'
$TempPackage  = Join-Path $PackageDir ($StagingName + '.neko-plugin')
$PackageName  = $PluginId + '.neko-plugin'

function Write-Head([string] $Text) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
}
function Write-Step([string] $Text) { Write-Host "  -> $Text" -ForegroundColor Yellow }
function Write-Ok([string] $Text)   { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Info([string] $Text) { Write-Host "  [--] $Text" -ForegroundColor DarkGray }
function Write-Fail([string] $Text) { Write-Host "  [!!] $Text" -ForegroundColor Red }

function Invoke-Http {
    param(
        [Parameter(Mandatory)][string] $Uri,
        [string] $Method = 'GET',
        [string] $JsonBody = $null,
        [int] $TimeoutMs = 180000
    )
    $req = [System.Net.HttpWebRequest]::Create($Uri)
    $req.Method = $Method
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null
    $req.UserAgent = 'NTS-PackagePlugin/1.0'
    if (-not [string]::IsNullOrEmpty($JsonBody)) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
        $req.ContentType = 'application/json; charset=utf-8'
        $req.ContentLength = $bytes.Length
        $rs = $req.GetRequestStream()
        try { $rs.Write($bytes, 0, $bytes.Length) } finally { $rs.Close() }
    }
    try {
        $resp = $req.GetResponse()
        try {
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
            try { $body = $sr.ReadToEnd() } finally { $sr.Close() }
            return [pscustomobject]@{ Ok = $true; StatusCode = [int]$resp.StatusCode; Body = $body }
        } finally { $resp.Close() }
    } catch [System.Net.WebException] {
        $we = $_.Exception
        if ($we.Response) {
            try {
                $sr = New-Object System.IO.StreamReader($we.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
                try { $body = $sr.ReadToEnd() } finally { $sr.Close() }
                return [pscustomobject]@{ Ok = $false; StatusCode = [int]$we.Response.StatusCode; Body = $body }
            } finally { $we.Response.Close() }
        }
        return [pscustomobject]@{ Ok = $false; StatusCode = 0; Body = $we.Message }
    }
}

function ConvertTo-JsonStringLiteral([string] $Value) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '\' { [void]$sb.Append('\\') }
            '"' { [void]$sb.Append('\"') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default { [void]$sb.Append($ch) }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Get-PluginVersion {
    param([Parameter(Mandatory)][string] $TomlPath)
    $hit = Select-String -LiteralPath $TomlPath -Pattern '^\s*version\s*=\s*"([^"]+)"' -List
    if (-not $hit) { throw "plugin.toml 里找不到 version：$TomlPath" }
    return $hit.Matches[0].Groups[1].Value
}

function Test-Port([int] $Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(800)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# ---------------------------------------------------------------------------
Write-Head 'N.E.K.O 官方插件包构建（.neko-plugin）'

$pluginToml = Join-Path $PluginSrc 'plugin.toml'
if (-not (Test-Path -LiteralPath $pluginToml)) {
    Write-Fail "找不到插件源码：$PluginSrc"
    exit 1
}
$SourceVersion = Get-PluginVersion -TomlPath $pluginToml
Write-Info "仓库版本：$SourceVersion"
Write-Info "数据目录：$NekoDataDir"
Write-Info "输出目录：$OutDir"

if (-not (Test-Port $PluginPort)) {
    Write-Fail "端口 $PluginPort（插件服务）没有监听 —— 请先启动 N.E.K.O 再跑本脚本。"
    exit 1
}
Write-Ok "插件服务在线（127.0.0.1:$PluginPort）"

if (Test-Path -LiteralPath $StagingDir) {
    Write-Info "发现上次残留的构建暂存目录，先清掉：$StagingDir"
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $StagingDir) {
        Write-Fail "无法清理临时暂存目录（可能有进程占用）：$StagingDir"
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
if (-not (Test-Path -LiteralPath $PackageDir)) { New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null }

# ---------------------------------------------------------------------------
Write-Step '1/5 复制源码到临时暂存目录（排除开发产物与用户数据）'

$excludeDirs     = @('__pycache__', '.git', '.pytest_cache', '.pytest-scratch', 'tests', '.vscode', '.github', '.idea')
$excludeRelDirs  = @('static\backgrounds', 'static\themes', 'static\exports')
$excludeRelFiles = @('static\schedule.json')

try {
    New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
    $copied = 0
    $skipped = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $PluginSrc -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($PluginSrc.Length).TrimStart('\')
        $drop = $false
        foreach ($part in ($rel -split '\\')) {
            if ($excludeDirs -contains $part) { $drop = $true; break }
        }
        if (-not $drop) {
            foreach ($d in $excludeRelDirs) {
                if ($rel.StartsWith($d + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $drop = $true; break }
            }
        }
        if (-not $drop -and ($excludeRelFiles -contains $rel)) { $drop = $true }
        if (-not $drop) {
            foreach ($pat in @('*.pyc', '*.pyo', '*.tmp', '*.bak')) {
                if ($f.Name -like $pat) { $drop = $true; break }
            }
        }
        if ($drop) { $skipped++; continue }

        $dst = Join-Path $StagingDir $rel
        $dstParent = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $dstParent)) { New-Item -ItemType Directory -Force -Path $dstParent | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
        $copied++
    }
    Write-Ok "已复制 $copied 个文件（跳过 $skipped 个开发产物/用户数据）"

    foreach ($d in @('static\backgrounds', 'static\themes', 'static\exports')) {
        $p = Join-Path $StagingDir $d
        if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
    }

    # plugin.toml 不能带 BOM，否则 build 报 'Invalid statement (at line 1, column 1)'
    $stagedToml = Join-Path $StagingDir 'plugin.toml'
    $tomlBytes = [System.IO.File]::ReadAllBytes($stagedToml)
    if ($tomlBytes.Length -ge 3 -and $tomlBytes[0] -eq 0xEF -and $tomlBytes[1] -eq 0xBB -and $tomlBytes[2] -eq 0xBF) {
        $noBom = [System.Text.Encoding]::UTF8.GetString($tomlBytes, 3, $tomlBytes.Length - 3)
        [System.IO.File]::WriteAllBytes($stagedToml, (New-Object System.Text.UTF8Encoding($false)).GetBytes($noBom))
        Write-Info 'staged plugin.toml 去掉了 UTF-8 BOM'
    }

    # 出厂默认调色板：官方包不该带上打包者自己的主题
    $stagedTheme = Join-Path $StagingDir 'static\theme.json'
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $factory = '{"schema":1,"name":"默认","enabled":true,"updated_at":"' + $stamp + '","vars":{},"dark_vars":{}}'
    [System.IO.File]::WriteAllBytes($stagedTheme, (New-Object System.Text.UTF8Encoding($false)).GetBytes($factory))
    Write-Ok 'static\theme.json 已重置为出厂默认（空调色板）'

    $stagedVersion = Get-PluginVersion -TomlPath $stagedToml
    if ($stagedVersion -ne $SourceVersion) {
        throw "暂存目录版本 $stagedVersion 与仓库版本 $SourceVersion 不一致（先跑 tools/gen-version.js？）"
    }
    Write-Info "staged plugin.toml 版本：$stagedVersion"
}
catch {
    Write-Fail ("准备暂存目录失败：" + $_.Exception.Message)
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# ---------------------------------------------------------------------------
Write-Step '2/5 调 /plugin-cli/build 让宿主打包'

if (Test-Path -LiteralPath $TempPackage) {
    Remove-Item -LiteralPath $TempPackage -Force -ErrorAction SilentlyContinue
}
$buildBody = '{"mode":"single","plugin_ref":{"root_id":"user","directory_name":' + (ConvertTo-JsonStringLiteral $StagingName) + '}}'
Write-Info "请求体：$buildBody"
$r = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin-cli/build" -f $PluginPort) -Method 'POST' -JsonBody $buildBody -TimeoutMs 180000
if (-not $r.Ok -or $r.StatusCode -lt 200 -or $r.StatusCode -ge 300) {
    Write-Fail ("构建失败：HTTP {0}  {1}" -f $r.StatusCode, ($r.Body -replace '\s+', ' '))
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
if (-not (Test-Path -LiteralPath $TempPackage)) {
    Write-Fail "构建返回成功，但没找到包文件：$TempPackage"
    Write-Info "响应：$($r.Body -replace '\s+', ' ')"
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
$tempItem = Get-Item -LiteralPath $TempPackage
Write-Ok ("构建成功：{0} 字节" -f $tempItem.Length)

# ---------------------------------------------------------------------------
Write-Step '3/5 校验包内容（版本 / 出厂调色板 / 无用户数据 / 无开发产物）'

Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$problems = New-Object System.Collections.Generic.List[string]
$zip = [System.IO.Compression.ZipFile]::OpenRead($TempPackage)
try {
    $entries  = @($zip.Entries)
    $names    = @($entries | ForEach-Object { $_.FullName })
    Write-Info ("包内条目：{0}" -f $entries.Count)

    $manifest = $entries | Where-Object { $_.FullName -eq 'manifest.toml' } | Select-Object -First 1
    if (-not $manifest) {
        $problems.Add('缺少 manifest.toml')
    } else {
        $sr = New-Object System.IO.StreamReader($manifest.Open(), [System.Text.Encoding]::UTF8)
        try { $manifestText = $sr.ReadToEnd() } finally { $sr.Close() }
        $mId = [regex]::Match($manifestText, '(?m)^id\s*=\s*"([^"]+)"')
        $mVer = [regex]::Match($manifestText, '(?m)^version\s*=\s*"([^"]+)"')
        if (-not $mId.Success -or $mId.Groups[1].Value -ne $PluginId) {
            $problems.Add("manifest id 不是 $PluginId")
        }
        if (-not $mVer.Success) {
            $problems.Add('manifest.toml 里没有 version')
        } elseif ($mVer.Groups[1].Value -ne $SourceVersion) {
            $problems.Add("manifest 版本 $($mVer.Groups[1].Value) 与源码版本 $SourceVersion 不一致")
        } else {
            Write-Ok "manifest：id=$($mId.Groups[1].Value)  version=$($mVer.Groups[1].Value)"
        }
    }

    $themeEntry = $entries | Where-Object { $_.FullName -eq ('payload/plugins/' + $PluginId + '/static/theme.json') } | Select-Object -First 1
    if (-not $themeEntry) {
        $problems.Add('缺少 payload/plugins/<id>/static/theme.json')
    } else {
        $sr = New-Object System.IO.StreamReader($themeEntry.Open(), [System.Text.Encoding]::UTF8)
        try { $themeText = $sr.ReadToEnd() } finally { $sr.Close() }
        $themeObj = $themeText | ConvertFrom-Json
        $varCount  = @($themeObj.vars.PSObject.Properties).Count
        $darkCount = @($themeObj.dark_vars.PSObject.Properties).Count
        if ($varCount -ne 0 -or $darkCount -ne 0) {
            $problems.Add("包内 theme.json 不是出厂默认（亮 $varCount / 暗 $darkCount 个变量）")
        } else {
            Write-Ok 'theme.json 是出厂默认（0 个变量）'
        }
    }

    $userData = @($names | Where-Object {
        $_ -like '*/static/backgrounds/*' -or
        $_ -like '*/static/themes/*'     -or
        $_ -like '*/static/exports/*'    -or
        $_ -like '*/static/schedule.json'
    })
    if ($userData.Count -gt 0) { $problems.Add("包内含运行期用户数据：$($userData -join ', ')") }
    else { Write-Ok '不含运行期用户数据（backgrounds / themes / exports / schedule.json）' }

    $devJunk = @($names | Where-Object { $_ -like '*/__pycache__/*' -or $_ -like '*/tests/*' -or $_ -like '*.pyc' })
    if ($devJunk.Count -gt 0) { $problems.Add("包内含开发产物：$($devJunk -join ', ')") }
    else { Write-Ok '不含 __pycache__ / tests / *.pyc' }

    $badRoot = @($names | Where-Object {
        $_ -notin @('manifest.toml', 'metadata.toml') -and
        -not $_.StartsWith('payload/')
    })
    if ($badRoot.Count -gt 0) { $problems.Add("包含预期之外的顶层条目：$($badRoot -join ', ')") }

    $otherPlugins = @($names | Where-Object { $_ -match '^payload/plugins/([^/]+)/' } |
        ForEach-Object { [regex]::Match($_, '^payload/plugins/([^/]+)/').Groups[1].Value } |
        Sort-Object -Unique | Where-Object { $_ -ne $PluginId })
    if ($otherPlugins.Count -gt 0) { $problems.Add("包里混入了别的插件：$($otherPlugins -join ', ')") }

    # 注意：PowerShell 里逗号比 + 结合得更紧，'a' + $x + 'b', 'c' 会被拼成一个数组再串成字符串，
    # 所以这里用「名字列表 + 循环里拼前缀」，不要在一个表达式里既写 + 又写 ,。
    $needNames = @(
        'plugin.toml',
        '__init__.py',
        '_app_patch.py',
        'materials.py',
        'static/index.html',
        'static/app.js',
        'static/style.css',
        'static/materials.js',
        'static/materials.css',
        'static/loader/neko-theme-studio.js',
        'static/loader/neko-theme-studio.css'
    )
    foreach ($needName in $needNames) {
        $need = "payload/plugins/$PluginId/" + $needName
        if (-not ($names -contains $need)) { $problems.Add("缺少必需文件：$need") }
    }
    $presetCount = @($names | Where-Object { $_ -match '/static/presets/[^/]+\.json$' }).Count
    $imageCount  = @($names | Where-Object { $_ -match '/static/presets/images/[^/]+$' }).Count
    if ($presetCount -lt 25) { $problems.Add("内置主题只有 $presetCount 套（应 ≥ 25）") }
    if ($imageCount  -lt 3)  { $problems.Add("预设背景图只有 $imageCount 张（应 ≥ 3）") }
    if ($problems.Count -eq 0) {
        Write-Ok ("必需文件齐全（面板三件套 / loader 两件套 / $presetCount 套内置主题 / $imageCount 张预设图）")
    }
}
finally {
    $zip.Dispose()
}

if ($problems.Count -gt 0) {
    Write-Fail '包内容校验没通过：'
    foreach ($p in $problems) { Write-Host "       - $p" -ForegroundColor Red }
    Remove-Item -LiteralPath $TempPackage -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# ---------------------------------------------------------------------------
Write-Step '4/5 复制到 dist\ 并计算 sha256'

$outFile = Join-Path $OutDir $PackageName
Copy-Item -LiteralPath $TempPackage -Destination $outFile -Force
$hash = (Get-FileHash -LiteralPath $outFile -Algorithm SHA256).Hash.ToLowerInvariant()
$shaFile = $outFile + '.sha256'
$line = ($hash + '  ' + $PackageName)
[System.IO.File]::WriteAllBytes($shaFile, (New-Object System.Text.UTF8Encoding($false)).GetBytes($line + "`n"))
Write-Ok ("{0}（{1:N0} 字节）" -f $outFile, (Get-Item -LiteralPath $outFile).Length)
Write-Info "sha256：$hash"

# ---------------------------------------------------------------------------
# install-plan 会扫描 .neko-plugin-installations\plugins\ 下的所有 plugin.toml；
# 暂存目录还在的话它会认为「有多份安装」并返回 blocked（reason=multiple_installations）。
# 所以必须在校验之前把暂存目录删掉 —— 此时包已经打好，源码不再需要。
if ($KeepStaging) {
    Write-Info '（-KeepStaging：保留暂存目录，install-plan 可能因 multi_installations 被拒，故跳过校验）'
    $SkipVerify = $true
} else {
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $StagingDir) {
        Write-Fail "暂存目录删除失败：$StagingDir —— 请手动删除（否则 install.ps1 会报 multiple_installations）。"
        exit 1
    }
    Write-Ok '已删除构建暂存目录（避免 install-plan 判定多份安装）'
}

Write-Step '5/5 只读校验：/plugin-cli/install-plan（不安装）'

if ($SkipVerify) {
    Write-Info '（-SkipVerify：跳过）'
} else {
    # install-plan 只接受 .neko-plugin-packages 里的路径（安全校验），所以这里校验的是
    # 宿主刚打出来的那份临时包；dist\ 里的副本是同一份字节。
    $planBody = '{"package":' + (ConvertTo-JsonStringLiteral $TempPackage) + '}'
    $rp = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin-cli/install-plan" -f $PluginPort) -Method 'POST' -JsonBody $planBody -TimeoutMs 60000
    if (-not $rp.Ok -or $rp.StatusCode -lt 200 -or $rp.StatusCode -ge 300) {
        Write-Fail ("install-plan 调用失败：HTTP {0}  {1}" -f $rp.StatusCode, ($rp.Body -replace '\s+', ' '))
        exit 1
    }
    $plan = $null
    try { $plan = $rp.Body | ConvertFrom-Json } catch { }
    if (-not $plan) {
        Write-Fail ("install-plan 返回了非 JSON：{0}" -f ($rp.Body -replace '\s+', ' '))
        exit 1
    }
    Write-Info ("action={0}  plugin_id={1}  directory_name={2}" -f $plan.action, $plan.plugin_id, $plan.directory_name)
    Write-Info ("current_version='{0}'  target_version='{1}'" -f $plan.current_version, $plan.target_version)
    if ($plan.action -eq 'blocked') {
        Write-Fail ("宿主拒绝这个包：reason='{0}'" -f $plan.reason)
        exit 1
    }
    Write-Ok '宿主认这个包（install-plan 未拒绝）'
}

# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $TempPackage) {
    Remove-Item -LiteralPath $TempPackage -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $TempPackage)) { Write-Info '已清理 .neko-plugin-packages\ 里的临时包' }
}
Write-Info '注：install.ps1 下次升级时会重新构建自己那份包（含用户数据），与本官方包互不影响。'

Write-Head '官方插件包构建完成'
Write-Host ("  产物：{0}" -f $outFile) -ForegroundColor White
Write-Host ("  校验：{0}" -f $shaFile) -ForegroundColor White
Write-Host ("  版本：{0}" -f $SourceVersion) -ForegroundColor White
Write-Host ''
Write-Host '  安装：N.E.K.O → 插件管理 → 从文件安装，选这个 .neko-plugin；装完重启应用。' -ForegroundColor DarkGray
Write-Host '        插件启动时会自愈宿主模板（23 个页面），不需要再跑 install.ps1。' -ForegroundColor DarkGray
exit 0
