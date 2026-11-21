<#
  probe.ps1 -- dot-sourceable helper that runs the computed-style fixture in real headless Chrome.
  Why this exists: the stylesheet's core invariant is
      property: var(--nts-x, <NATIVE COMPUTED VALUE>) !important;
  and it only holds if <NATIVE COMPUTED VALUE> is what the browser actually produced.
  Hand-written fallbacks were measured wrong 25 times on the first attempt, so every
  fallback in the generated CSS now comes from this probe.
  Usage (dot-source, then call):
      . "$PSScriptRoot\probe.ps1"
      $r = Invoke-NtsProbe -Mode native -Theme light -WithCss $false
  Returns the parsed JSON the page wrote into #nts-out:
      { mode, theme, mine, diag, rows[], rowsThemed[], unavailable{} }
  ASCII only on purpose: this repo is edited from Windows PowerShell 5.1, which mis-decodes
  BOM-less UTF-8 script files and dies with "missing terminator" on non-ASCII source.
#>
[CmdletBinding()]
param()
$script:NtsAppRoot = if ($env:NTS_APP_ROOT) { $env:NTS_APP_ROOT } else { 'D:\tools\enokoo' }
$script:NtsStudio  = if ($env:NTS_STUDIO)  { $env:NTS_STUDIO }  else { 'D:\tools\enokoo\theme-studio' }
$script:NtsBase    = if ($env:NTS_BASE)    { $env:NTS_BASE }    else { 'http://127.0.0.1:48911' }

# Probe page routing.
#   The app no longer serves arbitrary files under resources/bin/static
#   (measured on the portable build: /static/css/index.css -> 200, but
#   /static/index.html and /static/anything.html -> 404), and /<name>.html
#   at the app root returns the 53 KB SPA shell rather than the file.
#   The plugin UI route (48916) does serve html, but a page loaded from it
#   cannot read 48911 stylesheets (cross-origin: cssRules throws
#   SecurityError, so ntsRules is always 0).
#   => the probe page is written to a scratch dir and opened over file://,
#      with every stylesheet fetched from NtsBase and inlined as <style>.

# Where the probe page lives and how it is opened.
#   plugin (default) -> plugin static dir + http://127.0.0.1:48916 UI route.
#                       Same origin as theme.json, so the loader's fetch needs no CORS.
#   file             -> scratch dir + file:// (kept for offline debugging; the loader
#                       can never read theme.json from there, so ntsRules/gates stay 0).
$script:NtsProbeServe = if ($env:NTS_PROBE_SERVE) { $env:NTS_PROBE_SERVE } else { 'plugin' }
$script:NtsProbeBase = 'http://127.0.0.1:48916/plugin/neko_theme_studio/ui'
$script:NtsProbeDir = Join-Path $env:TEMP 'nts-probe-fixtures'
if ($script:NtsProbeServe -eq 'plugin') {
  $cand = Join-Path $env:LOCALAPPDATA 'N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\static'
  if (-not (Test-Path -LiteralPath $cand)) {
    $cand = Join-Path $script:NtsStudio 'plugin\static'
  }
  if (Test-Path -LiteralPath $cand) { $script:NtsProbeDir = $cand }
}

# Native stylesheet order: must match resources/bin/templates/chat.html exactly.
$script:NtsNativeCss = @(
  'css/index.css'
  'css/music_ui.css'
  'css/subtitle.css'
  'css/agent-plugin-views.css'
  'css/dark-mode.css'
  'css/yui-guide.css'
  'react/neko-chat/neko-chat-window.css'
)

function Invoke-NtsFetchText {
  <# Fetch a URL as text. The probe page is opened over file://, so a cross-origin
     <link> to 48911 is unreadable (SecurityError on cssRules); we fetch the bytes
     here and inline them as <style> instead.
     WebClient rather than Invoke-WebRequest: on this PS5.1 the latter fails with
     "Win32 internal error Access is denied 0x5" while reading the console buffer. #>
  param([Parameter(Mandatory=$true)][string]$Url)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [System.Text.Encoding]::UTF8
    return $wc.DownloadString($Url)
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Get-NtsChrome {
  $cCands = @()
  if ($env:NTS_BROWSER_PATH) { $cCands += $env:NTS_BROWSER_PATH }
  if ($env:CHROME_PATH)      { $cCands += $env:CHROME_PATH }
  $cCands += @(
    $env:NTS_BROWSER_PATH
    $env:CHROME_PATH
    'C:\Program Files\Chrome\App\chrome.exe'
    'C:\Program Files\Google\Chrome\Application\chrome.exe'
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  )
  $c = $cCands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $c) { throw 'no Chromium browser found:  NTS_BROWSER_PATH  chrome.exe chrome-headless-shell ' }
  return $c
}

function New-NtsFixture {
  <# Writes the probe fixture into the app's served static dir and returns its URL path. #>
  $fixture = Join-Path $script:NtsStudio 'test\fixture.html'
  if (-not (Test-Path $fixture)) { throw "fixture missing: $fixture" }
  $src = [System.IO.File]::ReadAllText($fixture)
  if ($src.IndexOf('<!--NTS_CSS_INLINE-->') -lt 0) { throw 'fixture has no <!--NTS_CSS_INLINE--> placeholder' }
  if ($src.IndexOf('/*NTS_TARGETS_JS*/') -lt 0) { throw 'fixture has no /*NTS_TARGETS_JS*/ placeholder' }

  # inline the target table so the page and the generator share one source of truth
  $targetsJs = [System.IO.File]::ReadAllText((Join-Path $script:NtsStudio 'test\targets.js'))
  $targetsJs = $targetsJs -replace '(?s)if \(typeof module[\s\S]*$', ''
  $src = $src.Replace('/*NTS_TARGETS_JS*/', $targetsJs)

  $probeName = '_nts_probe_fixture_' + [Guid]::NewGuid().ToString('N') + '.html'
  if (-not (Test-Path -LiteralPath $script:NtsProbeDir)) {
    New-Item -ItemType Directory -Path $script:NtsProbeDir -Force | Out-Null
  }
  $probePath = Join-Path $script:NtsProbeDir $probeName
  # Read the native stylesheets straight off disk. HTTP is not an option any more:
  # 48911 only serves files that shipped with the app (a freshly written
  # resources\bin\static\x.css is 404), and a cross-origin <link> makes
  # cssRules throw SecurityError, which silently zeroes the rule count.
  $staticDir = Join-Path $script:NtsAppRoot 'resources\bin\static'
  $inline = ''
  foreach ($rel in $script:NtsNativeCss) {
    $disk = Join-Path $staticDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $disk)) { throw "probe fixture: stylesheet missing on disk: $disk" }
    $text = [System.IO.File]::ReadAllText($disk)
    $inline += '<style data-nts-src="' + $rel + '">' + $text + '</style>' + "`n"
  }
  if ($WithCssGlobal) {
    $disk = Join-Path $staticDir 'css\neko-theme-studio.css'
    if (-not (Test-Path -LiteralPath $disk)) { throw "probe fixture: theme stylesheet missing on disk: $disk" }
    $cssText = [System.IO.File]::ReadAllText($disk)
    $inline += '<style data-nts-src="css/neko-theme-studio.css">' + $cssText + '</style>' + "`n"
  }
  $html = $src.Replace('<!--NTS_CSS_INLINE-->', $inline)
  $full = [System.IO.Path]::GetFullPath($probePath)
  [System.IO.File]::WriteAllText($full, $html, (New-Object System.Text.UTF8Encoding($false)))
  if ($script:NtsProbeServe -eq 'plugin') {
    return $script:NtsProbeBase + '/' + $probeName
  }
  return ([System.Uri]::new($full)).AbsoluteUri
}

$script:WithCssGlobal = $false

function Invoke-NtsProbe {
  [CmdletBinding()]
  param(
    [ValidateSet('native', 'sentinel')] [string]$Mode = 'native',
    [ValidateSet('light', 'dark')]     [string]$Theme = 'light',
    [switch]$WithCss,
    [string]$Tag = ''
  )
  $script:WithCssGlobal = [bool]$WithCss
  $probePath = New-NtsFixture
  $chrome = Get-NtsChrome

  if (-not $Tag) { $Tag = "$Mode-$Theme-$(if ($WithCss) { 'mine' } else { 'base' })" }
  $tmp = Join-Path $env:TEMP ('nts-probe-' + $Tag)
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $dom = Join-Path $tmp 'out.dom.html'
  $udd = Join-Path $tmp 'udd'
  $qs = "?mode=$Mode" + $(if ($Theme -eq 'dark') { '&theme=dark' } else { '' })
  $url = $probePath + $qs

  $argv = @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', "--user-data-dir=$udd", '--virtual-time-budget=10000',
    '--allow-file-access-from-files', '--dump-dom', $url
  )
  # Chrome writes progress/warning noise to stderr (e.g. "externally_managed_app_manager
  # ... failed to install with reason 21"). Under $ErrorActionPreference='Stop' inherited
  # from the caller, PowerShell 5.1 turns any native stderr into a terminating error and
  # the probe dies mid-run. The DOM on stdout is the only thing that matters here, so
  # relax the preference just for this call.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $chrome @argv 2>$null | Set-Content -LiteralPath $dom -Encoding UTF8
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if (-not (Test-Path $dom)) { throw "probe '$Tag' produced no dom dump (chrome failed to start?)" }
  $txt = [System.IO.File]::ReadAllText($dom)
  $m = [regex]::Match($txt, '(?s)<pre id="nts-out"[^>]*>(.*?)</pre>')
  if (-not $m.Success) { throw "probe '$Tag' produced no #nts-out (chrome run failed?)" }
  $json = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
  try { return $json | ConvertFrom-Json } catch { throw "probe '$Tag' JSON parse failed: $($_.Exception.Message)" }
}

function Remove-NtsFixture {
  Get-ChildItem -LiteralPath $script:NtsProbeDir -Filter '_nts_probe_fixture_*.html' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Path $env:TEMP -Filter 'nts-probe-*' -Directory -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Assert-NtsServices {
  <# Both servers must be up or every measurement is void. #>
  foreach ($u in @("$($script:NtsBase)/static/css/index.css")) {
    try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 5 }
    catch { throw "app server not reachable: $u -- $($_.Exception.Message)" }
    if ($r.StatusCode -ne 200) { throw "app server returned $($r.StatusCode) for $u" }
  }
  return $true
}

function Invoke-NtsPaletteReset {
  <# Empty the saved palette through the plugin's own entry, so the A/B zero-change check
     compares like with like: with a non-empty palette every measured difference is just
     the user's own colour, and the harness cannot tell a defect from a feature.

     Drives the panel's calling convention (CSRF -> POST /runs -> poll GET /runs/{id}).
     Returns the resulting theme.json object, or $null when the plugin is unreachable. #>
  $base = 'http://127.0.0.1:48916'
  $plugin = 'neko_theme_studio'
  try {
    $csrf = ''
    try {
      $c = Invoke-RestMethod -Uri "$base/security/csrf-token" -Method Get -TimeoutSec 8
      $csrf = [string]$c.csrf_token
    } catch { }
    $hdr = @{}
    if ($csrf) { $hdr['X-CSRF-Token'] = $csrf }
    $body = '{"plugin_id":"' + $plugin + '","entry_id":"reset_theme","args":{}}'
    $r = Invoke-RestMethod -Uri "$base/runs" -Method Post -Headers $hdr `
           -ContentType 'application/json; charset=utf-8' `
           -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
    $runId = if ($r.run_id) { $r.run_id } elseif ($r.id) { $r.id } else { '' }
    if (-not $runId) { return $null }
    for ($i = 0; $i -lt 50; $i++) {
      Start-Sleep -Milliseconds 500
      $st = Invoke-RestMethod -Uri "$base/runs/$runId" -Method Get -TimeoutSec 10
      if ($st.status -eq 'succeeded') { break }
      if ($st.status -in @('failed', 'canceled', 'timeout')) { return $null }
    }
    return (Invoke-RestMethod -Uri "$base/plugin/$plugin/ui/theme.json" -Method Get -TimeoutSec 8)
  } catch {
    Write-Host ("   WARNING: could not reset the palette: {0}" -f $_.Exception.Message)
    return $null
  }
}
