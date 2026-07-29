[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'MeetingRelay\runtimes\cohere-transcribe-03-2026')
)

$ErrorActionPreference = 'Stop'
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
& $hf download CohereLabs/cohere-transcribe-03-2026 --revision b1eacc2686a3d08ceaae5f24a88b1d519620bc09

& $venvPython -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))"
Write-Output "MeetingRelay Cohere runtime ready: $venvPython"
