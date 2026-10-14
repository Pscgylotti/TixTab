param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Choose a new sample directory; existing inputs are never overwritten.' }
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $items = @(
    @{ file = 'en.wav'; language = 'en-US'; text = 'The library opens at nine in the morning and closes at five in the afternoon.' },
    @{ file = 'zh.wav'; language = 'zh-CN'; text = (-join [char[]]@(0x56fe,0x4e66,0x9986,0x4e0a,0x5348,0x4e5d,0x70b9,0x5f00,0x653e,0xff0c,0x4e0b,0x5348,0x4e94,0x70b9,0x5173,0x95ed,0x3002)) }
  )
  foreach ($item in $items) {
    $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $item.language } | Select-Object -First 1
    if ($null -eq $voice) { throw ('No installed desktop voice for ' + $item.language) }
    $item.voice = $voice.VoiceInfo.Name
  }
  New-Item -ItemType Directory -Path $destination | Out-Null
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  foreach ($item in $items) {
    $file = Join-Path $destination $item.file
    $synth.SelectVoice($item.voice)
    $synth.Rate = 0
    $synth.SetOutputToWaveFile($file, $format)
    $synth.Speak($item.text)
    $synth.SetOutputToNull()
    $item.sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $item.bytes = (Get-Item -LiteralPath $file).Length
  }
  $manifest = @{ schema = 1; source = 'Local Windows desktop TTS, fixed project-authored test sentences; no microphone recording.'; samples = $items }
  [IO.File]::WriteAllText((Join-Path $destination 'samples.json'), ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  $manifest | ConvertTo-Json -Depth 5
} finally { $synth.Dispose() }
