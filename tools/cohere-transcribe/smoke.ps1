[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'MeetingRelay\runtimes\cohere-transcribe-03-2026'),
    [string]$ModelDir = (Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--CohereLabs--cohere-transcribe-03-2026\snapshots\b1eacc2686a3d08ceaae5f24a88b1d519620bc09'),
    [string]$OutputRoot = 'target/mvp/acceptance/cohere-smoke',
    [double]$MaxCer = 0.10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$python = Join-Path $RuntimeRoot 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Cohere runtime is missing: $python"
}
if (-not (Test-Path -LiteralPath (Join-Path $ModelDir 'model.safetensors') -PathType Leaf)) {
    throw "Cohere model is missing: $ModelDir"
}

$resolvedOutputRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputRoot))
New-Item -ItemType Directory -Path $resolvedOutputRoot -Force | Out-Null

Add-Type -AssemblyName System.Speech
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)
function ConvertFrom-Base64Utf8 {
    param([Parameter(Mandatory = $true)][string]$Value)
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}
$cases = @(
    @{ Language = 'zh'; Voice = 'Microsoft Huihui Desktop'; Text = (ConvertFrom-Base64Utf8 '5LuK5aSp5LiL5Y2I5LiJ54K577yM5oiR5Lus56Gu6K6k5pys5Zyw6K+t6Z+z6K+G5Yir5qih5Z6L6L+Q6KGM5q2j5bi444CC') },
    @{ Language = 'ja'; Voice = 'Microsoft Haruka Desktop'; Text = (ConvertFrom-Base64Utf8 '5pys5pel44Gu5Lya6K2w44Gn44Gv44CB6Z+z5aOw6KqN6K2Y44Oi44OH44Or44Gu5YuV5L2c44KS56K66KqN44GX44G+44GZ44CC') },
    @{ Language = 'en'; Voice = 'Microsoft Zira Desktop'; Text = 'Today we verify that the local speech recognition model is working correctly.' }
)

$synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $installedVoices = @($synthesizer.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
    foreach ($case in $cases) {
        if ($installedVoices -notcontains $case.Voice) {
            throw "Required Windows voice is missing: $($case.Voice)"
        }
        $audioPath = Join-Path $resolvedOutputRoot "$($case.Language).wav"
        $synthesizer.SelectVoice($case.Voice)
        $synthesizer.SetOutputToWaveFile($audioPath, $format)
        $synthesizer.Speak($case.Text)
        $synthesizer.SetOutputToNull()
    }
}
finally {
    $synthesizer.Dispose()
}

$reportPath = Join-Path $resolvedOutputRoot 'results.json'
& $python (Join-Path $PSScriptRoot 'smoke.py') `
    --model-dir $ModelDir `
    --audio-dir $resolvedOutputRoot `
    --output $reportPath `
    --max-cer $MaxCer
if ($LASTEXITCODE -ne 0) {
    throw "Cohere three-language smoke failed with exit code $LASTEXITCODE"
}

Write-Output "MEETINGRELAY_COHERE_SMOKE_PASS report=$reportPath"
