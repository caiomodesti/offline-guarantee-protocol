param(
  [string]$VoiceName = "Microsoft Maria Desktop"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$cuePath = Join-Path $projectRoot "data\cues.json"
$voiceDir = Join-Path $projectRoot "public\audio\voice"
New-Item -ItemType Directory -Force -Path $voiceDir | Out-Null

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$available = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
if ($available -notcontains $VoiceName) {
  throw "Voz pt-BR não encontrada: $VoiceName. Disponíveis: $($available -join ', ')"
}

$synth.SelectVoice($VoiceName)
$synth.Rate = 0
$synth.Volume = 100
$cues = Get-Content -Raw $cuePath | ConvertFrom-Json

foreach ($cue in $cues) {
  $target = Join-Path $voiceDir ("cue-{0}.wav" -f $cue.id)
  $synth.SetOutputToWaveFile($target)
  $synth.Speak([string]$cue.text)
  $synth.SetOutputToNull()
}

$synth.Dispose()
Write-Output "Narração gerada em $voiceDir com $VoiceName"
