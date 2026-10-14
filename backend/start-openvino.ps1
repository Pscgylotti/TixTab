param([switch]$Install, [switch]$Ocr)
$ErrorActionPreference='Stop'
$serviceRoot=$PSScriptRoot
$runtimeRoot=Join-Path $env:USERPROFILE '.surfacetab\openvino-runtime'
$nativePython=Join-Path $runtimeRoot 'Scripts\python.exe'
if(-not (Test-Path -LiteralPath $nativePython)) {
  if(-not $Install) { throw 'Run .\start-openvino.ps1 -Install once to prepare the optional local runtime.' }
  py -3.10 -m venv $runtimeRoot
  if($LASTEXITCODE -ne 0) { throw 'Python 3.10 x64 is required for this pinned runtime.' }
}
if($Install) {
  $requirements=if($Ocr) { 'requirements-ocr.txt' } else { 'requirements-openvino.txt' }
  & $nativePython (Join-Path $serviceRoot 'install_dependencies.py') (Join-Path $serviceRoot $requirements)
  if($LASTEXITCODE -ne 0) { throw 'OpenVINO runtime installation failed.' }
}
& $nativePython -m uvicorn openvino_app:app --app-dir $serviceRoot --host 127.0.0.1 --port 8766
