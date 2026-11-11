# Publish the debug APK and Windows desktop installers as a GitHub pre-release.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/publish-release.ps1
# Requires the repository to be a fork the current git credentials can write to.
# The token is read from git's credential helper and is never written to disk.

$ErrorActionPreference = 'Stop'

$owner = 'Raghavendra-varma-au-cse'
$repo = 'pdf-text-to-speech-reader'
$tag = 'v1.0.0-readaloud'
$name = 'ReadAloud 1.0.0 - standalone mobile + desktop'
$body = 'Debug APK and Windows desktop installers for the contributor branch. See the upstream PR for details.'

$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$passwordLine = $cred | Where-Object { $_ -like 'password=*' }
if (-not $passwordLine) { throw 'No GitHub credential found in the git credential helper.' }
$token = $passwordLine.Substring(9)

$headers = @{
  Authorization = "token $token"
  'User-Agent' = 'readaloud-contributor'
  Accept = 'application/vnd.github+json'
}

$releasePayload = @{
  tag_name = $tag
  target_commitish = 'main'
  name = $name
  prerelease = $true
  body = $body
} | ConvertTo-Json

$release = Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.github.com/repos/$owner/$repo/releases" `
  -Headers $headers `
  -Body $releasePayload `
  -ContentType 'application/json' `
  -TimeoutSec 60

Write-Output "RELEASE=$($release.html_url)"
$uploadBase = $release.upload_url.Split('{')[0]

$assets = @(
  @{ Path = 'android/app/build/outputs/apk/debug/app-debug.apk'; Name = 'ReadAloud-debug.apk'; Type = 'application/vnd.android.package-archive' },
  @{ Path = 'src-tauri/target/release/bundle/nsis/ReadAloud_1.0.0_x64-setup.exe'; Name = 'ReadAloud_1.0.0_x64-setup.exe'; Type = 'application/octet-stream' },
  @{ Path = 'src-tauri/target/release/bundle/msi/ReadAloud_1.0.0_x64_en-US.msi'; Name = 'ReadAloud_1.0.0_x64_en-US.msi'; Type = 'application/octet-stream' }
)

foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset.Path)) {
    Write-Warning "Missing asset: $($asset.Path)"
    continue
  }
  $assetHeaders = @{
    Authorization = "token $token"
    'User-Agent' = 'readaloud-contributor'
    'Content-Type' = $asset.Type
  }
  $uploadUri = $uploadBase + '?name=' + [System.Uri]::EscapeDataString($asset.Name)
  $uploaded = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $assetHeaders -InFile $asset.Path -TimeoutSec 300
  Write-Output "ASSET=$($uploaded.browser_download_url)"
}
