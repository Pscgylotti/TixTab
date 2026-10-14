param([switch]$Install)
$ErrorActionPreference='Stop'
$runtimeRoot=Join-Path $env:USERPROFILE '.surfacetab\asr-runtime'
$nativePython=Join-Path $runtimeRoot 'Scripts\python.exe'
if(-not (Test-Path -LiteralPath $nativePython)) {
  if(-not $Install) { throw 'Run start-asr.ps1 -Install once. Python 3.10 x64 is required.' }
  py -3.10 -m venv $runtimeRoot
  if($LASTEXITCODE -ne 0) { throw 'Python 3.10 x64 is required.' }
}
if($Install) {
  & $nativePython (Join-Path $PSScriptRoot 'install_dependencies.py') (Join-Path $PSScriptRoot 'requirements-asr.txt')
  if($LASTEXITCODE -ne 0) { throw 'Local speech runtime installation failed.' }
}
& $nativePython -c 'import openvino as ov,openvino_genai,sherpa_onnx,sounddevice,soxr,webrtcvad; print(ov.Core().available_devices)'
