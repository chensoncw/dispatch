<#
  push.ps1 - put local files into the dispatch repo through GitHub's API.

  This replaces driving the GitHub website by hand. On 2026-09-24 the web editor
  swallowed pastes silently and the retries tripped GitHub's automated-activity
  protection, which blocked writing to the repo for the rest of the session. The
  API is the supported path for this and involves no clicking.

  The token is read from a file and handed straight to GitHub. It is never
  printed, never echoed, and never passed on a command line where it could land
  in a transcript or a screenshot.

    .\push.ps1 -Files content\2026-09-29-heat.json -Message "content: heat card"
    .\push.ps1 -Files (Get-ChildItem content\2026-*.json) -Message "content: week of Sep 29"

  Each file is committed separately, because GitHub's contents API writes one
  path per call. They are spaced out deliberately - see the note on pacing below.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] $Files,
  [Parameter(Mandatory = $true)] [string] $Message,
  [string] $Repo       = 'chensoncw/dispatch',
  [string] $Branch     = 'main',
  [string] $TokenFile  = 'G:\My Drive\Claude Workspace\00_MASTER_DOCS\KEYS\PASTE-GITHUB-TOKEN-HERE.txt',
  [string] $LocalRoot  = 'G:\My Drive\Claude Workspace\01_MARKETING\Social Posts\Dispatch',
  [int]    $PauseMs    = 1500
)

$ErrorActionPreference = 'Stop'

# --- the token -------------------------------------------------------------
if (-not (Test-Path $TokenFile)) {
  Write-Error "No token file at $TokenFile. See the README beside it."; exit 1
}
$token = ([IO.File]::ReadAllText($TokenFile)).Trim()
if (-not $token) {
  Write-Error "The token file is empty. Paste the token into $TokenFile, then run this again."; exit 1
}
if ($token -notmatch '^(github_pat_|ghp_)') {
  Write-Error "That does not look like a GitHub token. It should begin github_pat_ or ghp_."; exit 1
}

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'dispatch-push'
}

# --- who are we, and can we write ------------------------------------------
try {
  $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers
  Write-Host "push: authenticated as $($me.login)"
} catch {
  Write-Error "GitHub refused the token: $($_.Exception.Message)"; exit 1
}

# --- one file at a time ----------------------------------------------------
$ok = 0; $failed = @()
$list = @($Files) | ForEach-Object { if ($_ -is [IO.FileInfo]) { $_.FullName } else { $_ } }

foreach ($f in $list) {
  $full = if ([IO.Path]::IsPathRooted($f)) { $f } else { Join-Path $LocalRoot $f }
  if (-not (Test-Path $full)) { $failed += "$f (not found locally)"; continue }

  # repo-relative path, forward slashes - GitHub does not take backslashes
  $rel = $full.Substring($LocalRoot.Length).TrimStart('\','/') -replace '\\','/'
  $uri = "https://api.github.com/repos/$Repo/contents/$rel"

  # Bytes, not text. Reading as a string would run the content through
  # PowerShell's encoding and mangle every dash and bullet on the way out.
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($full))

  # An existing file needs its current sha or GitHub rejects the write.
  $sha = $null
  try {
    $cur = Invoke-RestMethod -Uri "$($uri)?ref=$Branch" -Headers $headers
    $sha = $cur.sha
  } catch { }   # 404 simply means it is a new file

  $body = @{ message = $Message; content = $b64; branch = $Branch }
  if ($sha) { $body.sha = $sha }

  try {
    $res = Invoke-RestMethod -Uri $uri -Headers $headers -Method PUT `
             -Body ($body | ConvertTo-Json -Compress) -ContentType 'application/json'
    $verb = if ($sha) { 'updated' } else { 'created' }
    Write-Host ("push: {0,-9} {1}  {2}" -f $verb, $rel, $res.commit.sha.Substring(0,7))
    $ok++
  } catch {
    $failed += "$rel - $($_.Exception.Message)"
  }

  # Deliberate pacing. Writes fired back to back are what triggered GitHub's
  # abuse protection before. A second and a half costs nothing and avoids it.
  Start-Sleep -Milliseconds $PauseMs
}

Write-Host ""
Write-Host "push: $ok of $($list.Count) committed"
if ($failed) {
  Write-Host "push: FAILED"
  $failed | ForEach-Object { Write-Host "  $_" }
  exit 1
}
