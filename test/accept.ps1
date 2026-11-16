<#
  accept.ps1 -- end-to-end acceptance for the N.E.K.O theme plugin.

  Verifies the user's stated acceptance path:
      install from the plugin market -> open the plugin panel -> change colours -> app restyles

  Gates (all must pass):
    A. plugin is running            (panel calls fail with NOT_READY otherwise)
    B. panel -> entry -> theme.json (drives the real plugin entries over HTTP)
    C. zero-change invariant        (empty palette: css=0 vs css=1 must be identical,
                                     in BOTH light and dark -- no unstyled regression)
    D. palette actually applies     (full palette: rows must differ from baseline)
    E. round trip                   (reset_theme -> rows return to baseline exactly)

  Every measurement uses the REAL deployed CSS and REAL deployed loader in headless Chrome.
  ASCII only: this repo is edited from Windows PowerShell 5.1.
#>
[CmdletBinding()]
param(
  [switch]$KeepFixture,
  [string]$Base = 'http://127.0.0.1:48916',
  [string]$App  = 'http://127.0.0.1:48911'
)

$ErrorActionPreference = 'Stop'

# The suite drives reset_theme, which empties the palette. Snapshot the user's
# live theme first and always put it back: a green acceptance run must never
# cost the user their colours (real-install regression: palette ended up empty).
$script:OrigThemeRaw = $null
$script:Csrf = ''
trap {
  if ($script:OrigThemeRaw) { Restore-UserTheme }
  Write-Host ('  [fatal] ' + $_.Exception.Message) -ForegroundColor Red
  if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
    Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
  }
  exit 1
}
$AppRoot = ''

# ---- restore the user's live palette (the suite resets it) --------------------
# Running acceptance must leave the machine exactly as it was, with the user's
# colours intact. Defined here (before anything can abort) so the trap above can
# always restore. Best effort: a failure is a warning, never a gate.
function Restore-UserTheme {
  if (-not $script:OrigThemeRaw) { return }
  try {
    $now = Utf8 "$Base/plugin/neko_theme_studio/ui/theme.json"
    if ($now -eq $script:OrigThemeRaw) { return }
    $tok = $script:Csrf
    if (-not $tok) { $tok = ((Utf8 "$Base/security/csrf-token") | ConvertFrom-Json).csrf_token }
    Invoke-Entry 'import_theme' @{ payload = $script:OrigThemeRaw } $tok | Out-Null
    Write-Host '  [info] restored the user palette that was live before this run' -ForegroundColor DarkGray
  } catch {
    Write-Host ('  [warn] could not restore the user palette: ' + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host ('         snapshot: ' + $script:OrigThemeRaw) -ForegroundColor DarkGray
  }
}
$Studio  = ''
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
if ($env:NTS_STUDIO) { $Studio = $env:NTS_STUDIO }
if ($env:NTS_APP_ROOT) { $AppRoot = $env:NTS_APP_ROOT }
$ChromeCands = @()
if ($env:NTS_BROWSER_PATH) { $ChromeCands += $env:NTS_BROWSER_PATH }
if ($env:CHROME_PATH)      { $ChromeCands += $env:CHROME_PATH }
$ChromeCands += @(
  'C:\Program Files\Chrome\App\chrome.exe'
  'C:\Program Files\Google\Chrome\Application\chrome.exe'
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
# chrome-headless-shell is a better fit for this suite than a GUI chrome: it never
# refuses headless mode. Include the usual install spot plus one placed next to the studio.
$ChromeCands += @(
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'chrome-headless-shell\chrome-headless-shell.exe' })
  (Join-Path (Split-Path -Parent $Studio) '_probe\chs\chrome-headless-shell-win64\chrome-headless-shell.exe')
  (Join-Path $Studio '_browser\chrome-headless-shell.exe')
)
# A path that exists is not enough: portable Chrome++ bundles can refuse to run
# headless (they exit without writing any DOM), which used to fail the suite with
# a misleading 'produced no output'. Preflight each candidate with a data: URL and
# keep the first one that actually renders something.
function Test-BrowserUsable([string]$exe) {
  $tmp = Join-Path $env:TEMP ('nts-preflight-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & $exe '--headless=new' '--disable-gpu' '--no-first-run' '--no-default-browser-check' `
             "--user-data-dir=$tmp\udd" '--virtual-time-budget=3000' '--dump-dom' `
             'data:text/html,<html><body>nts-preflight-ok</body></html>' 2>$null
    } finally { $ErrorActionPreference = $prevEap }
    return (($out -join "`n") -match 'nts-preflight-ok')
  } catch { return $false } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
$Chrome = $null
$ChromeDead = @()
foreach ($c in $ChromeCands) {
  if (-not $c) { continue }
  if (-not (Test-Path -LiteralPath $c)) { continue }
  if (Test-BrowserUsable $c) { $Chrome = $c; break }
  $ChromeDead += $c
}
if (-not $Chrome) {
  $msg = 'no usable headless Chromium browser found. 已找到但无法无头运行: ' + ($ChromeDead -join ', ')
  $msg += "。请用环境变量 NTS_BROWSER_PATH 指定可用的 chrome.exe 或 chrome-headless-shell.exe 完整路径（本机 Chrome++ 便携版无法无头运行）。"
  throw $msg
}
Write-Host ('  browser: ' + $Chrome) -ForegroundColor DarkGray

$script:Fail = 0
$script:Pass = 0
function Gate([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:Pass++; Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green }
  else { $script:Fail++; Write-Host ("  [FAIL] {0}" -f $name) -ForegroundColor Red }
  if ($detail) { Write-Host ("         {0}" -f $detail) -ForegroundColor DarkGray }
}

# Native stylesheet order: must match resources/bin/templates/chat.html exactly.
# The live page is opened over file:// (the app stopped serving /static/<x>.html),
# so these are fetched here and inlined instead of being <link>ed cross-origin.
# Where the plugin's own static files live (used to inline the theme sheet/script),
# and the URL base the plugin serves them on. Keep in sync with probe.ps1.
$script:NtsPluginUiBase = 'http://127.0.0.1:48916/plugin/neko_theme_studio/ui'
$script:NtsPluginStatic = Join-Path $env:LOCALAPPDATA 'N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\static'
if (-not (Test-Path -LiteralPath $script:NtsPluginStatic)) {
  $script:NtsPluginStatic = Join-Path $Studio 'plugin\static'
}

$script:NtsNativeCss = @(
  'css/index.css'
  'css/music_ui.css'
  'css/subtitle.css'
  'css/agent-plugin-views.css'
  'css/dark-mode.css'
  'css/yui-guide.css'
  'react/neko-chat/neko-chat-window.css'
)

function Invoke-NtsFetchText([string]$url) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [System.Text.Encoding]::UTF8
    return $wc.DownloadString($url)
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Utf8([string]$url) {
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60
  return [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}
function PostJson([string]$url, $obj) {
  # PS 5.1 serialises an empty hashtable as `[]`, which the plugin API rejects
  # ("Input should be a valid dictionary"), so emit a literal empty object.
  $json = '{}'
  if ($null -ne $obj) { $json = ($obj | ConvertTo-Json -Depth 12 -Compress) }
  if ([string]::IsNullOrWhiteSpace($json) -or $json -eq '[]' -or $json -eq '') { $json = '{}' }
  $body = [System.Text.Encoding]::UTF8.GetBytes($json)
  $r = Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 120
  return [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}

# ---- drive one plugin entry exactly the way the static panel does -------------
function Invoke-Entry([string]$entryId, $entryArgs, [string]$csrf) {
  # NB: the parameter cannot be named $args -- that is a PowerShell automatic
  # variable, and declaring it silently breaks the argument body.
  if ($null -eq $entryArgs) { $entryArgs = @{} }
  $body = @{ plugin_id = 'neko_theme_studio'; entry_id = $entryId; args = $entryArgs }
  $j = PostJson "$Base/runs" $body | ConvertFrom-Json
  $runId = if ($j.run_id) { $j.run_id } else { $j.id }
  if (-not $runId) { throw "no run id for $entryId : $($j | ConvertTo-Json -Compress)" }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $rec = (Utf8 "$Base/runs/$runId") | ConvertFrom-Json
    if ($rec.status -eq 'succeeded') { break }
    if ($rec.status -in @('failed', 'canceled', 'timeout')) {
      throw "entry $entryId -> $($rec.status): $($rec.error | ConvertTo-Json -Compress)"
    }
  }
  if ($rec.status -ne 'succeeded') { throw "entry $entryId timed out" }
  $exp = (Utf8 "$Base/runs/$runId/export") | ConvertFrom-Json
  $item = $exp.items | Where-Object { $_.type -eq 'json' -and $_.json } | Select-Object -First 1
  if (-not $item) { $item = $exp.items | Select-Object -First 1 }
  $raw = $item.json
  if ($null -eq $raw) { $raw = $item }
  for ($i = 0; $i -lt 5; $i++) {
    if ($raw -and $raw.data -and ($raw.PSObject.Properties.Name -contains 'success' -or $raw.PSObject.Properties.Name -contains 'error')) { $raw = $raw.data } else { break }
  }
  if ($raw.error) { throw "entry $entryId error: $($raw.error)" }
  return $raw
}

# ---- run live.html in headless Chrome and return the measurement --------------
# withCss=0 writes the page WITHOUT our artefacts (native baseline);
# withCss=1 writes the real <link>+<script> tags at the templates-patch position.
# Two separate files (rather than a query flag) because the loader must be a static
# <script> tag: a dynamically inserted one reintroduces load-order artefacts.
$LiveBase = $null
function Write-LivePage([int]$withCss) {
  if (-not $script:LiveBase) {
    $script:LiveBase = [System.IO.File]::ReadAllText((Join-Path $Studio 'test\live.html'))
    # The injection below is a whole-string replace, so the placeholder must occur
    # exactly once and never inside an inline <script>: an injected "</script>"
    # there would truncate the page's script and silently kill every measurement.
    $n = ([regex]::Matches($script:LiveBase, [regex]::Escape('<!--NTS_CSS_HOOK-->'))).Count
    if ($n -ne 1) { throw "live.html must contain the CSS hook exactly once (found $n)" }
    foreach ($s in [regex]::Matches($script:LiveBase, '(?s)<script>(.*?)</script>')) {
      if ($s.Groups[1].Value.Contains('NTS_CSS_HOOK')) {
        throw 'live.html mentions the CSS hook inside an inline <script>; injection would break the page'
      }
    }
    # An inline <script> must not contain the closing-script sequence anywhere, not even
    # in a comment: the HTML parser ends the block there and the rest runs as markup.
    foreach ($s in [regex]::Matches($script:LiveBase, '(?s)<script>(.*?)</script>')) {
      if ($s.Groups[1].Value -match '</\s*script') {
        throw 'live.html has a closing-script sequence inside an inline <script> (ends the block early)'
      }
    }
  }
  # Two hard facts force this shape (both measured on the portable build):
  #   1. 48911 only serves files that shipped with the app -- a stylesheet written
  #      into resources\bin\static afterwards is 404.
  #   2. The plugin API sends no Access-Control-Allow-Origin, so a file:// page
  #      (origin = null) can never fetch theme.json: fetchPalette throws
  #      "TypeError: Failed to fetch" and the palette is never applied, which is
  #      exactly what made six gates fail here before.
  # Therefore the page is served by the plugin itself (same origin as theme.json)
  # and every stylesheet/script is read straight off disk and inlined.
  $staticDir = Join-Path $AppRoot 'resources\bin\static'
  $inlineCss = ''
  foreach ($rel in $script:NtsNativeCss) {
    $disk = Join-Path $staticDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $disk)) { throw "live page: stylesheet missing on disk: $disk" }
    $txt = [System.IO.File]::ReadAllText($disk)
    $inlineCss += '<style data-nts-src="' + $rel + '">' + $txt + '</style>' + "`n"
  }
  $inject = if ($withCss -eq 1) {
    $ntsCssPath = Join-Path $script:NtsPluginStatic 'loader\neko-theme-studio.css'
    $ntsJsPath = Join-Path $script:NtsPluginStatic 'loader\neko-theme-studio.js'
    if (-not (Test-Path -LiteralPath $ntsCssPath)) { throw "live page: missing $ntsCssPath" }
    if (-not (Test-Path -LiteralPath $ntsJsPath)) { throw "live page: missing $ntsJsPath" }
    $ntsCss = [System.IO.File]::ReadAllText($ntsCssPath)
    $ntsJs = [System.IO.File]::ReadAllText($ntsJsPath)
    '<script>window.__NTS_CSS__=true;</script>' + "`n" +
    '<style data-nts-src="css/neko-theme-studio.css">' + $ntsCss + '</style>' + "`n" +
    '<script data-nts-src="neko-theme-studio.js">' + $ntsJs + '</script>'
  } else { '' }
  $pageName = "_nts_live_$withCss.html"
  $dir = $script:NtsPluginStatic
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $path = Join-Path $dir $pageName
  [System.IO.File]::WriteAllText($path,
    $script:LiveBase.Replace('<!--NTS_CSS_HOOK-->', $inlineCss + $inject),
    (New-Object System.Text.UTF8Encoding($false)))
  return ($script:NtsPluginUiBase + '/' + $pageName)
}

function Invoke-Live([string]$theme, [int]$withCss, [int]$wait) {
  $pageUrl = Write-LivePage $withCss
  $tag = "live-$theme-$withCss"
  $tmp = Join-Path $env:TEMP $tag
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $dom = Join-Path $tmp 'out.html'
  $url = $pageUrl + "?theme=$theme&wait=$wait&base=$Base"
  $argv = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-extensions', "--user-data-dir=$tmp\udd", '--virtual-time-budget=15000',
            '--dump-dom', $url)
  # Chrome writes noise to stderr (e.g. externally_managed_app_manager.cc:680
  # "failed to install with reason 21"). Under $ErrorActionPreference='Stop' PS 5.1
  # promotes a native command's stderr into a TERMINATING error, which killed this
  # suite mid-run. Scope the preference down for just the call, and prove the DOM
  # file exists afterwards instead of trusting the exit code.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Chrome @argv 2>$null | Set-Content -LiteralPath $dom -Encoding UTF8
  } finally { $ErrorActionPreference = $prevEap }
  if (-not (Test-Path -LiteralPath $dom)) { throw "live probe ($tag): chrome produced no DOM file" }
  $txt = [System.IO.File]::ReadAllText($dom)
  # Primary channel: base64 payload on <html> (survives any DOM interference and
  # cannot be confused with markup). Falls back to the <pre> channel.
  $p = [regex]::Match($txt, 'data-nts-payload="([^"]*)"')
  if ($p.Success -and $p.Groups[1].Value) {
    $b64 = [System.Net.WebUtility]::HtmlDecode($p.Groups[1].Value)
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
    return $json | ConvertFrom-Json
  }
  $m = [regex]::Match($txt, '(?s)<pre id="nts-out"[^>]*>(.*?)</pre>')
  if (-not $m.Success -or -not $m.Groups[1].Value) { throw "live probe ($tag) produced no output" }
  return ([System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)) | ConvertFrom-Json
}

function RowMap($probe) {
  $h = @{}
  foreach ($p in $probe.rows.PSObject.Properties) { $h[$p.Name] = [string]$p.Value }
  return $h
}
function DiffRows($a, $b) {
  $d = @()
  foreach ($k in $a.Keys) {
    if ($a[$k] -ne $b[$k]) { $d += [pscustomobject]@{ key = $k; from = $a[$k]; to = $b[$k] } }
  }
  return $d
}

Write-Host ''
Write-Host '=== N.E.K.O theme plugin :: end-to-end acceptance ===' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- A. plugin running
Write-Host 'A. plugin reachable and running' -ForegroundColor White
$plugins = (Utf8 "$Base/plugins") | ConvertFrom-Json
$me = $plugins.plugins | Where-Object { $_.id -eq 'neko_theme_studio' }
Gate 'plugin is registered' ($null -ne $me) ("version " + $me.version + " source " + $me.source)
if ($me.status -ne 'running') {
  Write-Host '  -> starting it (panel calls would fail with NOT_READY otherwise)' -ForegroundColor Yellow
  PostJson "$Base/plugin/neko_theme_studio/start" $null | Out-Null
  Start-Sleep -Seconds 2
  $plugins = (Utf8 "$Base/plugins") | ConvertFrom-Json
  $me = $plugins.plugins | Where-Object { $_.id -eq 'neko_theme_studio' }
}
Gate 'plugin status = running' ($me.status -eq 'running') ("status=" + $me.status + " startup_state=" + $me.runtime_startup_state)
$panels = @($me.plugin_ui.panel)
Gate 'has a static panel (app can fetch theme.json over its static route)' `
     (($panels.Count -ge 1) -and ($panels[0].mode -eq 'static')) `
     ("panel id=" + $panels[0].id + " mode=" + $panels[0].mode + " entry=" + $panels[0].entry)
$script:OrigThemeRaw = Utf8 "$Base/plugin/neko_theme_studio/ui/theme.json"
$tj = $script:OrigThemeRaw | ConvertFrom-Json
Gate 'theme.json is served on the static route' ($null -ne $tj) ("updated_at " + $tj.updated_at + " enabled " + $tj.enabled)

# ---------------------------------------------------------------- C. zero-change
Write-Host ''
Write-Host 'C. zero-change invariant (empty palette must not alter the native look)' -ForegroundColor White
$csrf = ((Utf8 "$Base/security/csrf-token") | ConvertFrom-Json).csrf_token
$script:Csrf = $csrf
Invoke-Entry 'reset_theme' @{} $csrf | Out-Null
Start-Sleep -Milliseconds 400
foreach ($theme in @('light', 'dark')) {
  $baseL = RowMap (Invoke-Live $theme 0 800)
  $mineL = RowMap (Invoke-Live $theme 1 2500)
  $d = DiffRows $baseL $mineL
  Gate ("no visual change in " + $theme + " with an empty palette") ($d.Count -eq 0) `
       ("compared " + $baseL.Count + " measurements; differences = " + $d.Count)
  if ($d.Count -gt 0) {
    $shown = 0
    foreach ($x in $d) {
      if ($shown -ge 30) { Write-Host ("           ... and " + ($d.Count - 30) + " more") -ForegroundColor DarkGray; break }
      Write-Host ("           " + $x.key + " : native=" + $x.from + "  ours=" + $x.to) -ForegroundColor DarkYellow
      $shown++
    }
  }
}

# ---------------------------------------------------------------- D. palette applies
Write-Host ''
Write-Host 'D. full palette across all 7 colour categories' -ForegroundColor White
$full = @{
  vars = @{
    '--nts-user-bubble-bg' = '#7c3aed'; '--nts-user-bubble-text' = '#ffffff'
    '--nts-ai-bubble-bg' = '#0f5132'; '--nts-ai-bubble-text' = '#d1e7dd'
    '--nts-chat-bg' = '#101820'; '--nts-input-bg' = '#14213d'
    '--nts-input-text' = '#fca311'; '--nts-send-bg' = '#e63946'
    '--nts-panel-bg' = '#22223b'; '--nts-modal-bg' = '#4a4e69'
    '--nts-chip-bg' = '#3a0ca3'; '--nts-chip-text' = '#f72585'
    '--nts-link' = '#f72585'; '--nts-accent' = '#4361ee'
    '--nts-radius' = '20px'; '--nts-bubble-radius' = '20px'
    '--nts-font-size' = '17px'; '--nts-chat-blur' = 'blur(30px)'
  }
  # v3: the two groups are INDEPENDENT (the user chose "each mode manages itself"), so dark
  # needs its own palette or "palette changes the app in dark" would only ever move the few
  # targets whose variables appear in both groups. --nts-chat-blur is deliberately kept
  # light-only: it is what the "a light-only variable must not leak into dark" gate checks.
  dark_vars = @{
    '--nts-user-bubble-bg' = '#f72585'; '--nts-chat-bg' = '#05070a'
    '--nts-chip-bg' = '#7209b7'; '--nts-link' = '#4cc9f0'
    '--nts-ai-bubble-bg' = '#123524'; '--nts-ai-bubble-text' = '#a7f3d0'
    '--nts-user-bubble-text' = '#0b1020'; '--nts-input-bg' = '#1b1b3a'
    '--nts-input-text' = '#ffd166'; '--nts-send-bg' = '#d90429'
    '--nts-panel-bg' = '#16162a'; '--nts-modal-bg' = '#2b2b45'
    '--nts-chip-text' = '#c77dff'; '--nts-accent' = '#7c3aed'
    '--nts-radius' = '18px'; '--nts-bubble-radius' = '18px'
    '--nts-font-size' = '16px'
  }
  name = 'acceptance'; enabled = $true
}
$applied = Invoke-Entry 'apply_theme' $full $csrf
Start-Sleep -Milliseconds 500
Gate 'apply_theme persisted the light variables' (($applied.vars.PSObject.Properties.Name).Count -ge 15) `
     ("updated_at " + $applied.updated_at + ", light vars = " + ($applied.vars.PSObject.Properties.Name).Count + ", dark vars = " + ($applied.dark_vars.PSObject.Properties.Name).Count)
$rj = Utf8 "$Base/plugin/neko_theme_studio/ui/theme.json" | ConvertFrom-Json
Gate 'theme.json on disk matches what was applied' ($rj.vars.'--nts-user-bubble-bg' -eq '#7c3aed') `
     ("--nts-user-bubble-bg = " + $rj.vars.'--nts-user-bubble-bg' + ", --nts-chat-blur = " + $rj.vars.'--nts-chat-blur')

$lm = @{}
$dm = @{}
foreach ($theme in @('light', 'dark')) {
  $baseL = RowMap (Invoke-Live $theme 0 800)
  $mineL = RowMap (Invoke-Live $theme 1 3000)
  $d = DiffRows $baseL $mineL
  $tot = $baseL.Count
  Gate ("palette changes the app in " + $theme) ($d.Count -ge [int]($tot * 0.5)) `
       ("changed " + $d.Count + " / " + $tot + " measurements")
  $n = 0
  foreach ($x in $d) {
    if ($n -ge 14) { Write-Host ("           ... and " + ($d.Count - 14) + " more") -ForegroundColor DarkGray; break }
    Write-Host ("           " + $x.key + " : " + $x.from + "  ->  " + $x.to) -ForegroundColor DarkCyan
    $n++
  }
  if ($theme -eq 'light') { $lm = $mineL } else { $dm = $mineL }
}
Gate 'user bubble is exactly the requested colour' ($lm['g1-user-bubble||.message-bubble-user||background-color'] -eq 'rgb(124, 58, 237)') `
     ("got " + $lm['g1-user-bubble||.message-bubble-user||background-color'])
Gate 'dark override wins in dark mode' ($dm['g1-user-bubble||.message-bubble-user||background-color'] -eq 'rgb(247, 37, 133)') `
     ("got " + $dm['g1-user-bubble||.message-bubble-user||background-color'])
Gate 'blur was actually applied (not silently dropped)' ($lm['g3-chat-window||.window-topbar||backdrop-filter'] -match 'blur\(30px\)') `
     ("got " + $lm['g3-chat-window||.window-topbar||backdrop-filter'])
Gate 'radius applied' ($lm['g7-global||.message-bubble-user||border-top-left-radius'] -eq '20px') `
     ("got " + $lm['g7-global||.message-bubble-user||border-top-left-radius'])

# v3: the two groups are independent, so a variable set ONLY in the light group must not
# move dark mode. --nts-chat-blur is light-only in this palette, and the topbar exists in
# both modes, so dark must still show its native backdrop-filter.
Gate 'a light-only variable does not leak into dark mode' `
     ($dm['g3-chat-window||.window-topbar||backdrop-filter'] -notmatch 'blur\(30px\)') `
     ("dark topbar backdrop-filter = " + $dm['g3-chat-window||.window-topbar||backdrop-filter'])

# ---------------------------------------------------------------- E. round trip
Write-Host ''
Write-Host 'E. round trip (reset restores the exact native look)' -ForegroundColor White
Invoke-Entry 'reset_theme' @{} $csrf | Out-Null
Start-Sleep -Milliseconds 500
foreach ($theme in @('light', 'dark')) {
  $baseL = RowMap (Invoke-Live $theme 0 800)
  $mineL = RowMap (Invoke-Live $theme 1 2800)
  $d = DiffRows $baseL $mineL
  Gate ("reset returns " + $theme + " exactly to native") ($d.Count -eq 0) ("differences = " + $d.Count)
  if ($d.Count -gt 0 -and $d.Count -le 10) {
    foreach ($x in $d) { Write-Host ("           " + $x.key + " : native=" + $x.from + "  ours=" + $x.to) -ForegroundColor DarkYellow }
  }
}

# ------------------------------------------------- F. real-page gated variables
# The A/B harness proved the fixture's measured fallback for a few pairs is WRONG
# on the real page, so gen-css.js removed their fallback entirely: they fire only
# when the user actually sets the variable (the loader then puts data-nts-<var> on
# <html>). These two probes cover the whole bargain on the REAL page:
#   F1  panel UI drive      -- type a colour, click Apply, click Reset
#   F2  gated vars          -- setting them moves the page, clearing them restores it
Write-Host ''
Write-Host 'F. real page: panel UI drive + gated variables' -ForegroundColor White

$Node = @(
  (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'),
  'C:\Program Files\nodejs\node.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$EvalJs = Join-Path $Studio 'tools\page-eval.js'

function Invoke-PageProbe([string]$label, [string]$url, [string]$expr, [int]$port) {
  if (-not $Node -or -not (Test-Path $EvalJs)) { return $null }
  $tmp = Join-Path $env:TEMP ("nts_" + $label + ".json")
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Node $EvalJs --url $url --js $expr --port $port --timeout 180000 2>$null |
      Set-Content -LiteralPath $tmp -Encoding UTF8
  } finally { $ErrorActionPreference = $prev }
  if (-not (Test-Path -LiteralPath $tmp)) { return $null }
  $raw = [System.IO.File]::ReadAllText($tmp)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  try { return $raw | ConvertFrom-Json } catch { return $null }
}

if (-not $Node) {
  Gate 'real-page probes available' $false 'no node.exe found'
} else {
  # F1 -- drive the panel's own controls
  $p1 = Invoke-PageProbe 'panelui' "$Base/plugin/neko_theme_studio/ui/" (Join-Path $Studio 'test\expr-panelui.js') 9431
  if (-not $p1) {
    Gate 'panel UI drive produced output' $false 'page-eval produced nothing'
  } else {
    foreach ($c in @(
      @('panel renders its rows',            'rows_rendered'),
      @('typing a colour marks the row dirty','row_marked_dirty'),
      @('Apply button counts the pending edits','apply_label_counts_change'),
      @('clicking Apply reports success',    'apply_succeeded'),
      @('typed colour reached theme.json',   'value_reached_theme_json'),
      @('clicking Reset reports success',    'reset_succeeded'),
      @('Reset emptied the palette',         'reset_emptied_the_palette'),
      @('Reset clears the dirty state',      'no_dirty_rows_after_reset'),
      @('Reset neutralises the colour swatch','swatch_neutralised_after_reset')
    )) {
      $key = $c[1]
      $v = $p1.checks.$key
      Gate $c[0] ([bool]$v) ("verdict=" + $p1.verdict + "  value=" + $p1.gotValue)
    }
  }

  # F2 -- the real-page gates really work when the user sets the variable.
  # v3: every rule is gated per (mode, variable), so each check exists once per mode and
  # there is additionally a "the other mode stayed inert" check per target.
  $p2 = Invoke-PageProbe 'realgated' "$App/chat" (Join-Path $Studio 'test\expr-realgated.js') 9432
  if (-not $p2) {
    Gate 'real-page gated-variable probe produced output' $false 'page-eval produced nothing'
  } else {
    $checks = @()
    foreach ($m in @('light', 'dark')) {
      # NB: parentheses are mandatory around the label expressions. In PowerShell the
      # comma operator binds TIGHTER than '+', so `"x" + $c[0], $key` silently becomes
      # `"x" + ($c[0], $key)` -- one concatenated label and a $null key.
      foreach ($c in @(
        @('shell radius takes effect when set',    'shell_moved_when_set'),
        @('shell radius is the requested value',   'shell_is_requested'),
        @('input background takes effect',         'inputbg_moved_when_set'),
        @('input background is requested value',   'inputbg_is_requested'),
        @('composer border takes effect',          'cmpbord_moved_when_set'),
        @('composer border is requested value',    'cmpbord_is_requested'),
        @('clearing restores shell radius',        'shell_restored_when_cleared'),
        @('clearing restores input background',    'inputbg_restored_when_cleared'),
        @('clearing restores composer border',     'cmpbord_restored_when_cleared'),
        @('shell radius stays native in the other mode',     'shell_otherModeUntouched'),
        @('input background stays native in the other mode', 'inputbg_otherModeUntouched'),
        @('composer border stays native in the other mode',  'cmpbord_otherModeUntouched')
      )) {
        $checks += , @((('gated[' + $m + ']: ') + $c[0]), ($m + '_' + $c[1]))
      }
      $checks += , @((('gated[' + $m + ']: ') + 'gate attributes appear then vanish'), ($m + '_gates_set'))
      $checks += , @((('gated[' + $m + ']: ') + 'gate attributes are cleared'),        ($m + '_gates_cleared'))
      $checks += , @((('gated[' + $m + ']: ') + "other group's gates never set"),      ($m + '_otherGroupGatesAbsent'))
    }
    foreach ($c in $checks) {
      $key = $c[1]
      $v = $p2.checks.$key
      if ($null -eq $v) {
        Gate $c[0] $false ("check '" + $key + "' missing from the probe output (verdict=" + $p2.verdict + ")")
      } else {
        Gate $c[0] ([bool]$v) ("verdict=" + $p2.verdict)
      }
    }
  }

  # F3 -- bubble TEXT colours are isolated from each other.
  # User report (0.1.4): changing the AI text colour also recoloured the user's own
  # messages, and the user text colour seemed to do nothing. Root cause was a scope leak
  # in the generated CSS (an unscoped body .message-block-text rule plus user rules on
  # dead .message.user selectors). test\expr-textscope.js freezes the bargain: it drives
  # apply_theme with ONE text colour at a time on the real page and measures a fixture
  # mounted in the real shape (message-row > message-stack > message-bubble > block).
  $p3 = Invoke-PageProbe 'textscope' "$App/chat" (Join-Path $Studio 'test\expr-textscope.js') 9433
  if (-not $p3) {
    Gate 'bubble text scope probe produced output' $false 'page-eval produced nothing'
  } else {
    foreach ($m in @('light', 'dark')) {
      foreach ($c in @(
        @('AI text colour lands on the assistant bubble',         'ai_text_is_requested'),
        @('AI text colour does NOT recolour user messages',       'ai_does_not_touch_user'),
        @('AI text colour does NOT recolour tool/system bubbles', 'ai_does_not_touch_tool'),
        @('user plain text colour applies',                       'user_plain_text_applies'),
        @('user markdown text colour applies',                    'user_markdown_applies'),
        @('user text colour does NOT recolour AI messages',       'user_does_not_touch_ai'),
        @('tool text colour applies to tool bubbles',             'tool_text_applies'),
        @('tool text colour also covers system bubbles',          'system_text_follows_tool'),
        @('tool text colour does NOT recolour user messages',     'tool_does_not_touch_user'),
        @('clearing restores the user text colour',               'clear_restores_user'),
        @('clearing restores the AI text colour',                 'clear_restores_ai'),
        # Same family of scope leaks: .composer-panel used to carry the panel text colour,
        # so the compact capsule (a DESCENDANT of .composer-panel) inherited it; and the
        # base font size only reached markdown messages, leaving plain text untouched.
        @('panel text colour does NOT recolour the compact capsule', 'panel_keeps_capsule_text'),
        @('base font size applies to plain-text messages',           'font_applies_to_plain_text'),
        @('base font size applies to markdown messages',             'font_applies_to_markdown'),
        @('base font size leaves the capsule text alone',            'font_leaves_panel_alone')
      )) {
        $key = $m + '_' + $c[1]
        $v = $p3.checks.$key
        if ($null -eq $v) {
          Gate (('textscope[' + $m + ']: ') + $c[0]) $false ("check '" + $key + "' missing (verdict=" + $p3.verdict + ")")
        } else {
          Gate (('textscope[' + $m + ']: ') + $c[0]) ([bool]$v) ("verdict=" + $p3.verdict)
        }
      }
    }
  }
}

# ---------------------------------------------------------------- restore user theme
Restore-UserTheme

# ---------------------------------------------------------------- cleanup
Write-Host ''
if (-not $KeepFixture) {
  foreach ($n in @(0, 1)) {
    $stale = Join-Path $script:NtsPluginStatic "_nts_live_$n.html"
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue }
  }
}

Write-Host ("=== {0} passed, {1} failed ===" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
if ($script:Fail -ne 0) { exit 1 }
exit 0
