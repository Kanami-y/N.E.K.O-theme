# e2e-panel-flow.ps1 -- drive the theme plugin the way its own panel does, then check the
# app-side loader can see the result.
#
#   powershell -File e2e-panel-flow.ps1 [-Color "#7c3aed"] [-Reset]
#
# Sequence (copied from wechat_integration/static/script.js, which the panel also follows):
#   GET  /security/csrf-token           -> csrf_token
#   POST /runs  {plugin_id, entry_id, args}  -> run_id
#   GET  /runs/{id}  (poll)             -> status
#   GET  /runs/{id}/export              -> result items
# then read back /plugin/neko_theme_studio/ui/theme.json (what neko-theme-studio.js polls).
[CmdletBinding()]
param(
  [string]$Color = '#7c3aed',
  [string]$PluginId = 'neko_theme_studio',
  [string]$Base = 'http://127.0.0.1:48916',
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'

function Get-Text($url) {
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
  return [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}
function Post-Json($url, $obj, $headers) {
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $args = @{ Uri = $url; Method = 'POST'; Body = $bytes; ContentType = 'application/json; charset=utf-8'
             UseBasicParsing = $true; TimeoutSec = 30 }
  if ($headers) { $args.Headers = $headers }
  $r = Invoke-WebRequest @args
  return [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}

$csrf = (Get-Text "$Base/security/csrf-token" | ConvertFrom-Json).csrf_token
Write-Host ("csrf token: " + $csrf.Substring(0, [Math]::Min(16, $csrf.Length)) + '...')

$entry = if ($Reset) { 'reset_theme' } else { 'apply_theme' }
$body = if ($Reset) { @{ plugin_id = $PluginId; entry_id = $entry; args = @{} } }
        else { @{ plugin_id = $PluginId; entry_id = $entry
                   args = @{ name = 'e2e ' + $Color; enabled = $true
                             vars = @{ '--nts-user-bubble-bg' = $Color; '--nts-radius' = '18px'
                                       '--nts-chat-blur' = 'blur(24px)'; '--nts-accent' = $Color } } } }

$runRaw = Post-Json "$Base/runs" $body @{ 'X-CSRF-Token' = $csrf }
Write-Host ("POST /runs -> " + $runRaw)
$runId = ($runRaw | ConvertFrom-Json).run_id
if (-not $runId) { $runId = ($runRaw | ConvertFrom-Json).id }
if (-not $runId) { throw 'no run id returned' }

$status = ''
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 500
  $rec = (Get-Text "$Base/runs/$runId") | ConvertFrom-Json
  $status = $rec.status
  if ($status -in @('succeeded', 'failed', 'canceled', 'timeout')) { break }
}
Write-Host ("run $runId status = $status")

if ($status -ne 'succeeded') {
  Write-Host '--- run record ---'
  Write-Host (($rec | ConvertTo-Json -Depth 12))
  throw "entry did not succeed: $status"
}

$exp = (Get-Text "$Base/runs/$runId/export") | ConvertFrom-Json
$item = $null
foreach ($it in $exp.items) { if ($it.type -eq 'json' -and $it.json) { $item = $it; break } }
if (-not $item) { $item = $exp.items[0] }
$data = if ($item.json) { $item.json } else { $item.data }
while ($data -and ($data.PSObject.Properties.Name -contains 'data') -and
       (($data.PSObject.Properties.Name -contains 'success') -or ($data.PSObject.Properties.Name -contains 'error'))) {
  $data = $data.data
}
if ($data.error) { throw ("entry returned error: " + ($data | ConvertTo-Json -Depth 8)) }
Write-Host '--- entry result ---'
Write-Host (($data | ConvertTo-Json -Depth 8 -Compress))

Write-Host ''
Write-Host '--- what the app-side loader will see (/plugin/<id>/ui/theme.json) ---'
$tj = Get-Text "$Base/plugin/$PluginId/ui/theme.json"
Write-Host $tj
$parsed = $tj | ConvertFrom-Json
Write-Host ''
Write-Host ("updated_at={0} enabled={1} vars={2} dark_vars={3}" -f $parsed.updated_at, $parsed.enabled,
            @($parsed.vars.PSObject.Properties).Count, @($parsed.dark_vars.PSObject.Properties).Count)
if (-not $Reset) {
  if ($parsed.vars.'--nts-user-bubble-bg' -eq $Color) { Write-Host ('PASS: --nts-user-bubble-bg == ' + $Color) }
  else { Write-Host ('FAIL: --nts-user-bubble-bg = ' + $parsed.vars.'--nts-user-bubble-bg') }
}
