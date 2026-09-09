[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'MeetingRelay\runtimes\cohere-transcribe-03-2026'),
    [string]$ModelDir = (Join-Path $PSScriptRoot '..\..\target\cohere-transcribe\models\cohere-transcribe-03-2026\b1eacc2686a3d08ceaae5f24a88b1d519620bc09')
)

$ErrorActionPreference = 'Stop'
$resolvedModelDir = [IO.Path]::GetFullPath($ModelDir)
$python = (Get-Command python.exe -ErrorAction Stop).Source
$venvPython = Join-Path $RuntimeRoot 'Scripts\python.exe'
$hf = Join-Path $RuntimeRoot 'Scripts\hf.exe'
$sourceWorker = Join-Path $PSScriptRoot 'worker.py'
$installedWorker = Join-Path $RuntimeRoot 'worker.py'

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    & $python -m venv $RuntimeRoot
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
& $venvPython -m pip install transformers==5.4.0 huggingface_hub==1.25.1 sentencepiece==0.2.2 protobuf==7.35.1
Copy-Item -LiteralPath $sourceWorker -Destination $installedWorker -Force
& $hf auth whoami
& $hf download CohereLabs/cohere-transcribe-03-2026 `
    --revision b1eacc2686a3d08ceaae5f24a88b1d519620bc09 `
    --local-dir $resolvedModelDir
if ($LASTEXITCODE -ne 0) {
    throw "Cohere model download failed with exit code $LASTEXITCODE"
}

$modelFile = Join-Path $resolvedModelDir 'model.safetensors'
if (-not (Test-Path -LiteralPath $modelFile -PathType Leaf)) {
    throw "Cohere model is missing after download: $modelFile"
}
$modelItem = Get-Item -LiteralPath $modelFile
$modelSha256 = (Get-FileHash -LiteralPath $modelFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($modelItem.Length -ne 4131862976 -or $modelSha256 -ne '987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a') {
    throw "Cohere model verification failed: $modelFile"
}
[Environment]::SetEnvironmentVariable('MEETINGRELAY_COHERE_MODEL_DIR', $resolvedModelDir, 'User')

& $venvPython -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))"
Write-Output "MeetingRelay Cohere runtime ready: $venvPython"
Write-Output "MeetingRelay Cohere model ready: $resolvedModelDir"
Write-Output 'Restart MeetingRelay to use the updated model directory.'
