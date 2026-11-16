#requires -version 5.1
<#
================================================================================
  N.E.K.O 主题工坊 —— 卸载 / 回滚脚本 (uninstall.ps1)
================================================================================

  作用：把 install.ps1 做过的一切还原回安装前的状态。

  A. 环境检查
  B. 移除补丁标记：templates\*.html 里所有 <!-- NTS:BEGIN -->...<!-- NTS:END --> 段
     （发现有 BEGIN 没有 END 的残缺标记时，只剥离标记文字、保留其余内容）
  C. 校验回滚结果；若移除失败或结果可疑（缺 Jinja 变量 / 缺 </html> / 标记数不为 0 /
     文件长度异常），就从 backup\ 里最新的备份整文件还原（字节级还原）；-Force 强制整文件还原
  D. 删除资源目录下被复制进去的两个静态文件：
       resources\bin\static\css\neko-theme-studio.css
       resources\bin\static\neko-theme-studio.js
  D2. 写「停止自愈」标记文件 %LOCALAPPDATA%\N.E.K.O\theme-studio-disabled：
     插件每次启动都会自愈（重新注入标记 + 两个静态文件）。只删文件不写这个标记的话，
     卸载后一重启主题就会自己回来（旧版 bug）。重新运行 install.ps1 会删除这个标记。
  E. 清理自己的构建暂存残留（若还在的话；默认保留插件本体目录）
  F. 尽力让插件服务停止自愈运行时：把 auto_start 置 false 并 stop 插件（失败只警告，不阻断）
  G. 报告：改了什么、还原了什么、校验哈希

  可重复执行（幂等）：已经回滚过的环境再跑一次不会有副作用，只会报告“无需改动”。

  硬约束（契约 §9）：
    * 绝不触碰 resources\app.asar 与 projectneko_server.exe。
    * 只删除本插件自己放进去的文件，绝不删除 backup\ 里的备份（备份永久保留）。

  用法：
    pwsh -File uninstall.ps1
    pwsh -File uninstall.ps1 -AppRoot 'D:\tools\enokoo'
    pwsh -File uninstall.ps1 -KeepAssets      # 只回滚模板，保留 static 下的两件套
    pwsh -File uninstall.ps1 -Force           # 即使模板看起来正常也用最新备份整文件还原
    pwsh -File uninstall.ps1 -WhatIf          # 只显示将要做什么，不落盘（PowerShell 内置）
================================================================================
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # N.E.K.O 安装根。省略时从本脚本位置自动推断（theme-studio\ 的上一级）
    [string] $AppRoot = '',
    [switch] $KeepAssets,
    [switch] $KeepPlugin,
    # 连同「插件本体」目录一起从磁盘删除。默认关闭：该目录是全机共用的
    # %LOCALAPPDATA% 路径，不是 $AppRoot 下的东西，删它会影响真正在用的安装。
    [switch] $PurgeStaging,
    # 即使模板看起来正常，也用 backup\ 里最新的备份整文件还原（字节级还原）
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$StartedAt = Get-Date

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
$MarkerBegin = '<!-- NTS:BEGIN -->'
$MarkerEnd   = '<!-- NTS:END -->'
$JinjaSentinel = '{{ static_asset_version }}'

$PluginId   = 'neko_theme_studio'
$AssetCssRel = 'css\neko-theme-studio.css'
$AssetJsRel  = 'neko-theme-studio.js'

# ---------------------------------------------------------------------------
# 输出helper（全中文、带颜色）
# ---------------------------------------------------------------------------
function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
}
function Write-Step([string]$Text) { Write-Host ''; Write-Host "▶ $Text" -ForegroundColor White }
function Write-Ok([string]$Text)   { Write-Host "  [完成] $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  [信息] $Text" -ForegroundColor Gray }
function Write-Warn2([string]$Text){ Write-Host "  [警告] $Text" -ForegroundColor Yellow }
function Write-Err2([string]$Text) { Write-Host "  [错误] $Text" -ForegroundColor Red }
function Write-Chg([string]$Text)  { Write-Host "  [还原] $Text" -ForegroundColor Magenta }

$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Reverted = New-Object System.Collections.Generic.List[string]
$script:Skipped  = New-Object System.Collections.Generic.List[string]

function Add-Warning([string]$Text) {
    $script:Warnings.Add($Text) | Out-Null
    Write-Warn2 $Text
}
function Add-Reverted([string]$Text) {
    $script:Reverted.Add($Text) | Out-Null
    Write-Chg $Text
}
function Add-Skipped([string]$Text) {
    $script:Skipped.Add($Text) | Out-Null
    Write-Info $Text
}

# ---------------------------------------------------------------------------
# 文本读写：保留 BOM 与行尾，绝不破坏 Jinja 模板
# ---------------------------------------------------------------------------
function Get-TextFileProbe {
    param([Parameter(Mandatory)][string] $Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $false
    # 严格解码：Windows PowerShell 默认的 UTF8.GetString 会把非法字节静默换成 U+FFFD，
    # 一旦后续写回就会把模板里的乱码永久固化成替换字符。这里遇到非法 UTF-8 直接报错，
    # 让 B 段按「跳过该模板」处理。
    $utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            $hasBom = $true
            $text = $utf8Strict.GetString($bytes, 3, $bytes.Length - 3)
        } else {
            $text = $utf8Strict.GetString($bytes)
        }
    } catch {
        throw ("{0} 不是合法的 UTF-8（{1}）。为避免静默替换成 U+FFFD 写坏模板，已中止。" -f $Path, $_.Exception.Message)
    }
    $crlf = 0
    for ($i = 1; $i -lt $bytes.Length; $i++) { if ($bytes[$i] -eq 10 -and $bytes[$i-1] -eq 13) { $crlf++ } }
    $lf = 0
    foreach ($b in $bytes) { if ($b -eq 10) { $lf++ } }
    $eol = $(if ($crlf -gt 0 -and $crlf * 2 -ge $lf) { "`r`n" } else { "`n" })

    return [pscustomobject]@{
        Path       = $Path
        Text       = $text
        HasBom     = $hasBom
        Eol        = $eol
        RawBytesLen= $bytes.Length
        CrlfCount  = $crlf
        LfCount    = $lf
        # 由 B 段在「移除后校验未通过」时置为 $true，C 段据此改用备份整文件还原
        RemoveFailed = $false
    }
}

function Write-TextFilePreserving {
    param(
        [Parameter(Mandatory)][string] $Path,
        [string] $Text,
        [bool] $HasBom
    )

    if ($null -eq $Text) { $Text = '' }
    $enc  = New-Object System.Text.UTF8Encoding($HasBom)
    $dir  = Split-Path -Parent $Path
    $tmp  = Join-Path $dir ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path), [System.Guid]::NewGuid().ToString('N'))
    $bytes = $enc.GetBytes($Text)
    if ($HasBom) {
        $preamble = $enc.GetPreamble()
        $all = New-Object byte[] ($preamble.Length + $bytes.Length)
        [System.Array]::Copy($preamble, 0, $all, 0, $preamble.Length)
        [System.Array]::Copy($bytes, 0, $all, $preamble.Length, $bytes.Length)
        $bytes = $all
    }
    $done = $false
    $last = $null
    for ($i = 1; $i -le 4; $i++) {
        $bak = $tmp + '.old'
        try {
            # 原子写：同目录临时文件 + 原子替换，避免正在读模板的宿主进程读到半截文件。
            [System.IO.File]::WriteAllBytes($tmp, $bytes)
            if (Test-Path -LiteralPath $Path) {
                # File.Replace 的第三个参数不能传 $null（PS5.1 会报「路径的形式不合法」），用临时备份名。
                [System.IO.File]::Replace($tmp, $Path, $bak)
                if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }
            } else {
                [System.IO.File]::Move($tmp, $Path)
            }
            $done = $true
            break
        } catch {
            $last = $_
            try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } catch { }
            try { if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue } } catch { }
            Start-Sleep -Milliseconds 350
        }
    }
    if (-not $done) {
        throw ("写入失败 {0}：{1}" -f $Path, $last.Exception.Message)
    }
}

function Get-Sha256OfBytes([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '') }
    finally { $sha.Dispose() }
}

function Get-Sha256OfText([string]$Text) {
    return Get-Sha256OfBytes ([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Split-TextLines([string]$Text, [string]$Eol) {
    if ($null -eq $Text) { return @() }
    $parts = $Text -split "`n", -1
    $out = @()
    foreach ($p in $parts) { $out += $p.TrimEnd([char]13) }
    return ,$out
}
function Join-TextLines([string[]]$Lines, [string]$Eol) {
    if ($null -eq $Lines) { throw 'Join-TextLines：$Lines 不能为 $null' }
    return ($Lines -join $Eol)
}

<#
  纯字面量剥离 NTS 标记段（不使用 -replace，避免 PowerShell 把
  `-replace A + B + C` 解析成字符串拼接导致静默失效 —— 这是本项目踩过的坑）。

  返回 @{ Lines; Removed; Unterminated }
#>
function Remove-NtsBlockLines {
    param(
        [string[]] $Lines,
        [string] $Begin,
        [string] $End
    )

    if ($null -eq $Lines) { throw 'Remove-NtsBlockLines：$Lines 不能为 $null' }

    $out = New-Object System.Collections.Generic.List[string]
    $i = 0
    $removed = 0
    $unterminated = $false

    while ($i -lt $Lines.Count) {
        $line = $Lines[$i]
        $bIdx = $line.IndexOf($Begin, [System.StringComparison]::Ordinal)

        if ($bIdx -lt 0) {
            # 没有 BEGIN：孤立 END 就单删掉它自己，其它原样保留
            $eIdx = $line.IndexOf($End, [System.StringComparison]::Ordinal)
            if ($eIdx -ge 0) {
                $stripped = $line.Remove($eIdx, $End.Length)
                if ([string]::IsNullOrWhiteSpace($stripped)) { $removed++ } else { $out.Add($stripped) }
            } else {
                $out.Add($line)
            }
            $i++
            continue
        }

        # 命中 BEGIN：看同一行有没有 END
        $afterBegin = $bIdx + $Begin.Length
        $eSame = $line.IndexOf($End, $afterBegin, [System.StringComparison]::Ordinal)

        if ($eSame -ge 0) {
            # 单行 BEGIN...END：整段（含 END）删掉，保留 END 之后的内容
            $tail = $line.Substring($eSame + $End.Length)
            $head = $line.Substring(0, $bIdx)
            $stripped = $head + $tail
            if ([string]::IsNullOrWhiteSpace($stripped)) { $removed++ } else { $out.Add($stripped) }
            $i++
            continue
        }

        # 多行块：从本行跳到含 END 的那一行
        $j = $i + 1
        $foundEnd = -1
        while ($j -lt $Lines.Count) {
            if ($Lines[$j].IndexOf($End, [System.StringComparison]::Ordinal) -ge 0) { $foundEnd = $j; break }
            $j++
        }

        if ($foundEnd -lt 0) {
            # BEGIN 没有 END：只把标记文字去掉，绝不丢弃后面的任何内容
            $unterminated = $true
            $stripped = $line.Remove($bIdx, $Begin.Length)
            if (-not [string]::IsNullOrWhiteSpace($stripped)) { $out.Add($stripped) }
            $i++
            continue
        }

        # 保留 BEGIN 行 BEGIN 之前的文字
        $head = $line.Substring(0, $bIdx)
        if (-not [string]::IsNullOrWhiteSpace($head)) { $out.Add($head) }
        # 保留 END 行 END 之后的文字
        $endLine = $Lines[$foundEnd]
        $ePos = $endLine.IndexOf($End, [System.StringComparison]::Ordinal)
        $tail = $endLine.Substring($ePos + $End.Length)
        if (-not [string]::IsNullOrWhiteSpace($tail)) { $out.Add($tail) }
        $removed += ($foundEnd - $i + 1)
        $i = $foundEnd + 1
    }

    return [pscustomobject]@{ Lines = $out.ToArray(); Removed = $removed; Unterminated = $unterminated }
}

function Get-NtsMarkerCounts([string]$Text) {
    $b = 0; $e = 0
    if (-not [string]::IsNullOrEmpty($Text)) {
        $b = ([regex]::Matches($Text, [regex]::Escape($MarkerBegin))).Count
        $e = ([regex]::Matches($Text, [regex]::Escape($MarkerEnd))).Count
    }
    return [pscustomobject]@{ Begin = $b; End = $e }
}

# ---------------------------------------------------------------------------
# 网络小工具：只用来「尽力」停掉插件的自动重注入，失败一律降级为 warning
# ---------------------------------------------------------------------------
function Test-TcpPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

function Invoke-Http {
    param(
        [Parameter(Mandatory)][string] $Uri,
        [string] $Method = 'GET',
        [string] $JsonBody = '',
        [int] $TimeoutMs = 12000
    )
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $req = [System.Net.WebRequest]::Create($Uri)
    $req.Method = $Method
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null  # 本机回环，绕开系统代理
    if ($JsonBody) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
        $req.ContentType = 'application/json; charset=utf-8'
        $req.ContentLength = $bytes.Length
        $s = $req.GetRequestStream()
        $s.Write($bytes, 0, $bytes.Length)
        $s.Dispose()
    }
    try {
        $resp = $req.GetResponse()
        $status = [int]$resp.StatusCode
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        $reader.Dispose()
        $resp.Dispose()
        return [pscustomobject]@{ Ok = ($status -ge 200 -and $status -lt 300); StatusCode = $status; Body = $body }
    } catch [System.Net.WebException] {
        $we = $_.Exception
        $status = 0
        $body = ''
        if ($we.Response) {
            $status = [int]$we.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($we.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Dispose()
            } catch { }
            $we.Response.Dispose()
        }
        return [pscustomobject]@{ Ok = $false; StatusCode = $status; Body = $body; Error = $we.Message }
    }
}

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------
# -AppRoot 省略时从本脚本自身位置反推：theme-studio\ 的上一级就是 N.E.K.O 安装根。
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw '无法自动推断 -AppRoot（$PSScriptRoot 为空）。请显式传入 -AppRoot "<N.E.K.O 安装根>"。'
    }
    $AppRoot = Split-Path -Parent $PSScriptRoot
    Write-Host ("  自动推断安装根：{0}（来自脚本位置 {1}）" -f $AppRoot, $PSScriptRoot) -ForegroundColor DarkGray
}
$AppRoot = $AppRoot.TrimEnd('\')

if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'resources\bin\templates'))) {
    throw ("-AppRoot 指向的目录不是 N.E.K.O 安装根：'{0}' 下没有 resources\bin\templates。请用 -AppRoot 指定正确路径。" -f $AppRoot)
}

$ThemeRoot    = Join-Path $AppRoot 'theme-studio'
$TemplateDir  = Join-Path $AppRoot 'resources\bin\templates'
$StaticDir    = Join-Path $AppRoot 'resources\bin\static'
$BackupDir    = Join-Path $ThemeRoot 'backup'

# 目标模板 = 「所有带 NTS 标记的模板」，而不是写死的那两个。
# 原因：install.ps1 只补 chat/index，但插件的 _app_patch.py 会补全部 23 个带
# dark-mode.css 锚点的模板。若这里只认两个，卸载后另外 21 个模板里仍留着标记段，
# 会去加载已被删除的静态文件（每次开页面多两个 404）。
$TplIndex = Join-Path $TemplateDir 'index.html'
$TplChat  = Join-Path $TemplateDir 'chat.html'
$TplTargets = @(
    [pscustomobject]@{ Name = 'chat.html';  Path = $TplChat  },
    [pscustomobject]@{ Name = 'index.html'; Path = $TplIndex }
)
if (Test-Path -LiteralPath $TemplateDir) {
    foreach ($f in (Get-ChildItem -LiteralPath $TemplateDir -Filter '*.html' -File -ErrorAction SilentlyContinue)) {
        if ($TplTargets | Where-Object { $_.Name -eq $f.Name }) { continue }
        $hit = $false
        try {
            # 标记是纯 ASCII，用字节搜索即可，不需要解码中文
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
            $hit = $ascii.Contains($MarkerBegin)
        } catch { $hit = $false }
        if ($hit) {
            $TplTargets += [pscustomobject]@{ Name = $f.Name; Path = $f.FullName }
        }
    }
}

$AssetCssDst = Join-Path $StaticDir $AssetCssRel
$AssetJsDst  = Join-Path $StaticDir $AssetJsRel

$LocalAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
    $LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
}
$NekoDataDir        = Join-Path $LocalAppData 'N.E.K.O'
$InstallPluginsRoot = Join-Path $NekoDataDir '.neko-plugin-installations\plugins'
$StagingDir         = Join-Path $InstallPluginsRoot $PluginId

# 插件服务端口（可用 NEKO_NTS_PLUGIN_PORT 覆盖，便于在隔离环境里测试）
$PluginPort = $(if ($env:NEKO_NTS_PLUGIN_PORT) { [int]$env:NEKO_NTS_PLUGIN_PORT } else { 48916 })
# 「停止自愈」标记：存在时插件的 startup 会跳过应用侧补丁自愈
$DisableFlag = $(if ($env:NEKO_NTS_DISABLE_FILE) { $env:NEKO_NTS_DISABLE_FILE } else { Join-Path $NekoDataDir 'theme-studio-disabled' })

Write-Host ''
Write-Host '  N.E.K.O 主题工坊 —— 卸载 / 回滚脚本 (uninstall.ps1)' -ForegroundColor Cyan
Write-Host ("  运行时间 {0}   模式 {1}" -f $StartedAt.ToString('yyyy-MM-dd HH:mm:ss'), $(if ($WhatIfPreference) { '预演 -WhatIf' } else { '实际执行' })) -ForegroundColor DarkGray
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ("  提示：当前是 Windows PowerShell {0}，脚本按 PowerShell 7 编写但兼容运行。" -f $PSVersionTable.PSVersion) -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------------------
# A. 环境检查
# ---------------------------------------------------------------------------
Write-Head 'A. 环境检查'

$envProblems = New-Object System.Collections.Generic.List[string]
foreach ($p in @($AppRoot, $TemplateDir)) {
    if (-not (Test-Path -LiteralPath $p)) { $envProblems.Add("缺少路径：$p") }
}
foreach ($f in @($TplIndex, $TplChat)) {
    if (-not (Test-Path -LiteralPath $f)) { $envProblems.Add("缺少模板：$f") }
}

if ($envProblems.Count -gt 0) {
    foreach ($p in $envProblems) { Write-Err2 $p }
    Write-Err2 '安装根似乎不是有效的 N.E.K.O 安装目录，请用 -AppRoot 指定正确路径。'
    exit 1
}

Write-Ok "安装根：$AppRoot"
Write-Ok "模板目录：$TemplateDir"
Write-Ok "静态目录：$StaticDir"
Write-Ok "备份目录：$BackupDir"
Write-Info '硬约束：本脚本不读写 resources\app.asar 与 projectneko_server.exe（契约 §9）'

# ---------------------------------------------------------------------------
# B. 移除模板里的标记段
# ---------------------------------------------------------------------------
Write-Head 'B. 移除模板补丁标记'

$probes = @{}
foreach ($t in $TplTargets) {
    try {
        $probes[$t.Name] = Get-TextFileProbe -Path $t.Path
    } catch {
        # 严格 UTF-8 解码失败：报错并跳过该模板，绝不用替换字符写回
        Add-Warning ("{0}：{1} 已跳过该模板（不会写坏它）。" -f $t.Name, $_.Exception.Message)
    }
}

foreach ($t in $TplTargets) {
    $pr = $probes[$t.Name]
    if ($null -eq $pr) { continue }
    $counts = Get-NtsMarkerCounts $pr.Text

    if ($counts.Begin -eq 0 -and $counts.End -eq 0) {
        Add-Skipped ("{0}：没有标记，无需改动（{1} 字节）" -f $t.Name, $pr.RawBytesLen)
        continue
    }

    Write-Info ("{0}：检测到标记 BEGIN={1} END={2}，开始移除" -f $t.Name, $counts.Begin, $counts.End)

    $lines = Split-TextLines -Text $pr.Text -Eol $pr.Eol
    $res = Remove-NtsBlockLines -Lines $lines -Begin $MarkerBegin -End $MarkerEnd

    if ($res.Unterminated) {
        Add-Warning ("{0}：发现只有 BEGIN 没有 END 的残缺标记，已只剥离标记文字、保留其余内容。" -f $t.Name)
    }

    $newText = Join-TextLines -Lines $res.Lines -Eol $pr.Eol

    # ---- 落盘前校验：结果必须仍然像个完整的 Jinja 模板 ----
    # 关于 {{ static_asset_version }}：不能要求它「必须仍在」。
    # 注入的标记行本身就带这个变量，所以 23 个模板「删除前都含有它」，
    # 但只有少数模板（chat/index 等）原生使用它；把这条当硬条件会把
    # 其余模板全部误判为「校验未通过 → 需整文件还原」。
    # 哨兵完整性由 install.ps1 -Verify 针对真正拥有该变量的模板负责。
    $post = Get-NtsMarkerCounts $newText
    $ok = $true
    $why = @()
    if ($post.Begin -ne 0 -or $post.End -ne 0) { $ok = $false; $why += ("标记数仍为 BEGIN={0} END={1}" -f $post.Begin, $post.End) }
    if (-not $newText.Contains('</html>')) { $ok = $false; $why += '缺少 </html>' }
    if ($newText.Length -lt ($pr.Text.Length * 0.5)) { $ok = $false; $why += '文件长度骤减超过一半' }

    if (-not $ok) {
        Add-Warning ("{0}：移除标记后的校验未通过（{1}）——将改用备份整文件还原。" -f $t.Name, ($why -join '；'))
        $probes[$t.Name].RemoveFailed = $true
        continue
    }

    if ($PSCmdlet.ShouldProcess($t.Path, '移除 NTS 标记段')) {
        Write-TextFilePreserving -Path $t.Path -Text $newText -HasBom $pr.HasBom
        $pr.Text = $newText
        Add-Reverted ("{0}：已移除 NTS 标记段 {1} 行（{2} 字节 → {3} 字节）" -f $t.Name, $res.Removed, $pr.RawBytesLen, ([System.IO.File]::ReadAllBytes($t.Path)).Length)
    } else {
        Write-Info ("{0}：-WhatIf 预演，未写入。" -f $t.Name)
    }
}

# ---------------------------------------------------------------------------
# C. 校验 / 必要时从最新备份整文件还原
# ---------------------------------------------------------------------------
Write-Head 'C. 校验模板，必要时从备份还原'

foreach ($t in $TplTargets) {
    $pr = $probes[$t.Name]
    if ($null -eq $pr) { continue }
    $path = $t.Path

    # 选择该模板最新的备份（文件名内嵌原始内容哈希，永不被删除）
    $backups = @(Get-ChildItem -LiteralPath $BackupDir -Filter ("{0}.pristine-*.bak" -f $t.Name) -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending)
    $newest = $(if ($backups.Count -gt 0) { $backups[0].FullName } else { $null })

    $needRestore = $false
    $reason = ''

    if ($pr.RemoveFailed) {
        $needRestore = $true
        $reason = '移除标记后的校验未通过'
    } elseif ($Force) {
        # -Force 的语义是「用最新备份整文件还原」。但插件自愈会补全部 23 个模板，
        # 而 install.ps1 只给 chat/index 做了备份 —— 其余模板在 AppRoot\theme-studio\backup
        # 里根本没有备份。旧逻辑会对这 21 个模板逐个报「没有可用备份」，让一次成功的
        # 卸载以 exit 2 + 21 条警告结束。这里改成：有备份才强制还原，没备份就只看当前状态。
        if ($newest) {
            $needRestore = $true
            $reason = '指定了 -Force'
        } else {
            Write-Info ("{0}：指定了 -Force，但 backup\ 里没有它的备份（插件自愈模板）；当前无标记即视为正常，跳过。" -f $t.Name)
        }
    } else {
        # 再读一次磁盘上的真实内容做最终判定
        $now = Get-TextFileProbe -Path $path
        $counts = Get-NtsMarkerCounts $now.Text
        if ($counts.Begin -ne 0 -or $counts.End -ne 0) { $needRestore = $true; $reason = ("标记数残留 BEGIN={0} END={1}" -f $counts.Begin, $counts.End) }
        elseif (-not $now.Text.Contains('</html>')) { $needRestore = $true; $reason = '缺少 </html>' }
    }

    if (-not $needRestore) {
        $now = Get-TextFileProbe -Path $path
        $counts = Get-NtsMarkerCounts $now.Text
        $hash = Get-Sha256OfBytes ([System.IO.File]::ReadAllBytes($path))

        # 与备份比对：一致就说明完全回到原始状态
        $matchBackup = $null
        if ($newest) {
            $bHash = (Get-FileHash -LiteralPath $newest -Algorithm SHA256).Hash
            if ($hash -eq $bHash) { $matchBackup = $newest }
        }
        if ($matchBackup) {
            Write-Ok ("{0}：标记 BEGIN={1} END={2}，与备份逐字节一致（{3} 字节，sha256 {4}）" -f $t.Name, $counts.Begin, $counts.End, $now.RawBytesLen, $hash.Substring(0,16))
        } else {
            Write-Ok ("{0}：标记 BEGIN={1} END={2}，已无补丁（{3} 字节，sha256 {4}）" -f $t.Name, $counts.Begin, $counts.End, $now.RawBytesLen, $hash.Substring(0,16))
            if ($newest) {
                Write-Info ("  （与最新备份 {0} 不同；可能模板已被升级或被其它工具修改过，未做改动。）" -f (Split-Path $newest -Leaf))
            }
        }
        continue
    }

    # 需要还原
    if (-not $newest) {
        Add-Warning ("{0}：需要还原（{1}），但 backup\ 里没有可用备份。请手动处理。" -f $t.Name, $reason)
        continue
    }

    Write-Warn2 ("{0}：需要还原（{1}）→ 使用最新备份 {2}" -f $t.Name, $reason, (Split-Path $newest -Leaf))
    $bProbe = Get-TextFileProbe -Path $newest

    if ($PSCmdlet.ShouldProcess($path, "从备份还原 $newest")) {
        # 原子还原：先把备份复制到同目录临时文件，再原子替换目标。
        # 不要直接 Copy-Item 覆盖模板 —— 正在读模板的宿主进程可能读到半截文件。
        $dir = Split-Path -Parent $path
        $tmp = Join-Path $dir ('.{0}.{1}.restore.tmp' -f (Split-Path -Leaf $path), [System.Guid]::NewGuid().ToString('N'))
        $bak = $tmp + '.old'
        $restored = $false
        for ($i = 1; $i -le 4; $i++) {
            try {
                [System.IO.File]::Copy($newest, $tmp, $true)
                if (Test-Path -LiteralPath $path) {
                    [System.IO.File]::Replace($tmp, $path, $bak)
                    if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }
                } else {
                    [System.IO.File]::Move($tmp, $path)
                }
                $restored = $true
                break
            } catch {
                try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } catch { }
                try { if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue } } catch { }
                Start-Sleep -Milliseconds 350
            }
        }
        if (-not $restored) {
            Add-Warning ("{0}：从备份还原写入失败（重试 4 次）：{1}" -f $t.Name, $newest)
        }
        $after = Get-TextFileProbe -Path $path
        $aCounts = Get-NtsMarkerCounts $after.Text
        $aHash = Get-Sha256OfBytes ([System.IO.File]::ReadAllBytes($path))
        $bHash = (Get-FileHash -LiteralPath $newest -Algorithm SHA256).Hash

        if ($aHash -eq $bHash -and $aCounts.Begin -eq 0) {
            Add-Reverted ("{0}：已从备份整文件还原（{1} 字节，与备份 sha256 一致 {2}）" -f $t.Name, $after.RawBytesLen, $aHash.Substring(0,16))
        } else {
            Add-Warning ("{0}：还原后仍未与备份一致（sha256 {1} vs {2}，标记 BEGIN={3}）" -f $t.Name, $aHash.Substring(0,16), $bHash.Substring(0,16), $aCounts.Begin)
        }
    } else {
        Write-Info ("{0}：-WhatIf 预演，未还原。" -f $t.Name)
    }
}

# ---------------------------------------------------------------------------
# D. 删除被复制进去的两个静态文件
# ---------------------------------------------------------------------------
Write-Head 'D. 删除应用静态目录里的两个文件'

if ($KeepAssets) {
    Add-Skipped '指定了 -KeepAssets：保留 static\css\neko-theme-studio.css 与 static\neko-theme-studio.js。'
} else {
    foreach ($asset in @(
        [pscustomobject]@{ Label = 'CSS'; Path = $AssetCssDst },
        [pscustomobject]@{ Label = 'JS';  Path = $AssetJsDst  }
    )) {
        if (-not (Test-Path -LiteralPath $asset.Path)) {
            Add-Skipped ("{0}：{1} 不存在，无需删除" -f $asset.Label, $asset.Path)
            continue
        }

        # 安全护栏：只删我们自己那两个文件名，路径必须正好在 StaticDir 下
        $full = [System.IO.Path]::GetFullPath($asset.Path)
        $root = [System.IO.Path]::GetFullPath($StaticDir)
        if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            Add-Warning ("{0}：路径不在静态目录内，拒绝删除（{1}）" -f $asset.Label, $full)
            continue
        }

        $len = (Get-Item -LiteralPath $asset.Path).Length
        if ($PSCmdlet.ShouldProcess($asset.Path, '删除主题静态文件')) {
            Remove-Item -LiteralPath $asset.Path -Force
            if (Test-Path -LiteralPath $asset.Path) {
                Add-Warning ("{0}：删除失败，文件仍存在（{1}）" -f $asset.Label, $asset.Path)
            } else {
                Add-Reverted ("{0}：已删除 {1}（原 {2} 字节）" -f $asset.Label, $asset.Path, $len)
            }
        } else {
            Write-Info ("{0}：-WhatIf 预演，未删除。" -f $asset.Label)
        }
    }
}

# ---------------------------------------------------------------------------
# D2. 写入「停止自愈」标记
#     —— 这是「卸载是否持久」的关键：只删两个静态文件没用，插件 startup 会把它们
#        连同 23 个模板里的标记一起重新写回来（_app_patch.py 的自愈逻辑）。
# ---------------------------------------------------------------------------
Write-Head 'D2. 写入「停止自愈」标记'

$disableContent = @(
    ('# 由 uninstall.ps1 于 {0} 生成' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
    '# 这个文件存在时，主题工坊插件的 startup 会跳过「应用侧补丁自愈」，',
    '# 不会再往 resources\bin\static 与 resources\bin\templates 里重新注入主题。',
    '# 重新运行 install.ps1 且安装成功后，会自动删除本文件（恢复自愈）。',
    ''
) -join "`r`n"

if ($PSCmdlet.ShouldProcess($DisableFlag, '写入「停止自愈」标记')) {
    try {
        $flagDir = Split-Path -Parent $DisableFlag
        if ($flagDir -and -not (Test-Path -LiteralPath $flagDir)) { New-Item -ItemType Directory -Path $flagDir -Force | Out-Null }
        [System.IO.File]::WriteAllText($DisableFlag, $disableContent, (New-Object System.Text.UTF8Encoding($false)))
        Add-Reverted ("已写入「停止自愈」标记：{0}（插件下次启动不会再重新注入主题）" -f $DisableFlag)
    } catch {
        Add-Warning ("写入「停止自愈」标记失败：{0}（{1}）—— 插件下次启动仍可能把主题重新注入回来，请手动创建该文件。" -f $DisableFlag, $_.Exception.Message)
    }
} else {
    Write-Info '-WhatIf 预演，未写入标记。'
}

# ---------------------------------------------------------------------------
# E. 清理构建暂存残留
# ---------------------------------------------------------------------------
Write-Head 'E. 构建暂存残留'

if (-not $PurgeStaging) {
    # 注意：这个目录**不在 $AppRoot 下**，它是 N.E.K.O 的用户数据目录
    # （%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\<id>\），
    # 而且它就是「已安装的插件本体」。删掉它等于把插件从磁盘上卸掉，
    # 但 plugins.lock.json 仍记着这个插件，状态会不一致。
    #
    # 更糟的是：它是全机共用的。如果你在别的目录上试跑本脚本（比如把安装包解压到
    # 一个假的安装根），这个删除动作依然会命中**真正在用的那份插件**。
    # 所以这里默认不动它，必须显式 -PurgeStaging 才清理。
    if (Test-Path -LiteralPath $StagingDir) {
        Add-Skipped ("插件本体目录仍在（未删除）：{0}" -f $StagingDir)
    } else {
        Add-Skipped ("插件本体目录不存在：{0}" -f $StagingDir)
    }
    Write-Info '默认保留插件本体，只回滚应用侧补丁。'
    Write-Info '要连插件本体一起从磁盘移除，加 -PurgeStaging（会把插件卸掉，但插件管理界面里的登记项仍在）。'
} elseif (Test-Path -LiteralPath $StagingDir) {
    Write-Info ("发现插件本体目录：{0}" -f $StagingDir)
    Write-Warn2 '你指定了 -PurgeStaging：这会从磁盘删除插件本体（不只是应用侧补丁）。'
    if ($PSCmdlet.ShouldProcess($StagingDir, '删除插件本体目录')) {
        Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $StagingDir) {
            Add-Warning ("插件本体目录删除失败（可能被占用）：{0}" -f $StagingDir)
        } else {
            Add-Reverted ("已删除插件本体目录：{0}" -f $StagingDir)
        }
    } else {
        Write-Info '  -WhatIf 预演，未删除。'
    }
} else {
    Add-Skipped ("插件本体目录不存在，无需清理：{0}" -f $StagingDir)
}

# ---------------------------------------------------------------------------
# F. 停止插件运行时（尽力而为，失败只 warning 不阻断）
# ---------------------------------------------------------------------------
Write-Head 'F. 停止插件运行时（尽力而为）'

if (-not (Test-TcpPort -Port $PluginPort)) {
    Write-Info ("插件服务端口 {0} 未监听（应用可能没在运行），跳过；「停止自愈」标记已足以阻止下次启动重新注入。" -f $PluginPort)
} else {
    $base = 'http://127.0.0.1:{0}' -f $PluginPort
    $pluginsResp = $null
    try { $pluginsResp = Invoke-Http -Uri ("{0}/plugins" -f $base) } catch { $pluginsResp = $null }
    if ($null -eq $pluginsResp -or -not $pluginsResp.Ok) {
        Add-Warning ("无法读取插件列表（{0}/plugins），跳过停止插件。" -f $base)
    } elseif ($pluginsResp.Body -notmatch [regex]::Escape($PluginId)) {
        Write-Info ("插件列表里没有 {0}，跳过停止。" -f $PluginId)
    } else {
        # 1) 关掉自动启动，避免下次应用启动时插件又被拉起
        $r = $null
        try { $r = Invoke-Http -Uri ("{0}/plugin/{1}/auto-start" -f $base, $PluginId) -Method 'PUT' -JsonBody '{"auto_start":false}' } catch { $r = $null }
        if ($null -ne $r -and $r.Ok) {
            Add-Reverted ("已把插件 {0} 的 auto_start 置为 false（下次应用启动不会自动拉起）" -f $PluginId)
        } else {
            Add-Warning ("设置 auto_start=false 失败 —— 但「停止自愈」标记仍会阻止重新注入。")
        }
        # 2) 停掉当前正在跑的插件（端点不存在或失败都不阻断）
        $s = $null
        try { $s = Invoke-Http -Uri ("{0}/plugin/{1}/stop" -f $base, $PluginId) -Method 'POST' -JsonBody '{}' } catch { $s = $null }
        if ($null -ne $s -and $s.Ok) {
            Add-Reverted ("已请求停止插件 {0} 的运行时" -f $PluginId)
        } else {
            Add-Warning ("停止插件运行时失败（端点缺失或被拒绝）—— 插件可能仍在内存里运行，重启应用后就不会再注入。")
        }
    }
}

# 说明：旧版这里写的是「即使插件本体仍在，卸载后主题也不会再影响界面」，那是错的 ——
# 插件 startup 的 _app_patch.py 自愈会把两个静态文件和模板里的标记重新注入回来。
Write-Info '说明：卸载 = 删除 static 下两个文件 + 写「停止自愈」标记 + 尽力把 auto_start 置 false 并停插件。'
Write-Info '      下次应用启动 / 插件 reload 时，插件会检测到标记并跳过自愈，主题不会回来。'
Write-Info '      之后若重新运行 install.ps1 且安装成功，脚本会自动删除该标记（恢复自愈）。'
if (-not $KeepPlugin) {
    Write-Info '彻底移除插件本体：请在 N.E.K.O「插件管理」界面删除「主题工坊」，或运行本脚本时加 -PurgeStaging。'
    Write-Info ("  数据目录：{0}" -f $NekoDataDir)
}

# ---------------------------------------------------------------------------
# G. 报告
# ---------------------------------------------------------------------------
Write-Head 'G. 回滚报告'

if ($script:Reverted.Count -eq 0) {
    Write-Host '  本次没有任何改动（环境已经处于未安装状态）。' -ForegroundColor Green
} else {
    Write-Host ("  共 {0} 项还原：" -f $script:Reverted.Count) -ForegroundColor White
    $n = 1
    foreach ($c in $script:Reverted) { Write-Host ("   {0,2}. {1}" -f $n, $c) -ForegroundColor Magenta; $n++ }
}

if ($script:Skipped.Count -gt 0) {
    Write-Host ''
    Write-Host ("  跳过 {0} 项：" -f $script:Skipped.Count) -ForegroundColor DarkGray
    foreach ($c in $script:Skipped) { Write-Host ("    - {0}" -f $c) -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host '  模板当前状态：' -ForegroundColor White
foreach ($t in $TplTargets) {
    try {
        $pr = Get-TextFileProbe -Path $t.Path
    } catch {
        Write-Host ("   {0,-12} 无法读取（{1}）" -f $t.Name, $_.Exception.Message) -ForegroundColor Red
        continue
    }
    $counts = Get-NtsMarkerCounts $pr.Text
    $hash = Get-Sha256OfBytes ([System.IO.File]::ReadAllBytes($t.Path))
    $newest = @(Get-ChildItem -LiteralPath $BackupDir -Filter ("{0}.pristine-*.bak" -f $t.Name) -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending) | Select-Object -First 1
    $same = 'n/a'
    if ($newest) {
        $bHash = (Get-FileHash -LiteralPath $newest.FullName -Algorithm SHA256).Hash
        $same = $(if ($hash -eq $bHash) { '与备份逐字节一致' } else { '与备份不同' })
    }
    Write-Host ("   {0,-12} {1} 字节  标记 BEGIN={2} END={3}  {4}" -f $t.Name, $pr.RawBytesLen, $counts.Begin, $counts.End, $same) -ForegroundColor $(if ($counts.Begin -eq 0) { 'Green' } else { 'Red' })
}

Write-Host ''
Write-Host '  「停止自愈」标记：' -ForegroundColor White
if (Test-Path -LiteralPath $DisableFlag) {
    Write-Host ("    {0}（存在 → 插件下次启动不会重新注入）" -f $DisableFlag) -ForegroundColor Green
} else {
    Write-Host ("    {0}（不存在 → 插件下次启动可能重新注入！）" -f $DisableFlag) -ForegroundColor Red
}

Write-Host ''
Write-Host '  永久保留的备份（未删除任何一份）：' -ForegroundColor White
$allBackups = @(Get-ChildItem -LiteralPath $BackupDir -Filter '*.bak' -ErrorAction SilentlyContinue)
if ($allBackups.Count -eq 0) { Write-Host '    （无）' -ForegroundColor DarkGray }
else { foreach ($b in $allBackups | Sort-Object Name) { Write-Host ("    - {0}  ({1} 字节)" -f $b.Name, $b.Length) -ForegroundColor DarkGray } }

Write-Host ''
if ($script:Warnings.Count -gt 0) {
    Write-Host ("  警告 {0} 条：" -f $script:Warnings.Count) -ForegroundColor Yellow
    $n = 1
    foreach ($wn in $script:Warnings) { Write-Host ("   {0,2}. {1}" -f $n, $wn) -ForegroundColor Yellow; $n++ }
    Write-Host ''
    Write-Host ("  回滚完成，但有 {0} 处警告需要人工确认，用时 {1:N1} 秒。" -f $script:Warnings.Count, ((Get-Date) - $StartedAt).TotalSeconds) -ForegroundColor Yellow
    exit 2
}

Write-Host ("  完成：已还原到未安装状态，用时 {0:N1} 秒。" -f ((Get-Date) - $StartedAt).TotalSeconds) -ForegroundColor Green
Write-Host '  如需重新安装：pwsh -File install.ps1（安装成功会自动删除「停止自愈」标记）' -ForegroundColor Gray
exit 0
