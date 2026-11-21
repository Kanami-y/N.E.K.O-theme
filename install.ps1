#requires -version 5.1
<#
================================================================================
 N.E.K.O 主题工坊 (Neko Theme Studio) —— 安装脚本 install.ps1
================================================================================
 作用：把主题工坊的两件套（应用侧 CSS/JS + 插件）安装进 N.E.K.O 安装目录。

 它做下面这些事（A–H，对应契约 THEME_CONTRACT.md §1B / §5 / §6 / §8 / §9）：
   A. 环境检查：安装根 / 模板 / static 目录；非管理员时明确警告（写 resources\bin 可能被拒）
   B. 备份：模板「原始内容」按内容哈希备份到 theme-studio\backup\
   C. 复制两件套：plugin\static\loader\neko-theme-studio.{css,js} → resources\bin\static\
      （先复制资源、再写模板标记，避免标记指向还不存在的文件）
      版本单调性守卫：目标 loader 的 SCRIPT_VERSION 比源新时跳过覆盖并警告，
      除非显式 -ForceDowngrade（防止旧包把新版本降级）。
   D. 模板补丁（事务化）：先对全部目标模板做「只读预检」（锚点唯一 / Jinja 在 / 标记数正常 /
      不丢 </html> / 内容不骤减）；通过后把每个模板当前内容快照到 backup\txn-<时间戳>\，
      再用「临时文件 + Move-Item -Force」原子替换；任一模板写失败或写后复核失败
      → 全部模板从 txn 快照还原并报错退出（不再只回滚插件目录）。
   E. 用户数据保命 + 复制插件开发源：
      * 重装前把已安装插件的 static\theme.json、static\themes\、static\backgrounds\、
        static\exports\ 备份到 %LOCALAPPDATA%\N.E.K.O\theme-studio-backup\userdata-<时间戳>\；
      * theme-studio\plugin\ → .neko-plugin-installations\plugins\neko_theme_studio\ 构建暂存；
      * 复制完成后把用户数据写回暂存目录（static\presets\ 是随包内置只读预设，用新包内容，
        用户自定义同名预设请放在 static\themes\ 里）；
      * 旧插件目录先改名成回滚点；插件包版本比源新时跳过重建，除非 -ForceDowngrade。
   F. 构建 + 安装插件（走 48916 plugin-cli；48916 没开就跳过并警告）
      F6b 失败收尾：安装/验证失败时把旧目录还原，并保留「失败现场」与旧目录两份回滚点
      F7 确保插件处于运行态（面板读/写 entry 的前提）
   G. 验证：全部含锚点的模板标记恰好 1 次 + 资源哈希正确 / 两个静态文件 HTTP 200 /
      GET /chat 与 / 含标记 / 插件路由与运行态；并报告恢复了多少用户调色板变量
   H. 清理 + 报告：只有「新安装 + 验证」全部成功才删除旧回滚点、txn 快照和旧用户数据备份；
      失败时回滚点与用户数据备份全部保留，便于取证/手工恢复。

 幂等性（重要）：
   * 步骤 D 用标记注释先删后插，重复执行结果一致；事务快照只用于失败还原。
   * 步骤 B 用「原始内容哈希」命名备份文件，同一次原始内容只备份一次，且永不删除旧备份。
   * 步骤 E/F 采用「全量重建」：旧插件目录先改名成回滚点，重新复制并构建安装成功后才删除；
     安装失败会自动把旧目录还原回去，且**保留两份**回滚点（失败现场 + 旧目录）。
     旧回滚点只在新安装 + 验证全部成功后才删除。
     暂存目录必须在 build 之后、install-plan 之前删除，否则 install-plan 返回
     action=blocked / reason=install_source_ownership_unknown（归属由 plugins.lock.json 决定）。
     正确顺序：备份用户数据+旧目录 → 复制 → 写回用户数据 → build → 删暂存目录 →
     install-plan → install → reload → F7 → 验证 → 清理回滚点。
   * 步骤 C 覆盖式复制，天然幂等（版本守卫命中时跳过）。
   * 若 uninstall.ps1 留下了「停止自愈」标记（%LOCALAPPDATA%\N.E.K.O\theme-studio-disabled），
     本脚本安装成功后会删除它，让插件恢复自愈。

 硬约束（契约 §9）：
   * 绝不触碰 resources\app.asar 与 projectneko_server.exe。
   * 只在以下位置写入：
       <AppRoot>\resources\bin\static\
       <AppRoot>\resources\bin\templates\
       <AppRoot>\theme-studio\backup\
       %LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\  （构建暂存，构建后由本脚本删除）
       %LOCALAPPDATA%\N.E.K.O\.neko-plugin-packages\   （由 48916 自己写，不是本脚本写）

 用法（脚本未签名；请用 -NoProfile 调用，避免用户 profile 干扰）：
   powershell -NoProfile -File install.ps1
   powershell -NoProfile -File install.ps1 -Verify             # 只验证，不改任何文件
   powershell -NoProfile -File install.ps1 -SkipPluginInstall  # 只打模板补丁 + 复制两件套
   powershell -NoProfile -File install.ps1 -AppRoot 'D:\tools\enokoo'
   powershell -NoProfile -File install.ps1 -ForceDowngrade     # 允许用旧包覆盖更新的已安装版本
   若被执行策略拦截：请改用「管理员 PowerShell」运行，或自行给脚本签名；
   不要用 -ExecutionPolicy Bypass 绕过策略（企业环境常被策略/审计拦截）。
================================================================================
#>

[CmdletBinding()]
param(
    # N.E.K.O 安装根目录。省略时从本脚本位置自动推断（theme-studio\ 的上一级）
    [Parameter()][string] $AppRoot = '',

    # 只做验证，绝不写任何文件
    [Parameter()][switch] $Verify,

    # 只做「模板补丁 + 两件套复制」，不调用 48916（便于独立验证应用侧）
    [Parameter()][switch] $SkipPluginInstall,

    # 传给 48916 /plugin-cli/install 的 on_conflict（默认 fail，符合契约 §8）
    [Parameter()][ValidateSet('fail', 'overwrite', 'upgrade', 'replace')]
    [string] $PluginOnConflict = 'fail',

    # 插件源缺失 / 48916 未运行时是否算失败（默认只警告）
    [Parameter()][switch] $Strict,

    # 允许用旧包覆盖「已安装的新版本」（loader 的 SCRIPT_VERSION / 插件包 version）。
    # 默认目标版本更高时跳过覆盖并警告，避免误降级把用户正在用的新功能打回去。
    [Parameter()][switch] $ForceDowngrade,

    # 插件仓库根目录（plugin\ 与 app\ 所在）。省略时自动推断：
    # 脚本所在目录含 plugin\plugin.toml 就用它，否则退回 -AppRoot\theme-studio。
    # 用途：N.E.K.O 装在别的盘（例如 D:\o）而仓库仍在原处时，用 -AppRoot 只换安装根，
    # 源文件仍取仓库 —— 否则会误以为「缺少源文件」而写出没有内容哈希的旧式标记。
    [Parameter()][string] $RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 模板补丁标记（契约 §6）。
$MarkerBegin = '<!-- NTS:BEGIN -->'
$MarkerEnd   = '<!-- NTS:END -->'
# 标记块本身由 Get-NtsMarkerBlock 生成（URL 里拼上资源内容哈希，见下方说明）。

# 补丁锚点：dark-mode.css 的 <link> 行（插入到它之后）
$AnchorRegex = '<link[^>]*?/css/dark-mode\.css[^>]*?>'

# Jinja 变量存在性哨兵：每次写模板后都要还在
$JinjaSentinel = '{{ static_asset_version }}'

# 要复制的两件套
$AssetCssRel = 'css\neko-theme-studio.css'
$AssetJsRel  = 'neko-theme-studio.js'

# 插件
$PluginId           = 'neko_theme_studio'
$PackageFileName    = 'neko_theme_studio.neko-plugin'

# ---------------------------------------------------------------------------
# 输出辅助
# ---------------------------------------------------------------------------
function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
}
function Write-Step([string]$Text) { Write-Host ''; Write-Host "▶ $Text" -ForegroundColor White }
function Write-Ok([string]$Text)   { Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  [信息] $Text" -ForegroundColor Gray }
function Write-Warn2([string]$Text){ Write-Host "  [警告] $Text" -ForegroundColor Yellow }
function Write-Err2([string]$Text) { Write-Host "  [错误] $Text" -ForegroundColor Red }
function Write-Chg([string]$Text)  { Write-Host "  [变更] $Text" -ForegroundColor Magenta }

$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Changes  = New-Object System.Collections.Generic.List[string]
$script:Results  = New-Object System.Collections.Generic.List[object]

function Add-Warning([string]$Text) {
    $script:Warnings.Add($Text) | Out-Null
    Write-Warn2 $Text
}
function Add-Change([string]$Text) {
    $script:Changes.Add($Text) | Out-Null
    Write-Chg $Text
}
function Add-Result([string]$Name, [bool]$Pass, [string]$Detail) {
    $script:Results.Add([pscustomobject]@{ Name = $Name; Pass = $Pass; Detail = $Detail }) | Out-Null
    if ($Pass) { Write-Host ("  [通过] {0}  {1}" -f $Name, $Detail) -ForegroundColor Green }
    else       { Write-Host ("  [失败] {0}  {1}" -f $Name, $Detail) -ForegroundColor Red }
}

# ---------------------------------------------------------------------------
# 文件读写：保留 BOM 与行尾
# ---------------------------------------------------------------------------
function Get-TextFileProbe {
    <#  返回 @{ HasBom; Eol; Text(无 BOM); RawBytesLength }  #>
    param([Parameter(Mandatory)][string] $Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $false
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $hasBom = $true
    }
    # 严格 UTF-8 解码：非法字节直接抛异常，而不是像 `Encoding.UTF8.GetString` 那样
    # 静默替换成 U+FFFD —— 否则写回时会把模板里未识别的字节永久毁掉（不可恢复）。
    $utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        if ($hasBom) { $text = $utf8Strict.GetString($bytes, 3, $bytes.Length - 3) }
        else         { $text = $utf8Strict.GetString($bytes) }
    } catch {
        throw ("{0} 不是合法的 UTF-8（{1}）。为避免静默替换成 U+FFFD 写坏模板，已中止。" -f $Path, $_.Exception.Message)
    }
    $crlf   = ([regex]::Matches($text, "`r`n")).Count
    $lfAll  = ([regex]::Matches($text, "`n")).Count
    $loneLf = $lfAll - $crlf
    $eol = "`n"
    if ($lfAll -eq 0)              { $eol = "`n" }           # 无换行，任选
    elseif ($crlf -gt 0 -and $loneLf -eq 0) { $eol = "`r`n" } # 纯 CRLF
    elseif ($crlf -eq 0)           { $eol = "`n" }           # 纯 LF
    else { $eol = if ($crlf -ge $loneLf) { "`r`n" } else { "`n" } } # 混合：取多数
    return [pscustomobject]@{
        HasBom        = $hasBom
        Eol           = $eol
        Text          = $text
        RawBytesLen   = $bytes.Length
        CrlfCount     = $crlf
        LoneLfCount   = $loneLf
    }
}

function Write-TextFilePreserving {
    <#  按原 BOM 状态写回，内容里已使用原行尾。

        原子写：同目录临时文件 + 原子替换（File.Replace / File.Move），
        避免正在读模板的宿主进程（projectneko_server.exe）读到半截文件。
        注意不能直接用 Copy-Item / WriteAllText —— 那会先截断目标再写，存在竞态。 #>
    param(
        [Parameter(Mandatory)][string] $Path,
        [string] $Text,
        [bool]   $HasBom
    )
    if ($null -eq $Text) { $Text = '' }
    $enc = New-Object System.Text.UTF8Encoding($HasBom)
    $dir = Split-Path -Parent $Path
    $tmp = Join-Path $dir ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path), [System.Guid]::NewGuid().ToString('N'))
    $bytes = $enc.GetBytes($Text)
    if ($HasBom) {
        $preamble = $enc.GetPreamble()
        $all = New-Object byte[] ($preamble.Length + $bytes.Length)
        [System.Array]::Copy($preamble, 0, $all, 0, $preamble.Length)
        [System.Array]::Copy($bytes, 0, $all, $preamble.Length, $bytes.Length)
        $bytes = $all
    }
    $lastError = $null
    for ($i = 1; $i -le 4; $i++) {
        $bak = $tmp + '.old'
        try {
            [System.IO.File]::WriteAllBytes($tmp, $bytes)
            if (Test-Path -LiteralPath $Path) {
                # 原子替换：Move-Item -Force 在 NTFS 上走 MoveFileEx(REPLACE_EXISTING)，
                # 对读取方是原子的；不允许直接用 Set-Content / WriteAllText 先截断再写。
                Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
            } else {
                [System.IO.File]::Move($tmp, $Path)
            }
            return
        } catch {
            $lastError = $_
            try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } catch { }
            try { if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue } } catch { }
            Start-Sleep -Milliseconds 350
        }
    }
    throw "写入失败（重试 4 次）：$Path  -> $($lastError.Exception.Message)"
}

function Write-BytesAtomic {
    <#  按原始字节原子写文件（临时文件 + Move-Item -Force）。
        用于 theme.json / meta.json / plugin.toml 等「不允许半截内容」的写入。 #>
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Bytes
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = Join-Path $dir ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path), [System.Guid]::NewGuid().ToString('N'))
    $lastError = $null
    for ($i = 1; $i -le 4; $i++) {
        try {
            [System.IO.File]::WriteAllBytes($tmp, $Bytes)
            if (Test-Path -LiteralPath $Path) {
                Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
            } else {
                [System.IO.File]::Move($tmp, $Path)
            }
            return
        } catch {
            $lastError = $_
            try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } catch { }
            Start-Sleep -Milliseconds 300
        }
    }
    throw "写入失败（重试 4 次）：$Path  -> $($lastError.Exception.Message)"
}

function Get-NtsIntegrityLabel([string]$Path) {
    # 读取对象完整性级别（IL）。返回 Low / Medium / High / System / ''。
    #
    # 为什么需要：N.E.K.O 的插件子进程以 **Low IL** 运行
    # （projectneko_server.exe --multiprocessing-fork，实测）
    # 而本脚本常常以管理员提权运行。提权进程写出的文件/目录带 High IL，
    # Low 进程随后 CREATE 新文件会被 ACCESS_DENIED 拒绝 —— 表现为面板「应用」
    # 报 Errno 13、以及插件 startup 打补丁因备份失败而静默跳过。
    #
    # 读法：GetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION) 取 SACL，
    # 转 SDDL 后标签形如 S:(ML;;NW;;;LW) —— 末段 LW/ME/HI/SY 即级别。
    if (-not ('NtsIntegrity' -as [type])) {
        $ntsIlSrc = @'
using System;
using System.Runtime.InteropServices;

public static class NtsIntegrity {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetNamedSecurityInfoW(
        string name, int type, uint info,
        IntPtr owner, IntPtr group, IntPtr dacl,
        out IntPtr sacl, out IntPtr sd);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr sd, uint rev, uint info, out IntPtr text, out uint textLen);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr p);

    public static string GetLabelSddl(string path) {
        IntPtr sacl, sd;
        uint rc = GetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero,
                                        IntPtr.Zero, out sacl, out sd);
        if (rc != 0 || sd == IntPtr.Zero) { return "ERROR:" + rc; }
        try {
            IntPtr text;
            uint len;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x10, out text, out len)) {
                return "ERROR:convert";
            }
            try { return Marshal.PtrToStringUni(text); }
            finally { LocalFree(text); }
        }
        finally { LocalFree(sd); }
    }
}
'@
        Add-Type -TypeDefinition $ntsIlSrc -ErrorAction Stop | Out-Null
    }
    try {
        $sddl = [NtsIntegrity]::GetLabelSddl($Path)
    } catch {
        return ''
    }
    if ($sddl -match ';LW\)') { return 'Low' }
    if ($sddl -match ';ME\)') { return 'Medium' }
    if ($sddl -match ';HI\)') { return 'High' }
    if ($sddl -match ';SY\)') { return 'System' }
    return ''
}

function Set-NtsLowIntegrity([string]$Path) {
    # 把目录树显式降到 Low IL（(OI)(CI) 继承），让 Low IL 的插件进程能创建/覆盖文件。
    # 这是 no-op 安全操作：对象本来更高级别时修正为 Low；读取不受影响。
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $current = Get-NtsIntegrityLabel $Path
    if ($current -eq 'Low') { return $true }
    $out = & icacls $Path /setintegritylevel '(OI)(CI)L' /T /C 2>&1
    $failed = @($out | Where-Object {
            # icacls 成功时也会打印 "Failed processing 0 files"，只统计非 0 的失败数
            if ($_ -match 'Failed processing\s+(\d+)') { [int]$Matches[1] -gt 0 }
            elseif ($_ -match '失败|拒绝|denied') { $true }
            else { $false }
        })
    if ($failed.Count -gt 0) {
        Write-Warn2 ("设置完整性级别失败（{0} 项）：{1}" -f $failed.Count, ($failed[0] -join ' '))
    }
    return ((Get-NtsIntegrityLabel $Path) -eq 'Low')
}

function Get-Sha256OfText([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Get-Sha256OfBytes([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

# ---------------------------------------------------------------------------
# 标记块处理（行级，保留其余行结构）
# ---------------------------------------------------------------------------
function Split-TextLines([string]$Text, [string]$Eol) {
    $parts = $Text -split "`n"
    for ($i = 0; $i -lt $parts.Count; $i++) { $parts[$i] = $parts[$i].TrimEnd([char]13) }
    return ,$parts
}
function Join-TextLines([string[]]$Lines, [string]$Eol) {
    if ($null -eq $Lines) { return '' }
    return ($Lines -join $Eol)
}

function Get-NtsMarkerBlock {
    <#  生成补丁标记块。
        URL 后缀为什么必须带内容哈希：
          48911 对带 ?v= 的 /static/* 一律回 Cache-Control: public, max-age=31536000, immutable，
          浏览器在一年内永不重取。而模板里的 {{ static_asset_version }} 是进程启动时
          固定下来的（实测改文件、改 mtime 都不会变），于是「只换文件不换 URL」的热更新
          永远追不到新内容。把资源内容哈希拼进 URL：内容一变 URL 就变，缓存必然失效。
          插件自身的 _app_patch.py 用同一套规则（MARKER 一致性靠这里对齐）。  #>
    param([string]$CssHash = '', [string]$JsHash = '')
    $base = '?v={{ static_asset_version }}'
    if ($CssHash) { $cssUrl = $base + '-' + $CssHash } else { $cssUrl = $base }
    if ($JsHash)  { $jsUrl  = $base + '-' + $JsHash }  else { $jsUrl  = $base }
    return ($MarkerBegin +
        '<link rel="stylesheet" href="/static/css/neko-theme-studio.css' + $cssUrl + '">' +
        '<script src="/static/neko-theme-studio.js' + $jsUrl + '" defer></script>' +
        $MarkerEnd)
}

function Get-ResourceHash8([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 8).ToLowerInvariant()
}

function Remove-NtsBlockLines {
    <#  行级删除 NTS 标记段。返回 @{ Lines; Removed; Unterminated }.
        注意 1：不要把 $Lines 标成 Mandatory —— PowerShell 会因数组里的空字符串行而绑定失败。
        注意 2：用 IndexOf/Substring 做字面量剥离，不用 -replace。
                （`-replace A + B` 在 PowerShell 里会被解析成「字符串拼接」而不是一个正则模式，
                  导致模式永远匹配不上 —— 这是本项目踩过的坑。）  #>
    param([string[]] $Lines)
    if ($null -eq $Lines) { throw '内部错误：Remove-NtsBlockLines 收到空行数组。' }
    $out = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $unterminated = 0
    $i = 0
    while ($i -lt $Lines.Count) {
        $line = $Lines[$i]
        $b = $line.IndexOf($MarkerBegin)
        $e = $line.IndexOf($MarkerEnd)

        if ($b -ge 0 -and $e -gt $b) {
            # 单行块：BEGIN 与 END 在同一行
            $combined = $line.Substring(0, $b) + $line.Substring($e + $MarkerEnd.Length)
            $removed++
            if (-not [string]::IsNullOrWhiteSpace($combined)) { $out.Add($combined) }
            $i++
            continue
        }

        if ($b -ge 0) {
            # BEGIN 在本行、END 在后续行 → 多行块
            $removed++
            $j = $i + 1
            while ($j -lt $Lines.Count -and $Lines[$j].IndexOf($MarkerEnd) -lt 0) { $j++ }
            if ($j -lt $Lines.Count) {
                $tail = $Lines[$j]
                $idxEnd = $tail.IndexOf($MarkerEnd)
                $rest = $tail.Substring($idxEnd + $MarkerEnd.Length)
                if (-not [string]::IsNullOrWhiteSpace($rest)) { $out.Add($rest) }
                $i = $j + 1
            } else {
                # 有 BEGIN 却没有 END：模板可能已损坏。只剥离标记文本，绝不丢弃后面的内容。
                $unterminated++
                $stripped = $line.Substring(0, $b) + $line.Substring($b + $MarkerBegin.Length)
                if (-not [string]::IsNullOrWhiteSpace($stripped)) { $out.Add($stripped) }
                $i++
            }
            continue
        }

        if ($e -ge 0) {
            # 孤立的结束标记
            $removed++
            $stripped = $line.Substring(0, $e) + $line.Substring($e + $MarkerEnd.Length)
            if (-not [string]::IsNullOrWhiteSpace($stripped)) { $out.Add($stripped) }
            $i++
            continue
        }

        $out.Add($line)
        $i++
    }
    return [pscustomobject]@{ Lines = $out.ToArray(); Removed = $removed; Unterminated = $unterminated }
}

function Get-NtsMarkerCounts([string]$Text) {
    return [pscustomobject]@{
        Begin = ([regex]::Matches($Text, [regex]::Escape($MarkerBegin))).Count
        End   = ([regex]::Matches($Text, [regex]::Escape($MarkerEnd))).Count
    }
}

function Get-PristineText([string]$Text, [string]$Eol) {
    <#  「原始内容」= 去掉 NTS 段后的内容。
        行尾沿用文件原有行尾 → 对于「未被补丁过的模板」，该字符串与磁盘原始字节完全一致。  #>
    $lines = Split-TextLines -Text $Text -Eol $Eol
    $r = Remove-NtsBlockLines -Lines $lines
    return (($r.Lines | ForEach-Object { $_.TrimEnd([char]13) }) -join $Eol)
}

# ---------------------------------------------------------------------------
# 网络
# ---------------------------------------------------------------------------
function Test-TcpPort {
    param([string] $TargetHost = '127.0.0.1', [Parameter(Mandatory)][int] $Port, [int] $TimeoutMs = 1500)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($iar)
        return $client.Connected
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

function Invoke-Http {
    <#  返回 @{ Ok; StatusCode; Body }。Body 按 UTF-8 解码。  #>
    param(
        [Parameter(Mandatory)][string] $Uri,
        [string] $Method = 'GET',
        [string] $JsonBody = $null,
        [int] $TimeoutMs = 60000
    )
    $req = [System.Net.HttpWebRequest]::Create($Uri)
    $req.Method           = $Method
    $req.Timeout          = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy            = $null
    $req.UserAgent        = 'NTS-Installer/1.0'

    if (-not [string]::IsNullOrEmpty($JsonBody)) {
        # 契约 §8：请求体必须显式 UTF-8 字节，否则含 CJK 的路径会变成 C:\Users\?\...
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
        $req.ContentType   = 'application/json; charset=utf-8'
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
    } catch {
        return [pscustomobject]@{ Ok = $false; StatusCode = 0; Body = $_.Exception.Message }
    }
}

function ConvertTo-JsonStringLiteral([string]$Value) {
    <#  手写 JSON 字符串字面量：只转义 \ 和 "，CJK 原样保留（随后整体以 UTF-8 字节发出）  #>
    $v = $Value.Replace('\', '\\').Replace('"', '\"')
    return '"' + $v + '"'
}

function Get-Short([string]$Text, [int]$Max = 400) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $t = $Text -replace '\s+', ' '
    if ($t.Length -le $Max) { return $t }
    return $t.Substring(0, $Max) + '…'
}

# ---------------------------------------------------------------------------
# 版本单调性 / 用户数据保命 / 失败回滚 辅助函数
# ---------------------------------------------------------------------------
function ConvertTo-NtsVersion([string]$Text) {
    <#  把 "1.5.11" / "0.1.11-beta.1" 解析成 [version]（无法解析返回 $null）。
        版本守卫只比较数字段，预发布后缀不参与比较。 #>
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $m = [regex]::Match($Text, '([0-9]+(?:\.[0-9]+){1,3})')
    if (-not $m.Success) { return $null }
    try { return [version]$m.Groups[1].Value } catch { return $null }
}

function Get-LoaderScriptVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try {
        $text = [System.IO.File]::ReadAllText($Path)
    } catch { return '' }
    $m = [regex]::Match($text, "SCRIPT_VERSION\s*=\s*'([0-9]+(?:\.[0-9]+)*)'")
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-TomlPackageVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try {
        $text = [System.IO.File]::ReadAllText($Path)
    } catch { return '' }
    $m = [regex]::Match($text, '(?m)^\s*version\s*=\s*"([^"]+)"')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Test-NtsDowngrade([string]$TargetVersion, [string]$SourceVersion) {
    <#  目标已安装版本严格大于源版本 → $true（表示「这次会是降级」）。 #>
    $t = ConvertTo-NtsVersion $TargetVersion
    $s = ConvertTo-NtsVersion $SourceVersion
    if ($null -eq $t -or $null -eq $s) { return $false }
    return ($t -gt $s)
}

function Get-ThemeVarCount([byte[]]$Bytes) {
    <#  统计 theme.json 里的调色板变量数：vars + dark_vars 的键数（用户可见的是两者之和）。 #>
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return 0 }
    try {
        $text = [System.Text.Encoding]::UTF8.GetString($Bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        $obj = $text | ConvertFrom-Json
    } catch { return 0 }
    $count = 0
    foreach ($name in @('vars', 'dark_vars')) {
        $bag = $obj.PSObject.Properties[$name]
        if ($bag -and $bag.Value) {
            $count += @($bag.Value.PSObject.Properties).Count
        }
    }
    return $count
}

function Copy-DirectoryContents {
    <#  把 $Source 目录下的所有内容（含子目录）逐个复制进 $Destination，返回复制后的文件数。

        为什么不能写成 Copy-Item -LiteralPath (Join-Path $Source '*')：
        PowerShell 5.1 的 -LiteralPath 不展开通配符，这种写法既不抛异常、也不复制
        任何文件（实测复制后目录里 0 个文件）。而调用方是用 Get-ChildItem 统计源
        文件数的，于是日志会打印「已备份 N 个文件」，实际一个都没备 —— 升级时
        用户的主题、背景图、导出一旦被清掉就再也找不回来。

        逐文件复制还有个好处：某个文件被占用时错误会停在那一个文件上（-ErrorAction Stop），
        调用方可以用返回值判断是否完整，而不是安静地半途而废。 #>
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $items = @(Get-ChildItem -LiteralPath $Source -Force -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        # 整项复制（目录会自动递归），不做相对路径运算：8.3 短名路径（TEMP 下的
        # C:\Users\ADMINI~1\...）会让 Substring 切错位置，把文件塞进多出来的子目录里。
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force -ErrorAction Stop
    }
    return @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Force -ErrorAction SilentlyContinue).Count
}

function Backup-NtsUserData {
    <#  把已安装插件里的全部用户数据备份到
        %LOCALAPPDATA%\N.E.K.O\theme-studio-backup\userdata-<时间戳>\：
          theme.json、schedule.json、themes\、backgrounds\、exports\
        presets\ 不备份（随包内置只读，安装时用新包内容）。
        返回对象供 Restore-NtsUserData 使用；失败直接抛异常（调用方按失败处理）。 #>
    param(
        [Parameter(Mandatory)][string] $PluginDir,
        [Parameter(Mandatory)][string] $Stamp
    )
    $bakDir = Join-Path $UserDataBackupRoot ('userdata-' + $Stamp)
    if (-not (Test-Path -LiteralPath $bakDir)) { New-Item -ItemType Directory -Force -Path $bakDir | Out-Null }

    $data = [pscustomobject]@{
        Dir             = $bakDir
        ThemeBytes      = $null
        ThemeVarCount   = 0
        ThemeBakPath    = ''
        # 「按时段自动换主题」的排程（v0.4.13）。与 theme.json 同级：都在 static\ 下、
        # 都是用户数据。漏备份它，重装一次排程就没了，而用户完全看不出为什么。
        ScheduleBytes   = $null
        ScheduleBakPath = ''
        ScheduleExists  = $false
        SubDirs         = @{}
        Counts          = @{}
    }

    $themeSrc = Join-Path $PluginDir 'static\theme.json'
    if (Test-Path -LiteralPath $themeSrc -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($themeSrc)
        $themeBak = Join-Path $bakDir 'theme.json'
        Write-BytesAtomic -Path $themeBak -Bytes $bytes
        $data.ThemeBytes = $bytes
        $data.ThemeVarCount = Get-ThemeVarCount $bytes
        $data.ThemeBakPath = $themeBak
        Write-Ok ("已备份用户调色板 → {0}（{1} 字节，{2} 个变量）" -f $themeBak, $bytes.Length, $data.ThemeVarCount)
    } else {
        Write-Info "已安装插件没有 static\theme.json（首次安装或插件未安装），无需备份调色板。"
    }

    $scheduleSrc = Join-Path $PluginDir 'static\schedule.json'
    if (Test-Path -LiteralPath $scheduleSrc -PathType Leaf) {
        $schedBytes = [System.IO.File]::ReadAllBytes($scheduleSrc)
        $schedBak = Join-Path $bakDir 'schedule.json'
        Write-BytesAtomic -Path $schedBak -Bytes $schedBytes
        $data.ScheduleBytes = $schedBytes
        $data.ScheduleBakPath = $schedBak
        $data.ScheduleExists = $true
        Write-Ok ("已备份自动换主题排程 → {0}（{1} 字节）" -f $schedBak, $schedBytes.Length)
    } else {
        Write-Info "已安装插件没有 static\schedule.json（没有设置过自动换主题），无需备份。"
    }

    foreach ($sub in @('themes', 'backgrounds', 'exports')) {
        $srcDir = Join-Path $PluginDir ('static\' + $sub)
        if (-not (Test-Path -LiteralPath $srcDir -PathType Container)) { continue }
        $dstDir = Join-Path $bakDir $sub
        $srcCount = @(Get-ChildItem -LiteralPath $srcDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
        $copiedCount = Copy-DirectoryContents -Source $srcDir -Destination $dstDir
        if ($copiedCount -ne $srcCount) {
            # 备份不完整就中止：后面成功路径会删掉旧插件目录与历史备份，
            # 一旦这里少拷一个文件，用户那套主题就永久没了。
            throw ("备份用户数据 static\{0}\ 失败：源目录 {1} 个文件，备份后只有 {2} 个。已中止安装以免丢失。" -f $sub, $srcCount, $copiedCount)
        }
        $data.SubDirs[$sub] = $dstDir
        $data.Counts[$sub] = $srcCount
        Write-Ok ("已备份用户数据 static\{0}\ → {1}（{2} 个文件）" -f $sub, $dstDir, $srcCount)
    }

    $meta = [pscustomobject]@{
        created_at      = (Get-Date).ToString('s')
        source_plugin   = $PluginDir
        theme_bytes     = $(if ($data.ThemeBytes) { $data.ThemeBytes.Length } else { 0 })
        theme_vars      = $data.ThemeVarCount
        has_schedule    = $data.ScheduleExists
        subdir_files    = $data.Counts
        app_root        = $AppRoot
    }
    $metaPath = Join-Path $bakDir 'meta.json'
    Write-TextFilePreserving -Path $metaPath -Text (($meta | ConvertTo-Json -Depth 5) + "`n") -HasBom $false
    return $data
}

function Restore-NtsUserData {
    <#  把 Backup-NtsUserData 的产物写回目标插件目录（新复制出来的暂存目录）。
        用户同名文件优先；presets\ 不动（用新包内置内容）。返回恢复的变量数。 #>
    param(
        [Parameter(Mandatory)][string] $PluginDir,
        [Parameter(Mandatory)] $Data
    )
    if ($null -eq $Data) { return 0 }
    $restoredVars = 0
    if ($Data.ThemeBytes -and $Data.ThemeBytes.Length -gt 0) {
        $dstTheme = Join-Path $PluginDir 'static\theme.json'
        Write-BytesAtomic -Path $dstTheme -Bytes $Data.ThemeBytes
        $restoredVars = Get-ThemeVarCount $Data.ThemeBytes
    }
    # 排程优先用备份；备份里没有就保持新包里的原样（首次安装时本来就没有）。
    if ($Data.PSObject.Properties['ScheduleBytes'] -and $Data.ScheduleBytes -and $Data.ScheduleBytes.Length -gt 0) {
        $dstSchedule = Join-Path $PluginDir 'static\schedule.json'
        Write-BytesAtomic -Path $dstSchedule -Bytes $Data.ScheduleBytes
        Write-Ok ("已恢复自动换主题排程 → {0}" -f $dstSchedule)
    }
    foreach ($sub in @('themes', 'backgrounds', 'exports')) {
        if (-not $Data.SubDirs.ContainsKey($sub)) { continue }
        $srcDir = $Data.SubDirs[$sub]
        if (-not (Test-Path -LiteralPath $srcDir -PathType Container)) { continue }
        $dstDir = Join-Path $PluginDir ('static\' + $sub)
        $srcCount = @(Get-ChildItem -LiteralPath $srcDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
        $copiedCount = Copy-DirectoryContents -Source $srcDir -Destination $dstDir
        if ($copiedCount -lt $srcCount) {
            # 恢复失败不该静默：用户数据已经在备份目录里（不会丢），但要让人知道他得手动补。
            Write-Warn2 ("恢复用户数据 static\{0}\ 不完整：备份里有 {1} 个文件，只写回 {2} 个；备份仍在 {3}，可手动拷回。" -f $sub, $srcCount, $copiedCount, $srcDir)
        }
    }
    return $restoredVars
}

function Invoke-NtsFailureRollback {
    <#  终止性错误（throw / 未捕获异常）的统一回滚：
        1) 模板：从 backup\txn-<时间戳>\ 快照逐个原子写回；
        2) 插件目录：把「失败现场」改名成 failed-<时间戳> 保留，再把旧目录回滚点还原；
        3) 用户数据：把 userdata-<时间戳>\ 备份写回当前插件目录。
        任何一步失败只警告不抛异常（回滚过程中再抛异常会掩盖原始错误）。 #>
    if ($script:NtsRollbackRunning) { return }
    $script:NtsRollbackRunning = $true
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    Write-Host ''
    Write-Err2 '安装中止：开始回滚（模板 → 插件目录 → 用户数据）…'

    foreach ($entry in @($script:TemplateTxnEntries)) {
        try {
            if (-not (Test-Path -LiteralPath $entry.Bak -PathType Leaf)) { continue }
            $bytes = [System.IO.File]::ReadAllBytes($entry.Bak)
            Write-BytesAtomic -Path $entry.Path -Bytes $bytes
            Write-Ok ("模板已还原：{0}" -f (Split-Path -Leaf $entry.Path))
        } catch {
            Write-Err2 ("模板还原失败：{0} —— {1}" -f $entry.Path, $_.Exception.Message)
        }
    }

    if ($script:PluginBakDir -and (Test-Path -LiteralPath $script:PluginBakDir)) {
        $failedDir = Join-Path $PluginRollbackRoot ($PluginId + '.failed-' + $stamp)
        if (Test-Path -LiteralPath $script:UserPluginDir) {
            try {
                Move-Item -LiteralPath $script:UserPluginDir -Destination $failedDir -Force -ErrorAction Stop
                Write-Ok ("失败现场已保留：{0}" -f $failedDir)
            } catch {
                Write-Warn2 ("失败现场改名失败（{0}），直接覆盖删除：{1}" -f $_.Exception.Message, $script:UserPluginDir)
                Remove-Item -LiteralPath $script:UserPluginDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        try {
            Move-Item -LiteralPath $script:PluginBakDir -Destination $script:UserPluginDir -Force -ErrorAction Stop
            Write-Ok ("旧插件目录已还原：{0}" -f $script:UserPluginDir)
        } catch {
            Write-Err2 ("旧插件目录还原失败（{0}）。回滚备份仍在：{1}" -f $_.Exception.Message, $script:PluginBakDir)
        }
    }

    if ($script:UserDataBackup -and (Test-Path -LiteralPath $script:UserPluginDir)) {
        try {
            $n = Restore-NtsUserData -PluginDir $script:UserPluginDir -Data $script:UserDataBackup
            Write-Ok ("用户数据已还原到插件目录（{0} 个调色板变量）" -f $n)
        } catch {
            Write-Err2 ("用户数据还原失败：{0}。备份仍在：{1}" -f $_.Exception.Message, $script:UserDataBackup.Dir)
        }
    }

    Write-Host ''
    Write-Host '  回滚完成。以下备份全部保留，供取证/手工恢复：' -ForegroundColor Yellow
    if ($script:TemplateTxnDir) { Write-Host ("    模板事务快照：{0}" -f $script:TemplateTxnDir) -ForegroundColor Gray }
    if ($script:PluginBakDir)   { Write-Host ("    旧插件目录：{0}" -f $script:PluginBakDir) -ForegroundColor Gray }
    if ($script:UserDataBackup) { Write-Host ("    用户数据：{0}" -f $script:UserDataBackup.Dir) -ForegroundColor Gray }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
$StartedAt = Get-Date
Write-Host ''
Write-Host '  N.E.K.O 主题工坊 —— 安装脚本 (install.ps1)' -ForegroundColor Cyan
Write-Host ("  运行时间 {0}   模式 {1}" -f $StartedAt.ToString('yyyy-MM-dd HH:mm:ss'), $(if ($Verify) { '仅验证 -Verify' } elseif ($SkipPluginInstall) { '跳过插件安装 -SkipPluginInstall' } else { '完整安装' })) -ForegroundColor DarkGray

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ("  提示：当前是 Windows PowerShell {0}，脚本按 PowerShell 7 编写但兼容运行。" -f $PSVersionTable.PSVersion) -ForegroundColor DarkYellow
}

# 路径推导（不硬编码用户名，也不硬编码安装位置）
#
# -AppRoot 省略时从本脚本自身位置反推：theme-studio\ 的上一级就是 N.E.K.O 安装根。
# 这样整个 theme-studio 目录拷到别的机器、别的盘符都能直接跑，无需改脚本。
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw '无法自动推断 -AppRoot（$PSScriptRoot 为空）。请显式传入 -AppRoot "<N.E.K.O 安装根>"。'
    }
    $AppRoot = Split-Path -Parent $PSScriptRoot
    Write-Host ("  自动推断安装根：{0}（来自脚本位置 {1}）" -f $AppRoot, $PSScriptRoot) -ForegroundColor DarkGray
}
$AppRoot     = $AppRoot.TrimEnd('\')

if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'resources\bin\templates'))) {
    throw ("-AppRoot 指向的目录不是 N.E.K.O 安装根：'{0}' 下没有 resources\bin\templates。请用 -AppRoot 指定正确路径。" -f $AppRoot)
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $scriptRepo = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { '' } else { $PSScriptRoot }
    if ($scriptRepo -and (Test-Path -LiteralPath (Join-Path $scriptRepo 'plugin\plugin.toml'))) {
        $RepoRoot = $scriptRepo
    } else {
        $RepoRoot = Join-Path $AppRoot 'theme-studio'
    }
}
$RepoRoot    = $RepoRoot.TrimEnd('\')
$ThemeRoot   = $RepoRoot
$BackupDir   = Join-Path $ThemeRoot 'backup'
$TemplateDir = Join-Path $AppRoot 'resources\bin\templates'
$StaticDir   = Join-Path $AppRoot 'resources\bin\static'
$LocalAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
    $LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
}
$NekoDataDir      = Join-Path $LocalAppData 'N.E.K.O'
$UserPluginsRoot  = Join-Path $NekoDataDir 'plugins'
# 实测结论：root_id 'user' 的构建源解析到 .neko-plugin-installations\plugins\<id>\
# （而非 plugins\<id>\）。build 只读这个目录，install 之后再把它写回去。
$InstallPluginsRoot = Join-Path $NekoDataDir '.neko-plugin-installations\plugins'
$UserPluginDir    = Join-Path $InstallPluginsRoot $PluginId
# 回滚点必须放在 .neko-plugin-installations\plugins 之外：
# install-plan 会把那个目录下任何含 plugin.toml 的子目录当成一份「已安装」的插件。
# 旧版把回滚点放在同级 <id>.bak → 重装时 action=blocked reason=multiple_installations，
# 插件根本没更新（已安装用户重跑安装必踩）。
$PluginRollbackRoot = Join-Path $BackupDir 'plugin-rollback'
$PackageDir       = Join-Path $NekoDataDir '.neko-plugin-packages'
$LockFilePath     = Join-Path $NekoDataDir 'plugins.lock.json'
$LogDir           = Join-Path $NekoDataDir 'logs'
$PackagePath      = Join-Path $PackageDir $PackageFileName
$PluginSrc        = Join-Path $ThemeRoot 'plugin'
# 两件套的**唯一源**是插件自带的 plugin\static\loader\（插件自愈用的也是这份）。
# 旧版读的是仓库根的 app\ 镜像，而 tools/package-dist.ps1 一直把 app\ 排除在发布包外
# —— 于是「按文档解压安装包再跑 install.ps1」时源文件不存在，哈希算不出来、标记里
# 没有 -<hash8>，G 段必然失败（模板已被改、资源一件没部署、退出码红）。模板已常驻。
$AssetCssSrc      = Join-Path $ThemeRoot 'plugin\static\loader\neko-theme-studio.css'
$AssetJsSrc       = Join-Path $ThemeRoot 'plugin\static\loader\neko-theme-studio.js'
foreach ($assetCheck in @(
        [pscustomobject]@{ Label = 'CSS'; Path = $AssetCssSrc },
        [pscustomobject]@{ Label = 'JS';  Path = $AssetJsSrc })) {
    if (-not (Test-Path -LiteralPath $assetCheck.Path -PathType Leaf)) {
        # 在任何写操作之前失败：否则会留下「模板改了、资源没部署」的半成品。
        throw ("缺少 loader 源文件（{0}）：{1}。发布包必须包含 plugin\static\loader\ 两件套。" -f $assetCheck.Label, $assetCheck.Path)
    }
}
$AssetCssDst      = Join-Path $StaticDir $AssetCssRel
$AssetJsDst       = Join-Path $StaticDir $AssetJsRel
$TplIndex         = Join-Path $TemplateDir 'index.html'
$TplChat          = Join-Path $TemplateDir 'chat.html'
$TplTargets       = @(
    [pscustomobject]@{ Name = 'chat.html';  Path = $TplChat  },
    [pscustomobject]@{ Name = 'index.html'; Path = $TplIndex }
)

# 标记块：URL 带资源内容哈希（穿透 immutable 缓存，见 Get-NtsMarkerBlock 的说明）。
# 哈希取自「源」文件 —— 步骤 C 会把源复制到目标并校验哈希一致，所以两者等价。
$AssetCssHash8 = Get-ResourceHash8 $AssetCssSrc
$AssetJsHash8  = Get-ResourceHash8 $AssetJsSrc
$MarkerBlock   = Get-NtsMarkerBlock -CssHash $AssetCssHash8 -JsHash $AssetJsHash8

# 端口允许环境变量覆盖：只用于隔离测试/非默认部署，正常安装无需设置。
$AppPort    = if ($env:NEKO_NTS_APP_PORT)    { [int]$env:NEKO_NTS_APP_PORT }    else { 48911 }
$PluginPort = if ($env:NEKO_NTS_PLUGIN_PORT) { [int]$env:NEKO_NTS_PLUGIN_PORT } else { 48916 }

# 卸载脚本写的「停止自愈」标记（plugin/_app_patch.py 会检查它）：
# 成功安装后必须删除，否则插件 startup 会一直跳过应用侧补丁自愈。
$DisableFlag = if ($env:NEKO_NTS_DISABLE_FILE) { $env:NEKO_NTS_DISABLE_FILE } else { Join-Path $NekoDataDir 'theme-studio-disabled' }

# 用户调色板（已安装插件的 static\theme.json，版本号随用户改色自增）在重装前
# 备份到这里、装完写回；否则全量重建插件目录会把用户辛苦调的颜色重置成出厂默认。
$UserThemeBak = Join-Path $BackupDir 'user-theme.json'
$UserThemeSrc = Join-Path $PluginSrc 'static\theme.json'

# 用户数据（调色板 + themes/backgrounds/exports）的备份根。
# 与插件自愈/官方备份共用 %LOCALAPPDATA%\N.E.K.O\theme-studio-backup\，
# 每次安装一个 userdata-<时间戳>\ 子目录，失败时整份还原、成功后才清理旧备份。
$UserDataBackupRoot = Join-Path $NekoDataDir 'theme-studio-backup'

# 本次安装的运行时状态（失败回滚用）。-Verify 模式只读，这些变量保持空值。
$script:TemplateTxnDir     = $null
$script:TemplateTxnEntries = New-Object System.Collections.Generic.List[object]
$script:PluginBakDir       = $null
$script:UserDataBackup     = $null
$script:UserThemeRestoredVars = 0
$script:NtsRollbackRunning = $false
$script:PriorRollbackDirs  = New-Object System.Collections.Generic.List[string]

# ---------------------------------------------------------------------------
# A. 环境检查
# ---------------------------------------------------------------------------
Write-Head 'A. 环境检查'

$envProblems = New-Object System.Collections.Generic.List[string]
foreach ($p in @($AppRoot, $TemplateDir, $StaticDir)) {
    if (-not (Test-Path -LiteralPath $p)) { $envProblems.Add("缺少路径：$p") }
}
foreach ($f in @($TplIndex, $TplChat)) {
    if (-not (Test-Path -LiteralPath $f)) { $envProblems.Add("缺少模板：$f") }
}
$exePath = Join-Path $AppRoot 'N.E.K.O.exe'
$srvPath = Join-Path $AppRoot 'resources\bin\projectneko_server.exe'
if (-not (Test-Path -LiteralPath $exePath)) { $envProblems.Add("未找到应用主程序：$exePath") }

if ($envProblems.Count -gt 0) {
    foreach ($p in $envProblems) { Write-Err2 $p }
    Write-Err2 "安装根似乎不是有效的 N.E.K.O 安装目录，请用 -AppRoot 指定正确路径。"
    exit 1
}

Write-Ok "安装根：$AppRoot"
Write-Ok "模板目录：$TemplateDir"
Write-Ok "静态目录：$StaticDir"
Write-Ok "插件构建暂存根：$InstallPluginsRoot"
if (Test-Path -LiteralPath $srvPath) { Write-Info "服务端：$srvPath" } else { Write-Warn2 "未找到 projectneko_server.exe（不阻塞，但请确认安装完整性）" }

# 契约 §9 硬规则自检：确认我们从不触碰它们
Write-Info "硬约束：本脚本不读写 resources\app.asar 与 projectneko_server.exe（契约 §9）"

# 提权检测：写 <AppRoot>\resources\bin 在受保护目录（Program Files 等）需要管理员。
# 不静默继续：明确提示用户可能失败以及怎么处理，但仍继续尝试（有些安装目录是用户可写的）。
$IsAdmin = $false
try {
    $wi = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $wp = New-Object System.Security.Principal.WindowsPrincipal($wi)
    $IsAdmin = $wp.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $IsAdmin = $false }
if (-not $IsAdmin) {
    Write-Warn2 '当前不是管理员：写入 resources\bin\static 或模板目录可能被系统拒绝（Access denied）。'
    Write-Warn2 '  建议：以「管理员身份运行 PowerShell」，再执行 powershell -NoProfile -File install.ps1'
    Write-Warn2 '  若安装根在用户可写目录（如 D:\be），可忽略本提示；脚本会继续，失败时优先怀疑权限。'
    Add-Warning '非管理员运行：若写入 resources\bin / templates 失败，请改用管理员 PowerShell 重跑。'
} else {
    Write-Info '提权检查：当前已是管理员，写入 resources\bin 不受权限限制。'
}

$p48911 = Test-TcpPort -Port $AppPort
$p48916 = Test-TcpPort -Port $PluginPort
Write-Info ("端口 {0}(应用) : {1}    端口 {2}(插件) : {3}" -f $AppPort, $(if ($p48911) { '在监听' } else { '未监听' }), $PluginPort, $(if ($p48916) { '在监听' } else { '未监听' }))

# 读一遍模板，记录原始特征
$probes = @{}
foreach ($t in $TplTargets) {
    $probes[$t.Name] = Get-TextFileProbe -Path $t.Path
    $pr = $probes[$t.Name]
    $eolName = if ($pr.Eol -eq "`r`n") { 'CRLF' } else { 'LF' }
    Write-Info ("{0}：{1} 字节，行尾 {2}，BOM {3}" -f $t.Name, $pr.RawBytesLen, $eolName, $(if ($pr.HasBom) { '有' } else { '无' }))
}

# ---------------------------------------------------------------------------
# -Verify 模式：只验证，不写任何文件
# ---------------------------------------------------------------------------
function Get-VerificationTemplateTargets {
    <#  验证目标 = chat/index + 所有原生带 dark-mode.css 锚点的模板。
        与 uninstall.ps1 的模板发现逻辑一致。插件自愈会给这些页面全部打标记，
        只验 chat/index 会让其余 20+ 个窗口的「标记丢失 / 静态 404」全部漏检。  #>
    $list = New-Object System.Collections.Generic.List[object]
    $names = @{}
    foreach ($t in $TplTargets) {
        $list.Add($t) | Out-Null
        $names[$t.Name] = $true
    }
    try {
        $files = @(Get-ChildItem -LiteralPath $TemplateDir -Filter '*.html' -File -ErrorAction SilentlyContinue)
    } catch { $files = @() }
    foreach ($f in $files) {
        if ($names.ContainsKey($f.Name)) { continue }
        try { $probe = Get-TextFileProbe -Path $f.FullName } catch { continue }
        if ($probe.Text -match $AnchorRegex) {
            $list.Add([pscustomobject]@{ Name = $f.Name; Path = $f.FullName }) | Out-Null
        }
    }
    return $list.ToArray()
}

function Wait-NtsTemplatePropagation {
    <#  等插件自愈把页面标记补齐。

        背景：D 段只同步写 chat/index 两个模板；其余 20+ 个窗口由插件 startup 的
        **异步线程**补（POST /plugin/<id>/start 立刻返回 queued，真正打标记发生在
        daemon 线程里）。旧版 F7 一启动完就进 G，于是纯净宿主机首装必然报几十项
        「找不到 NTS:BEGIN」并以 exit 1 收场 —— 而作者本机 23 个模板早就有标记，
        所以这个缺陷在开发机上永远看不到。

        这里主动等：每 0.7 秒扫一次磁盘，最多 $TimeoutSeconds 秒。  #>
    param(
        [Parameter(Mandatory)][object[]]$Targets,
        [int]$TimeoutSeconds = 45
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $missing = @()
        foreach ($t in $Targets) {
            try { $pr = Get-TextFileProbe -Path $t.Path } catch { $missing += $t.Name; continue }
            $c = Get-NtsMarkerCounts -Text $pr.Text
            $ok = ($c.Begin -eq 1 -and $c.End -eq 1 -and
                   $pr.Text.Contains($JinjaSentinel + '-' + $AssetCssHash8) -and
                   $pr.Text.Contains($JinjaSentinel + '-' + $AssetJsHash8))
            if (-not $ok) { $missing += $t.Name }
        }
        if ($missing.Count -eq 0) { return [pscustomobject]@{ Ok = $true; Missing = @() } }
        if ((Get-Date) -ge $deadline) { return [pscustomobject]@{ Ok = $false; Missing = $missing } }
        Start-Sleep -Milliseconds 700
    }
}

function Invoke-Verification {
    Write-Head 'G. 验证'

    # G1/G2 标记次数 + Jinja 哨兵 + 热更新哈希：对「全部含锚点模板」校验。
    # （chat/index 是必备模板，其余窗口由插件 startup 自愈一起补，任何一个漏了
    #   都意味着该窗口白屏 —— 只验两个模板等于给插件自愈开了盲区。）
    $verifyTargets = Get-VerificationTemplateTargets
    foreach ($t in $verifyTargets) {
        $isRequired = @('chat.html', 'index.html') -contains $t.Name
        try {
            $pr = Get-TextFileProbe -Path $t.Path
        } catch {
            Add-Result ("模板 {0}" -f $t.Name) $false ("读取/解码失败：" + $_.Exception.Message)
            continue
        }
        $c = Get-NtsMarkerCounts -Text $pr.Text
        $markersOk = ($c.Begin -eq 1 -and $c.End -eq 1)
        if (-not $markersOk -and -not $isRequired -and $SkipPluginInstall) {
            Write-Info ("{0}：尚无标记（-SkipPluginInstall 模式下交由插件 startup 自愈补齐）" -f $t.Name)
            continue
        }
        $jinjaOk = $pr.Text.Contains($JinjaSentinel)
        $hashedOk = ($pr.Text.Contains($JinjaSentinel + '-' + $AssetCssHash8) -and
                     $pr.Text.Contains($JinjaSentinel + '-' + $AssetJsHash8))
        $pass = ($markersOk -and $jinjaOk -and $hashedOk)
        Add-Result ("模板 {0}" -f $t.Name) $pass ("BEGIN/END={0}/{1}；Jinja={2}；资源哈希={3}" -f $c.Begin, $c.End, $jinjaOk, $hashedOk)
    }

    # G2b 用户调色板：安装时从 userdata-<时间戳>\ 写回，这里把恢复结果显式报告出来
    # （旧版只备份不读回，用户重装后颜色被重置且脚本一声不吭）。
    if ($script:UserDataBackup -and $script:UserDataBackup.ThemeBytes) {
        Write-Ok ("已恢复用户调色板 {0} 个变量" -f $script:UserThemeRestoredVars)
        Add-Result '用户调色板已恢复' $true ("{0} 个变量（备份：{1}）" -f $script:UserThemeRestoredVars, $script:UserDataBackup.Dir)
    } elseif ($Verify) {
        # -Verify 是只读模式：不改文件，但把当前已安装插件的调色板变量数打出来便于比对
        $installedThemePath = Join-Path (Join-Path $UserPluginsRoot $PluginId) 'static\theme.json'
        if (Test-Path -LiteralPath $installedThemePath -PathType Leaf) {
            try {
                $tb = [System.IO.File]::ReadAllBytes($installedThemePath)
                $n = Get-ThemeVarCount $tb
                Write-Info ("已安装调色板：{0} 个变量（只读检查，未改动）" -f $n)
            } catch {
                Write-Info ("已安装调色板读取失败：{0}" -f $_.Exception.Message)
            }
        }
    }

    # G2c 完整性级别：插件子进程以 Low IL 运行，插件目录/备份目录必须是 Low。
    #     否则面板「应用」写 theme.json 会 PermissionError（Errno 13），
    #     插件 startup 也会因为写不了模板备份而静默跳过补丁。
    foreach ($ilItem in @(
            [pscustomobject]@{ Name = '插件目录完整性级别'; Path = $UserPluginDir;       Need = 'Low' },
            [pscustomobject]@{ Name = '备份目录完整性级别'; Path = $UserDataBackupRoot; Need = 'Low' })) {
        if (-not (Test-Path -LiteralPath $ilItem.Path)) {
            if ($ilItem.Name -eq '插件目录完整性级别') {
                Add-Result $ilItem.Name $false ("目录不存在：{0}" -f $ilItem.Path)
            }
            continue   # 备份目录可能尚未创建（首次安装且无用户数据），不算失败
        }
        $il = Get-NtsIntegrityLabel $ilItem.Path
        $shown = if ($il) { $il } else { '未设置/继承' }
        Add-Result $ilItem.Name ($il -eq $ilItem.Need) ("当前 {0}（需要 {1}）" -f $shown, $ilItem.Need)
    }

    # G3/G4 静态文件 HTTP 200
    foreach ($item in @(
            [pscustomobject]@{ Url = "/static/css/neko-theme-studio.css"; File = $AssetCssDst },
            [pscustomobject]@{ Url = "/static/neko-theme-studio.js";      File = $AssetJsDst  })) {
        if (-not $p48911) {
            Add-Result ("HTTP $($item.Url)") $false "48911 未监听，无法验证"
            continue
        }
        $r = Invoke-Http -Uri ("http://127.0.0.1:{0}{1}" -f $AppPort, $item.Url) -TimeoutMs 15000
        $pass = ($r.StatusCode -eq 200)
        $disk = if (Test-Path -LiteralPath $item.File) { "磁盘文件 " + (Get-Item -LiteralPath $item.File).Length + " 字节" } else { '磁盘文件不存在' }
        Add-Result ("HTTP 200 $($item.Url)") $pass ("状态码 {0}；{1}" -f $r.StatusCode, $disk)
    }

    # G5 GET /chat 含标记
    if ($p48911) {
        $r = Invoke-Http -Uri ("http://127.0.0.1:{0}/chat" -f $AppPort) -TimeoutMs 15000
        $has = ($r.StatusCode -eq 200 -and $r.Body.Contains('NTS:BEGIN'))
        Add-Result 'GET /chat 含补丁标记' $has ("状态码 {0}；含 NTS:BEGIN = {1}" -f $r.StatusCode, ($r.Body -like '*NTS:BEGIN*'))
        $r2 = Invoke-Http -Uri ("http://127.0.0.1:{0}/" -f $AppPort) -TimeoutMs 15000
        $has2 = ($r2.StatusCode -eq 200 -and $r2.Body.Contains('NTS:BEGIN'))
        Add-Result 'GET / 含补丁标记' $has2 ("状态码 {0}；含 NTS:BEGIN = {1}" -f $r2.StatusCode, ($r2.Body -like '*NTS:BEGIN*'))
    } else {
        Add-Result 'GET /chat 含补丁标记' $false '48911 未监听，无法验证'
        Add-Result 'GET / 含补丁标记' $false '48911 未监听，无法验证'
    }

    # G6 插件注册 + 插件静态路由 + 运行态
    #
    # -SkipPluginInstall 的场景是「插件已从市场装好，只打应用侧补丁」，所以这里
    # 不做「必须存在」的失败判定：若插件确实不在，记 INFO；但**只要它在，就照常
    # 验证静态路由与运行态**，因为面板可用的前提正是这两项。
    if (-not $p48916) {
        if ($SkipPluginInstall) {
            Write-Info '48916 未监听：跳过插件注册/静态路由/运行态校验。'
        } else {
            Add-Result '插件已注册到 48916' $false '48916 未监听（插件未构建/未安装）'
            Add-Result '插件静态路由可用' $false '48916 未监听'
            Add-Result '插件处于运行态' $false '48916 未监听'
        }
    } else {
        $r = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin-cli/plugins" -f $PluginPort) -TimeoutMs 15000
        $known = ($r.StatusCode -eq 200 -and $r.Body -like "*$PluginId*")

        if ($SkipPluginInstall -and -not $known) {
            Write-Info ("指定了 -SkipPluginInstall，且 48916 上尚未注册 {0}：跳过插件相关校验（请先从插件市场安装）。" -f $PluginId)
        } else {
            Add-Result '插件已注册到 48916' $known ("状态码 {0}；提及 {1} = {2}" -f $r.StatusCode, $PluginId, $known)

            $routeUri = "http://127.0.0.1:{0}/plugin/{1}/ui/theme.json" -f $PluginPort, $PluginId
            $rr = Invoke-Http -Uri $routeUri -Method 'GET' -TimeoutMs 30000
            $routeOk = ($rr.StatusCode -ge 200 -and $rr.StatusCode -lt 300)
            $detail = "状态码 {0}" -f $rr.StatusCode
            if (-not $routeOk) { $detail += '；loader 无法读取 theme.json（检查 plugin.toml 的 [plugin] entry，见插件日志）' }
            Add-Result ("GET /plugin/{0}/ui/theme.json" -f $PluginId) $routeOk $detail

            $rruns = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugins" -f $PluginPort) -Method 'GET' -TimeoutMs 30000
            $runStatus = ''
            if ($rruns.StatusCode -eq 200) {
                try {
                    $pj = $rruns.Body | ConvertFrom-Json
                    $pe = @($pj.plugins | Where-Object { $_.id -eq $PluginId }) | Select-Object -First 1
                    if ($pe) { $runStatus = [string]$pe.status }
                } catch { }
            }
            $runsOk = ($runStatus -eq 'running')
            $runDetail = "status = '$runStatus'"
            if (-not $runsOk) { $runDetail += '；插件停止时面板读/写都会报 NOT_READY（F7 会自动启动，也可用 POST /plugin/<id>/start）' }
            Add-Result '插件处于运行态' $runsOk $runDetail
        }
    }

    # 汇总表
    Write-Host ''
    Write-Host '  ---------------- 验证结果汇总 ----------------' -ForegroundColor Cyan
    $fmt = '{0,-32} {1,-6} {2}'
    Write-Host ($fmt -f '检查项', '结果', '详情') -ForegroundColor DarkGray
    Write-Host ('-' * 72) -ForegroundColor DarkGray
    foreach ($r in $script:Results) {
        $cell = if ($r.Pass) { 'PASS' } else { 'FAIL' }
        $color = if ($r.Pass) { 'Green' } else { 'Red' }
        Write-Host ($fmt -f $r.Name, $cell, $r.Detail) -ForegroundColor $color
    }
    $failed = @($script:Results | Where-Object { -not $_.Pass }).Count
    Write-Host ('-' * 72) -ForegroundColor DarkGray
    if ($failed -eq 0) { Write-Host ("  ✅ 全部通过（{0} 项）" -f $script:Results.Count) -ForegroundColor Green }
    else               { Write-Host ("  ❌ {0}/{1} 项失败" -f $failed, $script:Results.Count) -ForegroundColor Red }
    return $failed
}

if ($Verify) {
    $failed = Invoke-Verification
    Write-Host ''
    Write-Host ("  验证结束，用时 {0:N1} 秒。" -f ((Get-Date) - $StartedAt).TotalSeconds) -ForegroundColor DarkGray
    if ($failed -gt 0) { exit 1 } else { exit 0 }
}

# ---------------------------------------------------------------------------
# 失败回滚陷阱：任何未捕获的终止性错误（throw）都先回滚再退出
# ---------------------------------------------------------------------------
# 回滚范围：模板（txn 快照）→ 插件目录（旧回滚点）→ 用户数据（userdata 备份）。
# 这样「模板写了一半」「插件目录被改名后构建失败」都不会把用户留在半成品状态。
trap {
    $err = $_
    Write-Host ''
    Write-Err2 ("安装异常：{0}" -f $err.Exception.Message)
    try {
        $stack = (@($err.ScriptStackTrace -split "`n") | Select-Object -First 3) -join ' / '
        if ($stack) { Write-Host ("  位置：{0}" -f $stack) -ForegroundColor DarkGray }
    } catch { }
    try {
        Invoke-NtsFailureRollback
    } catch {
        Write-Err2 ("回滚过程异常：{0}（请手工检查上面的备份目录）" -f $_.Exception.Message)
    }
    exit 1
}

# ---------------------------------------------------------------------------
# B. 备份
# ---------------------------------------------------------------------------
Write-Head 'B. 备份模板'

if (-not (Test-Path -LiteralPath $BackupDir)) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    Write-Ok "已创建备份目录：$BackupDir"
}

$backupStamp = $StartedAt.ToString('yyyyMMdd-HHmmss')

foreach ($t in $TplTargets) {
    $pr = $probes[$t.Name]
    $pristine = Get-PristineText -Text $pr.Text -Eol $pr.Eol
    $hash = Get-Sha256OfText $pristine
    $shortHash = $hash.Substring(0, 8)

    # 该「原始内容」是否已备份过？（文件名内嵌原始内容哈希 → 同内容只备份一次）
    $existing = @(Get-ChildItem -LiteralPath $BackupDir -Filter ("{0}.pristine-{1}.*.bak" -f $t.Name, $shortHash) -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        Write-Info ("{0}：原始内容（哈希 {1}）已备份过，跳过新建 → {2}" -f $t.Name, $shortHash, $existing[0].Name)
        continue
    }

    $bakPath = Join-Path $BackupDir ("{0}.pristine-{1}.{2}.bak" -f $t.Name, $shortHash, $backupStamp)
    # 备份「原始内容」：BOM 状态与行尾都保持原样，因此备份文件本身 = 未打补丁时模板的原始字节
    Write-TextFilePreserving -Path $bakPath -Text $pristine -HasBom $pr.HasBom
    $bakLen = (Get-Item -LiteralPath $bakPath).Length

    # 记录还原所需的元信息（uninstall.ps1 用），便于证明「字节级还原」
    $meta = [pscustomobject]@{
        template        = $t.Name
        template_path   = $t.Path
        backup_file     = (Split-Path $bakPath -Leaf)
        created_at      = (Get-Date).ToString('s')
        pristine_sha256 = $hash
        pristine_bytes  = $bakLen
        has_bom         = $pr.HasBom
        eol             = $(if ($pr.Eol -eq "`r`n") { 'CRLF' } else { 'LF' })
        app_root        = $AppRoot
        installed_by    = 'install.ps1'
    }
    Write-TextFilePreserving -Path ($bakPath + '.meta.json') -Text (($meta | ConvertTo-Json -Depth 4) + "`n") -HasBom $false

    Add-Change ("备份 {0} → {1}（{2} 字节，哈希 {3}）" -f $t.Name, (Split-Path $bakPath -Leaf), $bakLen, $shortHash)
}

Write-Info "旧备份一律保留，从不删除（契约 §9.6）。目录：$BackupDir"

# ---------------------------------------------------------------------------
# C. 复制两件套（必须在写模板标记之前）
# ---------------------------------------------------------------------------
Write-Head 'C. 复制应用侧两件套到 static\'

# 顺序说明：先复制资源、再写模板标记。这样即使后续模板步骤出问题，已写入的标记
# 也不会指向还不存在的 /static/neko-theme-studio.js|css（旧版先写模板、后复制资源，
# 中途异常会留下 404 的标记）。

foreach ($pair in @(
        [pscustomobject]@{ Label = 'CSS'; Src = $AssetCssSrc; Dst = $AssetCssDst },
        [pscustomobject]@{ Label = 'JS';  Src = $AssetJsSrc;  Dst = $AssetJsDst  })) {

    if (-not (Test-Path -LiteralPath $pair.Src)) {
        $msg = "缺少源文件：$($pair.Src)（应用侧两件套由契约 §1B 规定，必须存在）"
        if ($Strict) { Write-Err2 $msg; exit 1 }
        Add-Warning $msg
        continue
    }

    $dstDir = Split-Path -Parent $pair.Dst
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }

    # 版本单调性守卫（只有 loader JS 带 SCRIPT_VERSION；CSS 没有版本号）。
    # 目的：把旧包装到已经装了新版本的机器上时，不要静默把它降级。
    if ($pair.Label -eq 'JS' -and (Test-Path -LiteralPath $pair.Dst -PathType Leaf)) {
        $srcVer = Get-LoaderScriptVersion $pair.Src
        $dstVer = Get-LoaderScriptVersion $pair.Dst
        if (Test-NtsDowngrade -TargetVersion $dstVer -SourceVersion $srcVer) {
            if (-not $ForceDowngrade) {
                Write-Warn2 ("已部署 loader 版本 v{0} 高于源版本 v{1}：已跳过覆盖（防止降级）。" -f $dstVer, $srcVer)
                Write-Warn2 "  如确实要用旧包覆盖，请加 -ForceDowngrade 重跑。"
                Add-Warning ("loader 版本守卫：已部署 v{0} > 源 v{1}，跳过覆盖（需要降级请加 -ForceDowngrade）。" -f $dstVer, $srcVer)
                continue
            }
            Write-Warn2 ("-ForceDowngrade：允许把 loader 从 v{0} 降级到 v{1}。" -f $dstVer, $srcVer)
            Add-Warning ("loader 被强制降级：v{0} → v{1}（-ForceDowngrade）" -f $dstVer, $srcVer)
        }
    }

    $srcLen = (Get-Item -LiteralPath $pair.Src).Length
    $srcHash = (Get-FileHash -LiteralPath $pair.Src -Algorithm SHA256).Hash

    $needCopy = $true
    if (Test-Path -LiteralPath $pair.Dst) {
        $dstHash = (Get-FileHash -LiteralPath $pair.Dst -Algorithm SHA256).Hash
        if ($dstHash -eq $srcHash) { $needCopy = $false }
    }

    if ($needCopy) {
        Copy-Item -LiteralPath $pair.Src -Destination $pair.Dst -Force
    }

    $dstLen = (Get-Item -LiteralPath $pair.Dst).Length
    $dstHash2 = (Get-FileHash -LiteralPath $pair.Dst -Algorithm SHA256).Hash
    if ($dstLen -ne $srcLen -or $dstHash2 -ne $srcHash) {
        throw ("{0} 复制校验失败：源 {1} 字节/{2}，目标 {3} 字节/{4}" -f $pair.Label, $srcLen, $srcHash.Substring(0, 8), $dstLen, $dstHash2.Substring(0, 8))
    }
    if ($needCopy) { Add-Change ("{0}：{1} → {2}（{3} 字节，大小/哈希一致）" -f $pair.Label, $pair.Src, $pair.Dst, $dstLen) }
    else          { Write-Ok  ("{0}：目标已是最新且内容相同，跳过复制（{1} 字节）" -f $pair.Label, $dstLen) }
}

# ---------------------------------------------------------------------------
# D. 模板补丁（两阶段：只读预检 → 全部通过才写回）
# ---------------------------------------------------------------------------
Write-Head 'D. 模板补丁（预检全部通过后才写入；先删旧标记，再插到 dark-mode.css 之后）'

# 旧版是「边算边写」：chat.html 已经写回后，index.html 抛异常就会留下只打了一半的状态，
# 且标记可能指向没复制成功的资源。现在改成两阶段：
#   阶段 1（只读）：对每个目标模板算出「写回后的完整内容」并做全部守卫检查；
#   阶段 2（写）：任何模板有预检问题就整体中止、一个文件都不写；全部通过才逐个原子写回。

$patchPlans = New-Object System.Collections.Generic.List[object]
$preflightProblems = New-Object System.Collections.Generic.List[string]

foreach ($t in $TplTargets) {
    try { $pr = Get-TextFileProbe -Path $t.Path }
    catch { $preflightProblems.Add(("{0}：读取/解码失败 —— {1}" -f $t.Name, $_.Exception.Message)); continue }
    $eol = $pr.Eol
    $lines = Split-TextLines -Text $pr.Text -Eol $eol

    # D1 删旧标记（未闭合时只剥离标记文本，绝不丢弃后续内容）
    $removed = Remove-NtsBlockLines -Lines $lines
    $lines = $removed.Lines

    # D2 找锚点 dark-mode.css，必须唯一
    $anchorIdx = -1
    $anchorHits = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $AnchorRegex) { $anchorHits++; if ($anchorIdx -lt 0) { $anchorIdx = $i } }
    }
    if ($anchorHits -ne 1) {
        $preflightProblems.Add(("{0}：未能在模板中唯一定位 dark-mode.css 的 <link> 行（匹配到 {1} 处）" -f $t.Name, $anchorHits))
        continue
    }
    $anchorLineNo = $anchorIdx + 1

    # D3 计算写回后的内容（补丁块作为独立一行，紧跟锚点之后）
    $newLines = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $newLines.Add($lines[$i])
        if ($i -eq $anchorIdx) { $newLines.Add($MarkerBlock) }
    }
    $newText = Join-TextLines -Lines $newLines.ToArray() -Eol $eol

    # D4 只读守卫：任一项失败 → 记入预检问题，不写任何文件
    if (-not $newText.Contains($JinjaSentinel)) {
        $preflightProblems.Add(("{0}：写回前校验失败——丢失了 {1}" -f $t.Name, $JinjaSentinel)); continue
    }
    $cnt = Get-NtsMarkerCounts -Text $newText
    if ($cnt.Begin -ne 1 -or $cnt.End -ne 1) {
        $preflightProblems.Add(("{0}：写回前校验失败——标记数异常 BEGIN={1} END={2}" -f $t.Name, $cnt.Begin, $cnt.End)); continue
    }
    if ($pr.Text.Contains('</html>') -and -not $newText.Contains('</html>')) {
        $preflightProblems.Add(("{0}：预检发现会丢失 </html>（模板尾会被截断）" -f $t.Name)); continue
    }
    if ($newText.Length -lt [int]($pr.Text.Length / 2)) {
        $preflightProblems.Add(("{0}：预检发现内容长度将从 {1} 骤减到 {2}（不足原长度 50%）" -f $t.Name, $pr.Text.Length, $newText.Length)); continue
    }

    $patchPlans.Add([pscustomobject]@{
        Target         = $t
        Probe          = $pr
        NewText        = $newText
        Removed        = $removed.Removed
        Unterminated   = [bool]($removed.Unterminated -gt 0)
        AnchorLineNo   = $anchorLineNo
        InsertedLineNo = $anchorLineNo + 1
        Changed        = ($newText -ne $pr.Text)
    })
}

if ($preflightProblems.Count -gt 0) {
    foreach ($p in $preflightProblems) { Write-Err2 $p }
    throw ("模板预检失败（{0} 项），已中止：没有写入任何模板文件。" -f $preflightProblems.Count)
}

# D-txn：写模板前先给每个目标模板做事务快照（当前字节 → backup\txn-<时间戳>\<name>.orig）。
# 任何一个模板写失败 / 写后复核失败 → Invoke-NtsFailureRollback 用这些快照全部还原。
if ($patchPlans.Count -gt 0) {
    $txnDir = Join-Path $BackupDir ('txn-' + $backupStamp)
    New-Item -ItemType Directory -Force -Path $txnDir | Out-Null
    $script:TemplateTxnDir = $txnDir
    foreach ($plan in $patchPlans) {
        $orig = Join-Path $txnDir ($plan.Target.Name + '.orig')
        $origBytes = [System.IO.File]::ReadAllBytes($plan.Target.Path)
        Write-BytesAtomic -Path $orig -Bytes $origBytes
        $script:TemplateTxnEntries.Add([pscustomobject]@{
            Name = $plan.Target.Name
            Path = $plan.Target.Path
            Bak  = $orig
            Sha256 = (Get-Sha256OfBytes $origBytes)
        }) | Out-Null
    }
    $txnMeta = [pscustomobject]@{
        created_at = (Get-Date).ToString('s')
        app_root   = $AppRoot
        files      = @($script:TemplateTxnEntries | ForEach-Object { [pscustomobject]@{ name = $_.Name; path = $_.Path; sha256 = $_.Sha256 } })
    }
    Write-TextFilePreserving -Path (Join-Path $txnDir 'meta.json') -Text (($txnMeta | ConvertTo-Json -Depth 5) + "`n") -HasBom $false
    Write-Ok ("模板事务快照：{0}（{1} 个文件）" -f $txnDir, $script:TemplateTxnEntries.Count)
}

foreach ($plan in $patchPlans) {
    $t = $plan.Target
    $pr = $plan.Probe

    if ($plan.Unterminated) {
        Add-Warning ("{0}：发现只有 BEGIN 没有 END 的残缺标记，已只剥离标记文字并重新写入完整标记段（其余内容原样保留）" -f $t.Name)
    }
    if ($plan.Removed -gt 0) { Add-Change ("{0}：移除旧的 NTS 标记段 {1} 行" -f $t.Name, $plan.Removed) }
    else { Write-Info ("{0}：未发现旧标记段（首次安装或已幂等）" -f $t.Name) }

    Write-TextFilePreserving -Path $t.Path -Text $plan.NewText -HasBom $pr.HasBom

    # 写回后复核（预检已挡住绝大多数问题；这里兜底，失败立刻停，避免继续写别的模板）
    $after = Get-TextFileProbe -Path $t.Path
    if (-not $after.Text.Contains($JinjaSentinel)) {
        throw ("{0}：写回后校验失败——丢失了 {1}，请用备份恢复！" -f $t.Name, $JinjaSentinel)
    }
    $c2 = Get-NtsMarkerCounts -Text $after.Text
    if ($c2.Begin -ne 1 -or $c2.End -ne 1) {
        throw ("{0}：写回后校验失败——标记数 BEGIN={1} END={2}，请用备份恢复！" -f $t.Name, $c2.Begin, $c2.End)
    }
    if ($after.HasBom -ne $pr.HasBom) {
        throw ("{0}：写回后 BOM 状态被改变（原 {1} → 现 {2}）" -f $t.Name, $pr.HasBom, $after.HasBom)
    }

    if ($plan.Changed) {
        Add-Change ("{0}：补丁已写入，标记位于第 {1} 行（dark-mode.css 在第 {2} 行之后）" -f $t.Name, $plan.InsertedLineNo, $plan.AnchorLineNo)
    } else {
        Write-Ok ("{0}：内容与目标一致，无需改动（标记在第 {1} 行）" -f $t.Name, $plan.InsertedLineNo)
    }
}

# ---------------------------------------------------------------------------
# E. 复制插件开发源
# ---------------------------------------------------------------------------
Write-Head 'E. 复制插件开发源到构建暂存目录'

# 关键实测结论（本次安装脚本据此重写）：
#   1. build 的 root_id 'user' 解析到 .neko-plugin-installations\plugins\<id>\，
#      而不是 %LOCALAPPDATA%\N.E.K.O\plugins\<id>\。手工复制到后者不会注册插件。
#   2. 若该暂存目录在 install-plan 时仍存在，install-plan 返回 action=blocked /
#      reason=install_source_ownership_unknown（归属由 plugins.lock.json 决定，不是目录存在与否）。
#      因此必须在 build 之后、install-plan 之前把它删掉。
#   3. build 本身要读这个目录，所以删除必须发生在 build 之后。正确顺序：
#         清理 → 复制 → build → 删除暂存目录 → install-plan → install → reload
#   4. 每次全量重建暂存目录（旧目录改名成 <id>.bak 作回滚点，再全量复制），天然幂等，不需要增量清单。

$pluginStaged = $false
$pluginBakDir = $null
$userThemeData = $null
$pluginVersionBlocked = $false

if ($SkipPluginInstall) {
    Write-Info '指定了 -SkipPluginInstall：跳过插件复制/构建/安装。'
}
elseif (-not (Test-Path -LiteralPath $PluginSrc)) {
    $msg = "未找到插件开发源目录：$PluginSrc（契约 §1A）。已跳过插件相关步骤，应用侧补丁不受影响。"
    if ($Strict) { Write-Err2 $msg; exit 1 }
    Add-Warning $msg
}
else {
    # E0. 插件包版本单调性守卫：已安装版本 > 源版本时默认跳过重建（防止旧包降级）。
    $installedToml = Join-Path $UserPluginDir 'plugin.toml'
    $installedVer = Get-TomlPackageVersion $installedToml
    $sourceVer = Get-TomlPackageVersion (Join-Path $PluginSrc 'plugin.toml')
    if (Test-NtsDowngrade -TargetVersion $installedVer -SourceVersion $sourceVer) {
        if (-not $ForceDowngrade) {
            $pluginVersionBlocked = $true
            Write-Warn2 ("已安装插件版本 v{0} 高于源版本 v{1}：跳过插件重建（防止降级）。" -f $installedVer, $sourceVer)
            Write-Warn2 "  应用侧两件套与模板补丁仍会更新；如确需降级插件，请加 -ForceDowngrade 重跑。"
            Add-Warning ("插件版本守卫：已安装 v{0} > 源 v{1}，跳过插件重建（需要降级请加 -ForceDowngrade）。" -f $installedVer, $sourceVer)
        } else {
            Write-Warn2 ("-ForceDowngrade：允许插件从 v{0} 降级到 v{1}。" -f $installedVer, $sourceVer)
            Add-Warning ("插件被强制降级：v{0} → v{1}（-ForceDowngrade）" -f $installedVer, $sourceVer)
        }
    }

    if ($pluginVersionBlocked) {
        Write-Info '插件重建已跳过；旧插件目录保持原样，F6b/F7 只做运行态与收尾。'
    }
    else {
    # E1. 旧插件目录不直接删除：先改名成 <id>.bak 作为回滚点。
    #     目录里的 static\theme.json 是用户的调色板数据（不在源码里），必须先备份出来，
    #     否则「重跑一次安装」就会把用户颜色重置回出厂默认（旧版 bug）。
    # E1a. 旧版把回滚点放在插件扫描目录里（<id>.bak），它会让 install-plan 判定
    #      「有两份安装」→ blocked / multiple_installations，插件不会被更新。
    #      先把这种残留移出扫描目录（保留数据，不删）。
    $legacyBak = $UserPluginDir + '.bak'
    if (Test-Path -LiteralPath $legacyBak) {
        if (-not (Test-Path -LiteralPath $PluginRollbackRoot)) { New-Item -ItemType Directory -Force -Path $PluginRollbackRoot | Out-Null }
        $legacyDst = Join-Path $PluginRollbackRoot ('legacy-' + $PluginId + '-' + (Get-Date).ToString('yyyyMMdd-HHmmss'))
        try {
            Move-Item -LiteralPath $legacyBak -Destination $legacyDst -Force -ErrorAction Stop
            Add-Change ("已把残留的旧回滚点移出插件扫描目录：{0} → {1}" -f $legacyBak, $legacyDst)
        } catch {
            Add-Warning ("残留旧回滚点无法移走：{0}（{1}）。install-plan 很可能报 multiple_installations。" -f $legacyBak, $_.Exception.Message)
        }
    }

    if (Test-Path -LiteralPath $UserPluginDir) {
        $pluginBakDir = Join-Path $PluginRollbackRoot $PluginId
        if (-not (Test-Path -LiteralPath $PluginRollbackRoot)) { New-Item -ItemType Directory -Force -Path $PluginRollbackRoot | Out-Null }
        # E1'. 上一次的回滚点不直接删除：改名成 prior-<时间戳> 保留。
        # 新规则：旧回滚点只在新安装 + 验证全部成功后才清（失败时新旧两份都留着）。
        if (Test-Path -LiteralPath $pluginBakDir) {
            $priorDir = Join-Path $PluginRollbackRoot ('prior-' + $PluginId + '-' + $backupStamp)
            try {
                Move-Item -LiteralPath $pluginBakDir -Destination $priorDir -Force -ErrorAction Stop
                [void]$script:PriorRollbackDirs.Add($priorDir)
                Write-Info ("上一次的回滚点已保留为：{0}" -f $priorDir)
            } catch {
                Add-Warning ("上一次的回滚点无法改名（{0}），尝试直接删除：{1}" -f $_.Exception.Message, $pluginBakDir)
                Remove-Item -LiteralPath $pluginBakDir -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $pluginBakDir) {
                    Add-Warning "无法清理上一次遗留的回滚目录：$pluginBakDir（可能有进程占用），将继续使用新的复制流程。"
                    $pluginBakDir = $null
                }
            }
        }

        $script:PluginBakDir = $pluginBakDir

        # E1b. 全部用户数据备份：static\theme.json + static\themes\ + backgrounds\ + exports\。
        # 旧版只备份 theme.json，用户自建/下载的 themes、背景图、导出包在重装时会被整目录覆盖丢掉。
        $script:UserDataBackup = Backup-NtsUserData -PluginDir $UserPluginDir -Stamp $backupStamp
        $userThemeData = $script:UserDataBackup.ThemeBytes
        if ($userThemeData) {
            Write-BytesAtomic -Path $UserThemeBak -Bytes $userThemeData
            $script:UserThemeRestoredVars = $script:UserDataBackup.ThemeVarCount
            Add-Change ("已备份用户主题数据（调色板 {0} 个变量）→ {1}" -f $script:UserThemeRestoredVars, $script:UserDataBackup.Dir)
        }
        if ($pluginBakDir) {
            $moved = $false
            try {
                Move-Item -LiteralPath $UserPluginDir -Destination $pluginBakDir -Force -ErrorAction Stop
                $moved = $true
            } catch {
                Add-Warning ("旧插件目录改名失败（{0}），改为直接删除（本次安装失败将无法自动回滚）：{1}" -f $_.Exception.Message, $UserPluginDir)
            }
            if ($moved) {
                Write-Ok ("已把旧插件目录改名作为回滚点：{0}" -f $pluginBakDir)
            } else {
                Remove-Item -LiteralPath $UserPluginDir -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $UserPluginDir) {
                    Add-Warning "无法删除旧的暂存目录：$UserPluginDir（可能有进程占用），继续尝试覆盖复制。"
                }
            }
        }
    }
    if (Test-Path -LiteralPath $PackagePath) {
        Remove-Item -LiteralPath $PackagePath -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $PackagePath)) { Write-Ok "已清理旧包：$PackagePath" }
    }

    # E2. 全量复制（排除 __pycache__ / .git / .pytest-scratch 等脚手架）
    New-Item -ItemType Directory -Force -Path $UserPluginDir | Out-Null
    $srcFiles = @(Get-ChildItem -LiteralPath $PluginSrc -Recurse -File -Force | Where-Object {
        $_.FullName -notlike '*\__pycache__\*' -and
        $_.FullName -notlike '*\.git\*'        -and
        $_.FullName -notlike '*\.pytest-scratch\*'
    })
    foreach ($f in $srcFiles) {
        $rel = $f.FullName.Substring($PluginSrc.Length).TrimStart('\')
        $dst = Join-Path $UserPluginDir $rel
        $dstDir2 = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $dstDir2)) { New-Item -ItemType Directory -Force -Path $dstDir2 | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
    }

    # E2b. 把全部用户数据写回暂存目录（必须发生在 build 之前，否则打出来的包是出厂默认值）。
    #      static\presets\ 不还原：那是随包内置的只读预设，用新包内容；
    #      用户自定义的同名预设请放在 static\themes\ 里（会原样保留）。
    if ($null -ne $script:UserDataBackup) {
        $script:UserThemeRestoredVars = Restore-NtsUserData -PluginDir $UserPluginDir -Data $script:UserDataBackup
        if ($userThemeData) {
            Add-Change ("已恢复用户调色板 {0} 个变量（写回 {1}）" -f $script:UserThemeRestoredVars, (Join-Path $UserPluginDir 'static\theme.json'))
        }
        foreach ($sub in @('themes', 'backgrounds', 'exports')) {
            if ($script:UserDataBackup.SubDirs.ContainsKey($sub)) {
                Add-Change ("已恢复用户数据 static\{0}\（{1} 个文件）" -f $sub, $script:UserDataBackup.Counts[$sub])
            }
        }
    }

    # E3. 自检：暂存目录必须有 plugin.toml，且不能带 BOM（带 BOM 会让 build 报
    #     'Invalid statement (at line 1, column 1)'）
    $stagedToml = Join-Path $UserPluginDir 'plugin.toml'
    if (-not (Test-Path -LiteralPath $stagedToml)) {
        Add-Warning ("暂存目录缺少 plugin.toml：$stagedToml。构建会返回 404，已跳过插件安装。")
    } else {
        $tomlBytes = [System.IO.File]::ReadAllBytes($stagedToml)
        if ($tomlBytes.Length -ge 3 -and $tomlBytes[0] -eq 0xEF -and $tomlBytes[1] -eq 0xBB -and $tomlBytes[2] -eq 0xBF) {
            # 去掉 BOM 后原样写回（契约 §8 / 实测）；原子写避免构建方读到半截 toml
            $noBom = [System.Text.Encoding]::UTF8.GetString($tomlBytes, 3, $tomlBytes.Length - 3)
            $noBomBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($noBom)
            Write-BytesAtomic -Path $stagedToml -Bytes $noBomBytes
            Add-Change "插件暂存 plugin.toml 含 UTF-8 BOM（会导致构建失败），已去除 BOM"
        }
        Add-Change ("插件源：已同步 {0} 个文件 → {1}" -f $srcFiles.Count, $UserPluginDir)
        $pluginStaged = $true
    }
    }   # end: if (-not $pluginVersionBlocked)
}

# ---------------------------------------------------------------------------
# F. 构建 + 安装插件（48916）
# ---------------------------------------------------------------------------
# F6b 收尾要用：插件是否真正装成功（决定删除还是还原 .bak 回滚点）
$pluginInstallOk = $false

if (-not $SkipPluginInstall -and -not $pluginVersionBlocked) {
    Write-Head 'F. 构建并安装插件（48916 plugin-cli）'

    $havePluginSrc = $pluginStaged -and (Test-Path -LiteralPath $UserPluginDir)

    if (-not $havePluginSrc) {
        Add-Warning '插件源未就绪（暂存目录缺失或缺少 plugin.toml），跳过构建/安装。'
    }
    elseif (-not $p48916) {
        Add-Warning ("端口 {0}（插件服务）未监听，无法构建/安装插件。请先启动 N.E.K.O，然后重新运行 install.ps1（或本次加 -SkipPluginInstall 只做应用侧）。" -f $PluginPort)
    }
    else {
        try {
            # ---- F1 构建（注意 plugin_ref 是单数；带 out 字段会被拒绝） ----
            Write-Step 'F1. /plugin-cli/build'
            $buildBody = '{"mode":"single","plugin_ref":{"root_id":"user","directory_name":' + (ConvertTo-JsonStringLiteral $PluginId) + '}}'
            Write-Info ("请求体：{0}" -f $buildBody)
            $r = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin-cli/build" -f $PluginPort) -Method 'POST' -JsonBody $buildBody -TimeoutMs 180000
            if (-not $r.Ok -or $r.StatusCode -lt 200 -or $r.StatusCode -ge 300) {
                Add-Warning ("构建失败：HTTP {0}  {1}" -f $r.StatusCode, (Get-Short $r.Body 600))
            }
            elseif (-not (Test-Path -LiteralPath $PackagePath)) {
                Add-Warning "构建返回成功，但未找到包文件：$PackagePath"
            }
            else {
                Write-Ok ("构建成功：HTTP {0}" -f $r.StatusCode)
                Write-Info ("响应：{0}" -f (Get-Short $r.Body 400))
                $pkgItem = Get-Item -LiteralPath $PackagePath
                Add-Change ("构建产物：{0}（{1} 字节，{2}）" -f $PackagePath, $pkgItem.Length, $pkgItem.LastWriteTime.ToString('HH:mm:ss'))

                # ---- F2 删除暂存目录（必须在 build 之后、install-plan 之前） ----
                Write-Step 'F2. 删除构建暂存目录（否则 install-plan 会报 install_source_ownership_unknown）'
                Remove-Item -LiteralPath $UserPluginDir -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $UserPluginDir) {
                    Add-Warning ("暂存目录删除失败：$UserPluginDir —— install-plan 很可能返回 blocked，请手动删除后重跑。")
                } else {
                    Write-Ok "暂存目录已删除：$UserPluginDir"
                }

                # ---- F3 安装计划 ----
                Write-Step 'F3. /plugin-cli/install-plan'
                $planBody = '{"package":' + (ConvertTo-JsonStringLiteral $PackagePath) + '}'
                $rp = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin-cli/install-plan" -f $PluginPort) -Method 'POST' -JsonBody $planBody -TimeoutMs 60000
                $plan = $null
                if ($rp.Ok -and $rp.StatusCode -ge 200 -and $rp.StatusCode -lt 300) {
                    try { $plan = $rp.Body | ConvertFrom-Json } catch { }
                    if ($plan) {
                        Write-Info ("计划：action={0} plugin_id={1} directory_name={2}" -f $plan.action, $plan.plugin_id, $plan.directory_name)
                        Write-Info ("current_source='{0}'  target_source='{1}'  current_version='{2}'" -f $plan.current_source, $plan.target_source, $plan.current_version)
                        if ($plan.reason) { Write-Warn2 ("计划 reason={0}" -f $plan.reason) }
                    } else {
                        Write-Info ("计划响应：{0}" -f (Get-Short $rp.Body 300))
                    }
                } else {
                    Add-Warning ("安装计划查询失败：HTTP {0}  {1}" -f $rp.StatusCode, (Get-Short $rp.Body 400))
                }

                if ($plan -and $plan.action -eq 'blocked') {
                    Add-Warning ("安装计划被拒绝：action=blocked reason='{0}'。已跳过安装（插件仍是旧版本）。" -f $plan.reason)
                    if ([string]$plan.reason -eq 'multiple_installations') {
                        Add-Warning ("  原因：{0} 下有多份含 plugin.toml 的 {1} 目录；install-plan 无法判断该用哪一份。" -f $InstallPluginsRoot, $PluginId)
                        Add-Warning "  处置：把多出来的那一份改名移动到别处（不要留在同一目录里）后重跑 install.ps1。本脚本已自动移走旧版 <id>.bak 回滚点，仍有残留多半是手工复制或上次中断留下的副本。"
                        Add-Warning ("  锁文件：{0}（root_id/directory_name 应与唯一那份目录对应）" -f $LockFilePath)
                    }
                }
                else {
                    # ---- F4 安装 ----
                    Write-Step 'F4. /plugin-cli/install'
                    $instBody = '{"package":' + (ConvertTo-JsonStringLiteral $PackagePath) + ',"install_source":"imported","on_conflict":' + (ConvertTo-JsonStringLiteral $PluginOnConflict)
                    if ($plan -and $plan.confirmation_token) {
                        $instBody += ',"confirmation_token":' + (ConvertTo-JsonStringLiteral ([string]$plan.confirmation_token))
                        $instBody += ',"confirm_upgrade":true'
                    }
                    $instBody += '}'
                    $ri = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin-cli/install" -f $PluginPort) -Method 'POST' -JsonBody $instBody -TimeoutMs 180000
                    if ($ri.Ok -and $ri.StatusCode -ge 200 -and $ri.StatusCode -lt 300) {
                        Write-Ok ("安装成功：HTTP {0}" -f $ri.StatusCode)
                        Write-Info ("响应：{0}" -f (Get-Short $ri.Body 400))
                        Add-Change ("插件已安装：{0}" -f $PluginId)
                        $pluginInstallOk = $true

                        # 必须在 /plugins/reload 之前清除「停止自愈」标记：
                        # reload 会触发插件 startup 的 _app_patch 自愈，而标记存在时自愈会整体跳过，
                        # 于是只由插件补丁覆盖的 20 多个模板会一直无标记（安装看起来成功、页面却没有主题）。
                        if (Test-Path -LiteralPath $DisableFlag) {
                            Remove-Item -LiteralPath $DisableFlag -Force -ErrorAction SilentlyContinue
                            if (Test-Path -LiteralPath $DisableFlag) {
                                Add-Warning ("安装成功，但无法删除卸载标记：$DisableFlag。插件 startup 不会自愈，请手动删除该文件后重启 N.E.K.O。")
                            } else {
                                Add-Change ("已清除「停止自愈」标记：$DisableFlag（插件恢复自愈）")
                            }
                        }

                        # ---- F5 重载（这一步才让插件真正生效，无需重启应用） ----
                        Write-Step 'F5. /plugins/reload（使插件立即生效）'
                        $rr = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugins/reload" -f $PluginPort) -Method 'POST' -JsonBody '{}' -TimeoutMs 120000
                        if ($rr.Ok -and $rr.StatusCode -ge 200 -and $rr.StatusCode -lt 300) {
                            Write-Ok ("重载成功：HTTP {0}" -f $rr.StatusCode)
                            Write-Info ("响应：{0}" -f (Get-Short $rr.Body 300))
                        } else {
                            Add-Warning ("重载失败：HTTP {0}  {1}。插件已安装但可能尚未生效，可重启 N.E.K.O。" -f $rr.StatusCode, (Get-Short $rr.Body 300))
                        }
                    } else {
                        $hint = ''
                        if ($ri.Body -match 'conflict|upgrade|已存在') {
                            $hint = ("  提示：可能是版本冲突。可重试：pwsh -File install.ps1 -PluginOnConflict overwrite")
                        }
                        Add-Warning ("安装失败：HTTP {0}  {1}{2}" -f $ri.StatusCode, (Get-Short $ri.Body 500), $hint)
                    }
                }
            }
        } catch {
            Add-Warning ("插件构建/安装过程中异常：$($_.Exception.Message)")
        }

        # ---- F6 校验插件静态路由（loader 依赖它读取 theme.json） ----
        Write-Step ("F6. 校验插件静态路由 /plugin/{0}/ui/theme.json" -f $PluginId)
        $routeUri = "http://127.0.0.1:{0}/plugin/{1}/ui/theme.json" -f $PluginPort, $PluginId
        $rr2 = Invoke-Http -Uri $routeUri -Method 'GET' -TimeoutMs 30000
        if ($rr2.Ok -and $rr2.StatusCode -ge 200 -and $rr2.StatusCode -lt 300) {
            Write-Ok ("插件静态路由可用：HTTP {0}（{1} 字节）" -f $rr2.StatusCode, $rr2.Body.Length)
        } else {
            Write-Warn2 ("插件静态路由不可用：HTTP {0}" -f $rr2.StatusCode)
            Write-Warn2 "  最常见原因：plugin.toml 缺少/写错 [plugin] entry（API 仍返回 200，只有日志会提示）。"
            # 翻日志找根因
            $todayLog = Join-Path $LogDir ("N.E.K.O_Plugin_{0}.log" -f (Get-Date).ToString('yyyyMMdd'))
            if (Test-Path -LiteralPath $todayLog) {
                try {
                    $hits = @(Get-Content -LiteralPath $todayLog -Encoding UTF8 -Tail 400 |
                              Select-String -Pattern 'PLUGIN_SCHEMA_VALIDATION|invalid entry point|字段必填|neko_theme_studio' |
                              Select-Object -Last 6)
                    foreach ($h in $hits) { Write-Warn2 ("  日志：" + $h.Line.Trim()) }
                } catch { Write-Warn2 ("  读取日志失败：$($_.Exception.Message)") }
            } else {
                Write-Warn2 ("  未找到今日插件日志：$todayLog")
            }
        }

        # ---- F7 确保插件处于运行态（见下方独立小节；此处不重复） ----
    }
}

# ---------------------------------------------------------------------------
# F6b. 收尾：回滚点处理（只在失败时还原；删除留到验证通过后的清理段）
# ---------------------------------------------------------------------------
# 旧版先删插件目录再装，构建/安装失败时只留警告，用户会从「插件可用」变成「目录是半成品」。
# 现在旧目录在 E 步只改名成回滚点：**成功不在这里删**（要等 G 验证全部通过），
# 失败（或根本没跑到 F4）才把旧目录还原；还原前先把「失败现场」改名保留，
# 于是失败时磁盘上同时有「失败现场」与「旧目录」两份回滚点。

if (-not $SkipPluginInstall -and $pluginBakDir -and (Test-Path -LiteralPath $pluginBakDir)) {
    if ($pluginInstallOk) {
        Write-Info ("插件安装成功：旧插件目录回滚点暂留到验证通过后再清理：{0}" -f $pluginBakDir)
    } else {
        if (Test-Path -LiteralPath $UserPluginDir) {
            $failedDir = Join-Path $PluginRollbackRoot ($PluginId + '.failed-' + (Get-Date).ToString('yyyyMMdd-HHmmss'))
            try {
                Move-Item -LiteralPath $UserPluginDir -Destination $failedDir -Force -ErrorAction Stop
                Add-Warning ("插件未安装成功：失败现场已保留：{0}" -f $failedDir)
            } catch {
                Add-Warning ("插件未安装成功：失败现场改名失败（{0}），将直接覆盖删除：{1}" -f $_.Exception.Message, $UserPluginDir)
                Remove-Item -LiteralPath $UserPluginDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        try {
            Move-Item -LiteralPath $pluginBakDir -Destination $UserPluginDir -Force -ErrorAction Stop
            Add-Warning ("插件未安装成功，已把旧插件目录还原：$UserPluginDir（请检查上面的失败原因后重跑）")
        } catch {
            Add-Warning ("插件未安装成功，且旧插件目录还原失败（{0}）。回滚备份仍在：{1}" -f $_.Exception.Message, $pluginBakDir)
        }
    }
}

# 「停止自愈」标记：uninstall.ps1 写、这里删。存在时插件 startup 会整体跳过自愈，
# 所以安装成功后必须清掉，否则用户重装完主题仍然不生效。
# 主要清除点已提前到 F5 /plugins/reload 之前（reload 会触发插件 startup 自愈，
# 标记还在的话 20 多个只由插件补丁覆盖的模板会保持无标记、安装看起来成功却没主题）。
# 这一段是兜底：-SkipPluginInstall 场景、或 F4 成功但前面已把标记清掉的场景。
if ($pluginInstallOk -or $SkipPluginInstall) {
    if (Test-Path -LiteralPath $DisableFlag) {
        Remove-Item -LiteralPath $DisableFlag -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $DisableFlag) {
            Add-Warning ("安装成功，但无法删除卸载标记：$DisableFlag。插件 startup 不会自愈，请手动删除该文件后重启 N.E.K.O。")
        } else {
            Add-Change ("已清除「停止自愈」标记：$DisableFlag（插件恢复自愈）")
        }
    } else {
        Write-Info '未发现「停止自愈」标记（无需清除）'
    }
}

# ---------------------------------------------------------------------------
# F7. 确保插件处于运行态
# ---------------------------------------------------------------------------
#
# 面板的「读取」与「应用」都要调用插件 entry，而插件未运行时 48916 会以
# NOT_READY 拒绝（{"error":{"code":"NOT_READY","message":"Plugin ... is
# registered but not running"}}），用户会看到面板能打开但存不进任何颜色。
# 实测：静态路由 /ui/theme.json 在插件停止时**仍然 200**（颜色不会丢），
# 所以这一项不会被 F6 发现，必须单独确保。
#
# 这一节刻意放在插件安装块**之外**：从插件市场安装的场景走 -SkipPluginInstall
# （只打模板补丁 + 复制两件套），插件本体已由市场装好，但装好后同样是 stopped，
# 所以这一节必须在两种模式下都执行。
#
# 同时把 auto_start 打开（originless PUT）：插件停用/重启后，只要 auto_start 为
# true 服务端就会自行拉起它，用户不必再跑一次安装脚本。实测 PUT auto-start
# {"auto_start":true} 会同时把该插件从 plugin_autostart_pending.json 里移除，
# 是「持久生效」而不是仅写一个偏好位。
#
# 注意必须用**不带 Origin** 的请求：带 Origin（无论 48911 还是 48916）都会被
# mutation_auth 拒绝为 403 —— 只有本机 originless 写请求才被允许。
if ($p48916) {
    Write-Head 'F7. 确保插件处于运行态（面板调用 entry 的前提）'
    $statusUri = "http://127.0.0.1:{0}/plugins" -f $PluginPort
    $rs0 = Invoke-Http -Uri $statusUri -Method 'GET' -TimeoutMs 30000
    $curStatus = ''
    if ($rs0.Ok -and $rs0.StatusCode -ge 200 -and $rs0.StatusCode -lt 300) {
        try {
            $parsed = $rs0.Body | ConvertFrom-Json
            $entry = @($parsed.plugins | Where-Object { $_.id -eq $PluginId }) | Select-Object -First 1
            if ($entry) { $curStatus = [string]$entry.status }
        } catch { }
    }
    if ([string]::IsNullOrEmpty($curStatus)) {
        Write-Warn2 ("未能在 /plugins 中找到 {0}，跳过启动。若插件尚未安装，请先完成安装（不加 -SkipPluginInstall）。" -f $PluginId)
    } else {
        # F7a 打开自动启动（让运行态在重启后依然成立）
        $asUri = "http://127.0.0.1:{0}/plugin/{1}/auto-start" -f $PluginPort, $PluginId
        $as = Invoke-Http -Uri $asUri -Method 'PUT' -JsonBody '{"auto_start":true}' -TimeoutMs 60000
        if ($as.Ok -and $as.StatusCode -ge 200 -and $as.StatusCode -lt 300) {
            Write-Ok '已打开自动启动（重启后仍会自动拉起）'
        } else {
            Write-Warn2 ("打开自动启动失败：HTTP {0} {1}。插件仍可用，但重启应用后需要手动启用。" -f $as.StatusCode, (Get-Short $as.Body 200))
        }

        # F7b 立即启动（让这次会话立刻可用）
        #
        # 必须重试：F5 的 /plugins/reload 会重启插件服务，之后有一个重启窗口。
        # 在这段窗口里发起的启动会被拒绝为
        #   HTTP 409 {"detail":"Server is shutting down; plugin start rejected"}
        # 而不是「插件坏了」—— 实测踩到过。所以这里轮询到服务真正 ready 再启动，
        # 并把 409 当作「还没起来」而不是失败。
        $st = $null
        $ready = $false
        for ($i = 1; $i -le 20; $i++) {
            $rs1 = Invoke-Http -Uri $statusUri -Method 'GET' -TimeoutMs 15000
            if ($rs1.Ok -and $rs1.StatusCode -eq 200) {
                try {
                    $pj1 = $rs1.Body | ConvertFrom-Json
                    $e1 = @($pj1.plugins | Where-Object { $_.id -eq $PluginId }) | Select-Object -First 1
                    if ($e1) {
                        $curStatus = [string]$e1.status
                        # 服务在监听且能给出插件状态 = 重启窗口已过
                        $ready = $true
                        if ($curStatus -eq 'running') { break }
                    }
                } catch { }
            }
            if (-not $ready) { Start-Sleep -Milliseconds 750 }
        }
        if (-not $ready) {
            Write-Warn2 '插件服务在等待 15 秒后仍未就绪，跳过启动。'
        } elseif ($curStatus -eq 'running') {
            Write-Ok ("插件已在运行（status = '{0}'）" -f $curStatus)
        } else {
            $started = $false
            for ($k = 1; $k -le 3; $k++) {
                $st = Invoke-Http -Uri ("http://127.0.0.1:{0}/plugin/{1}/start" -f $PluginPort, $PluginId) -Method 'POST' -TimeoutMs 90000
                if ($st.Ok -and $st.StatusCode -ge 200 -and $st.StatusCode -lt 300) { $started = $true; break }
                # 409 + shutting down = 重启窗口未过，等一下再试
                if ($st.StatusCode -eq 409 -and $st.Body -match 'shutting down') {
                    Start-Sleep -Milliseconds 1200
                    continue
                }
                break
            }
            if ($started) {
                Write-Ok ("已启动插件（原状态 {0}）：HTTP {1}" -f $curStatus, $st.StatusCode)
                Add-Change ("插件已启动：{0}（面板需运行态才能调用 entry）" -f $PluginId)
            } else {
                Add-Warning ("插件启动失败：HTTP {0} {1}。面板可以打开，但「应用」会报 NOT_READY。" -f $st.StatusCode, (Get-Short $st.Body 300))
            }
        }

        # F7c：等插件异步自愈把全部页面的标记补齐，再交给 G 段验证。
        # 插件没起来就别等（只会白等 45 秒，G 会给出真正的原因）。
        if ($started -or $curStatus -eq 'running') {
            $propTargets = @(Get-VerificationTemplateTargets)
            if ($propTargets.Count -gt 0) {
                Write-Info ("等待插件自愈补齐页面标记（{0} 个目标，最多 45 秒）…" -f $propTargets.Count)
                $prop = Wait-NtsTemplatePropagation -Targets $propTargets -TimeoutSeconds 45
                if ($prop.Ok) {
                    Write-Ok ("插件自愈已补齐全部 {0} 个页面" -f $propTargets.Count)
                    Add-Change ("插件自愈补齐页面标记：{0} 个" -f $propTargets.Count)
                } else {
                    $names = (@($prop.Missing) | Select-Object -First 6) -join '、'
                    Write-Warn2 ("等了 45 秒，还有 {0} 个页面没有新标记：{1}" -f @($prop.Missing).Count, $names)
                    Add-Warning ("模板补丁未在 45 秒内补齐（{0} 个页面）：G 段会因此失败。插件起来后可重跑 install.ps1 -Verify。" -f @($prop.Missing).Count)
                }
            }
        }
    }
} else {
    Write-Info ("端口 {0}（插件服务）未监听，跳过 F7 运行态检查。" -f $PluginPort)
}

# ---------------------------------------------------------------------------
# F8. 修正插件目录完整性级别（Low）—— 让插件进程真的能写自己的数据
# ---------------------------------------------------------------------------
#   根因（实测 2026-11-18，v0.1.11 验收时发现）：N.E.K.O 的插件子进程以
#   **Low IL** 运行（projectneko_server.exe --multiprocessing-fork，token 完整性
#   级别 Low），而本脚本通常提权运行。提权进程写出的目录/文件带 High IL，Low 进程
#   往里 CREATE 新文件就是 ACCESS_DENIED：
#     - 面板「应用」→ 【Errno 13】...\static\.theme.json.<pid>.<tid>.tmp
#     - 插件 startup 打补丁 → 备份目录不可写，21 个模板静默放弃
#   把插件安装目录与备份目录显式降到 Low（继承），Low 进程即可创建文件，
#   而高 IL 进程读 Low 对象不受影响（读方向不受限）。
if (Test-Path -LiteralPath $UserPluginDir) {
    Write-Head 'F8. 修正插件目录完整性级别（Low IL 才有写权限）'
    $ilBefore = Get-NtsIntegrityLabel $UserPluginDir
    if (Set-NtsLowIntegrity $UserPluginDir) {
        if ($ilBefore -ne 'Low') {
            Add-Change ("插件目录完整性级别：{0} → Low（插件子进程为 Low IL，否则面板保存会 PermissionError）" -f $(if ($ilBefore) { $ilBefore } else { '继承' }))
        }
        Write-Ok ("插件目录完整性级别 = Low：{0}" -f $UserPluginDir)
    } else {
        Add-Warning ("插件目录完整性级别修正失败（当前 {0}）：{1}。面板「应用」可能报 Errno 13，请以管理员身份重跑本脚本。" -f $ilBefore, $UserPluginDir)
    }

    if (Test-Path -LiteralPath $UserDataBackupRoot) {
        $bakBefore = Get-NtsIntegrityLabel $UserDataBackupRoot
        if (Set-NtsLowIntegrity $UserDataBackupRoot) {
            if ($bakBefore -ne 'Low') {
                Add-Change ("备份目录完整性级别：{0} → Low（插件 startup 需要写原始模板备份）" -f $(if ($bakBefore) { $bakBefore } else { '继承' }))
            }
            Write-Ok ("备份目录完整性级别 = Low：{0}" -f $UserDataBackupRoot)
        } else {
            Add-Warning ("备份目录完整性级别修正失败（当前 {0}）：{1}" -f $bakBefore, $UserDataBackupRoot)
        }
    }
    # 模板目录也由插件（Low IL）在 startup 时原地补丁。应用装在 Program Files 之类
    # 受保护位置时，模板目录是 Medium/High，插件写不进去 → 除 chat/index 外的窗口
    # 会缺标记（白屏风险）。这里只警告，不擅自降低应用目录的安全性。
    $tplIl = Get-NtsIntegrityLabel $TemplateDir
    if ($tplIl -and $tplIl -ne 'Low') {
        Add-Warning ("模板目录完整性级别为 {0}（非 Low）：插件以 Low IL 运行时无法自行补丁除 chat/index 外的模板。若这些窗口白屏，请在宿主更新后以管理员身份重跑 install.ps1。" -f $tplIl)
    }
} else {
    Write-Info "插件安装目录不存在，跳过完整性级别修正：$UserPluginDir"
}

# ---------------------------------------------------------------------------
# G. 验证
# ---------------------------------------------------------------------------
$probes = @{}
foreach ($t in $TplTargets) { $probes[$t.Name] = Get-TextFileProbe -Path $t.Path }
$failedCount = Invoke-Verification

# ---------------------------------------------------------------------------
# G2. 清理：只有「新安装 + 验证」全部成功才删除旧回滚点 / 事务快照 / 旧用户数据备份
# ---------------------------------------------------------------------------
# 失败时全保留：旧回滚点、本次回滚点、模板 txn 快照、userdata 备份都能用来取证或手工恢复。
$pluginStateOk = $SkipPluginInstall -or $pluginVersionBlocked -or $pluginInstallOk
$installFullyOk = ($failedCount -eq 0) -and $pluginStateOk

if ($installFullyOk) {
    Write-Head 'G2. 清理旧回滚点与旧用户数据备份（安装 + 验证均成功）'

    foreach ($priorDir in @($script:PriorRollbackDirs)) {
        if (-not (Test-Path -LiteralPath $priorDir)) { continue }
        Remove-Item -LiteralPath $priorDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $priorDir) {
            Add-Warning ("旧的插件回滚点删除失败：{0}（可手动删除）" -f $priorDir)
        } else {
            Write-Ok ("已删除上一次的插件回滚点：{0}" -f $priorDir)
        }
    }

    if ($pluginBakDir -and (Test-Path -LiteralPath $pluginBakDir)) {
        Remove-Item -LiteralPath $pluginBakDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $pluginBakDir) {
            Add-Warning ("本次安装的旧插件目录回滚点删除失败：{0}（可手动删除）" -f $pluginBakDir)
        } else {
            Write-Ok ("已删除本次安装的旧插件目录回滚点：{0}" -f $pluginBakDir)
        }
    }

    if ($script:TemplateTxnDir -and (Test-Path -LiteralPath $script:TemplateTxnDir)) {
        Remove-Item -LiteralPath $script:TemplateTxnDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $script:TemplateTxnDir) {
            Add-Warning ("模板事务快照删除失败：{0}（可手动删除）" -f $script:TemplateTxnDir)
        } else {
            Write-Ok ("已删除模板事务快照：{0}" -f $script:TemplateTxnDir)
        }
    }

    if ($script:UserDataBackup -and $script:UserDataBackup.Dir) {
        $keepDir = [System.IO.Path]::GetFullPath($script:UserDataBackup.Dir)
        $oldBackups = @(Get-ChildItem -LiteralPath $UserDataBackupRoot -Directory -Filter 'userdata-*' -ErrorAction SilentlyContinue |
                        Where-Object { [System.IO.Path]::GetFullPath($_.FullName) -ne $keepDir })
        foreach ($ob in $oldBackups) {
            Remove-Item -LiteralPath $ob.FullName -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $ob.FullName) {
                Add-Warning ("旧用户数据备份删除失败：{0}（可手动删除）" -f $ob.FullName)
            } else {
                Write-Ok ("已清理旧用户数据备份：{0}" -f $ob.Name)
            }
        }
        Write-Info ("本次用户数据备份保留在：{0}（下次安装成功后会清理）" -f $keepDir)
    }
} else {
    Write-Head 'G2. 保留回滚点（安装或验证未全部成功）'
    if ($pluginBakDir) { Write-Warn2 ("旧插件目录回滚点保留：{0}" -f $pluginBakDir) }
    foreach ($priorDir in @($script:PriorRollbackDirs)) { Write-Warn2 ("上一次的回滚点保留：{0}" -f $priorDir) }
    if ($script:TemplateTxnDir) { Write-Warn2 ("模板事务快照保留：{0}" -f $script:TemplateTxnDir) }
    if ($script:UserDataBackup) { Write-Warn2 ("用户数据备份保留：{0}" -f $script:UserDataBackup.Dir) }
    Write-Warn2 '修复上面的失败原因后重跑 install.ps1；成功的一次会自动清理这些旧备份。'
}

# ---------------------------------------------------------------------------
# H. 报告
# ---------------------------------------------------------------------------
Write-Head 'H. 变更报告'

if ($script:Changes.Count -eq 0) {
    Write-Host '  本次没有任何文件被修改（系统已处于目标状态）。' -ForegroundColor Green
} else {
    Write-Host ("  共 {0} 项变更：" -f $script:Changes.Count) -ForegroundColor White
    $n = 1
    foreach ($c in $script:Changes) { Write-Host ("   {0,2}. {1}" -f $n, $c) -ForegroundColor Magenta; $n++ }
}

Write-Host ''
Write-Host '  补丁位置：' -ForegroundColor White
foreach ($t in $TplTargets) {
    $pr = $probes[$t.Name]
    $lines = Split-TextLines -Text $pr.Text -Eol $pr.Eol
    $no = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Contains($MarkerBegin)) { $no = $i + 1; break } }
    Write-Host ("   {0,-12} 第 {1} 行  ({2})" -f $t.Name, $no, $t.Path) -ForegroundColor Gray
}

Write-Host ''
Write-Host '  重要：请完全退出 N.E.K.O（含托盘图标）后重新打开，主题才会生效。' -ForegroundColor Cyan
Write-Host '        只刷新页面（F5）不够：loader 只在应用启动时加载，托盘图标也必须退出。' -ForegroundColor DarkGray

if ($script:Warnings.Count -gt 0) {
    Write-Host ''
    Write-Host ("  警告 {0} 条：" -f $script:Warnings.Count) -ForegroundColor Yellow
    $n = 1
    foreach ($w in $script:Warnings) { Write-Host ("   {0,2}. {1}" -f $n, $w) -ForegroundColor Yellow; $n++ }
}

$elapsed = ((Get-Date) - $StartedAt).TotalSeconds
Write-Host ''
if ($failedCount -gt 0) {
    Write-Host ("  ❌ 安装完成但验证有 {0} 项失败，用时 {1:N1} 秒。" -f $failedCount, $elapsed) -ForegroundColor Red
    exit 1
}
if (-not $pluginStateOk) {
    # 插件没装上（或升级失败）时不能报成功：应用侧补丁会照样生效，但主题面板/自动换主题
    # 全都不可用，exit 0 会让「一键升级」脚本以为一切正常。
    Write-Host ("  ❌ 应用侧已完成，但插件安装未成功，用时 {0:N1} 秒。" -f $elapsed) -ForegroundColor Red
    Write-Host '     修复上面的插件安装错误后重跑 install.ps1（加 -SkipPluginInstall 则只做应用侧）。' -ForegroundColor DarkGray
    exit 1
}
if ($script:Warnings.Count -gt 0) {
    Write-Host ("  ⚠ 安装完成（有 {0} 条警告），用时 {1:N1} 秒。" -f $script:Warnings.Count, $elapsed) -ForegroundColor Yellow
    exit 0
}
Write-Host ("  ✅ 安装完成且验证全部通过，用时 {0:N1} 秒。" -f $elapsed) -ForegroundColor Green
exit 0
