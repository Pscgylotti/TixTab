param([switch]$Unregister, [string]$RuntimeDirectory)
# Use the same registration implementation as the desktop application.
& (Join-Path $PSScriptRoot '../electron/windows-ai-register.ps1') @PSBoundParameters
