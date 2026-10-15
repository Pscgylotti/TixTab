param([switch]$Unregister, [string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$componentName = 'TixTab.WindowsAI.Ocr'
if ($Unregister) {
  Get-AppxPackage -Name $componentName | Remove-AppxPackage
  exit
}
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $PSScriptRoot '../.cache/windows-ai-ocr/runtime' }
$componentRoot = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$componentManifest = Join-Path $componentRoot 'AppxManifest.xml'
$identityPackage = Join-Path $componentRoot 'TixTab.WindowsAI.Ocr.identity.msix'
if (Test-Path -LiteralPath $identityPackage) {
  # Production: signed identity package, normal current-user installation.
  Add-AppxPackage -Path $identityPackage -ExternalLocation $componentRoot
} else {
  # Development only: respect existing OS policy; never enable developer mode
  # or install a trust certificate in order to bypass a deployment failure.
  $development = Get-ItemProperty 'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/AppModelUnlock' -ErrorAction SilentlyContinue
  if ($development.AllowDevelopmentWithoutDevLicense -ne 1) {
    throw 'A signed Windows AI OCR identity package is required. Loose development registration is unavailable under the current Windows policy.'
  }
  Add-AppxPackage -Register $componentManifest -ExternalLocation $componentRoot
}
