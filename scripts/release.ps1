# Publishes a new version of Recorte on GitHub Releases, where installed apps look for updates.
#
#   .\scripts\release.ps1 -Version 0.2.0 -Notes "O que mudou nesta versão"
#
# Needs: gh logged in (gh auth login) and the signing key at ~/.tauri/recorte.key.
param(
  [Parameter(Mandatory)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string] $Version,
  [string] $Notes = "",
  [string] $Repo = "flackback/recorte",
  [switch] $SkipBuild
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$key = Join-Path $HOME ".tauri\recorte.key"
if (-not (Test-Path $key)) { throw "Chave de assinatura não encontrada: $key" }

# Same version in the three places that carry it.
$utf8 = New-Object System.Text.UTF8Encoding $false
$files = @{
  (Join-Path $root "package.json") = '"version": "[^"]+"', "`"version`": `"$Version`""
  (Join-Path $root "src-tauri\tauri.conf.json") = '"version": "[^"]+"', "`"version`": `"$Version`""
  (Join-Path $root "src-tauri\Cargo.toml") = '(?m)^version = "[^"]+"', "version = `"$Version`""
}
foreach ($file in $files.Keys) {
  $pattern, $replacement = $files[$file]
  $text = [IO.File]::ReadAllText($file)
  $regex = New-Object System.Text.RegularExpressions.Regex $pattern
  [IO.File]::WriteAllText($file, $regex.Replace($text, $replacement, 1), $utf8)
}

if (-not $SkipBuild) {
  $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($key)
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
  Push-Location $root
  try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "A compilação falhou." }
  } finally {
    Pop-Location
  }
}

$bundle = Join-Path $root "src-tauri\target\release\bundle\nsis"
$installer = Get-ChildItem $bundle -Filter "Recorte_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $installer) { throw "Instalador da versão $Version não encontrado em $bundle" }
$signature = [IO.File]::ReadAllText("$($installer.FullName).sig").Trim()

# The file installed apps read to learn about the new version.
$latest = [ordered]@{
  version  = $Version
  notes    = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{
    "windows-x86_64" = @{
      signature = $signature
      url       = "https://github.com/$Repo/releases/download/v$Version/$($installer.Name)"
    }
  }
}
$latestPath = Join-Path $bundle "latest.json"
[IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 5), $utf8)

$body = if ($Notes) { $Notes } else { "Recorte $Version" }
gh release create "v$Version" $installer.FullName $latestPath --repo $Repo --title "Recorte $Version" --notes $body
if ($LASTEXITCODE -ne 0) { throw "A publicação no GitHub falhou." }
Write-Host "Versão $Version publicada. Os apps instalados vão encontrar a atualização."
