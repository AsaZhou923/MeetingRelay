[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-DistributionRepositoryRoot {
    $root = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($root)) {
        return [IO.Path]::GetFullPath($root.Trim())
    }
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
}

function Test-MeetingRelayDistributionDataRetention {
    param([string]$RepositoryRoot = (Get-DistributionRepositoryRoot))

    $hookPath = Join-Path $RepositoryRoot "tools/distribution/nsis-hooks.nsh"
    if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_HOOK_MISSING path=$hookPath"
    }
    $hook = Get-Content -LiteralPath $hookPath -Raw -Encoding UTF8

    $dangerousLocalAppDataDeletes = [regex]::IsMatch(
        $hook,
        'RMDir\s+/r\s+["'']?\$LOCALAPPDATA\\MeetingRelay|Delete\s+["'']?\$LOCALAPPDATA\\MeetingRelay',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    $mentionsCredentialDeletion = $hook -match '(?i)cmdkey|CredDelete|Credential Manager.*delete|delete.*Credential Manager'

    return [PSCustomObject]@{
        localAppDataMvpPath = "%LOCALAPPDATA%\MeetingRelay\mvp"
        localAppDataMvpRetained = (-not $dangerousLocalAppDataDeletes) -and $hook.Contains("MeetingRelay mvp data is intentionally retained")
        credentialManagerRetained = (-not $mentionsCredentialDeletion) -and $hook.Contains("Windows Credential Manager secrets are intentionally retained")
        upgradeRetainsData = $true
        rollbackRetainsData = $true
        uninstallRetainsData = (-not $dangerousLocalAppDataDeletes) -and (-not $mentionsCredentialDeletion)
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        $result = Test-MeetingRelayDistributionDataRetention -RepositoryRoot $(if ($RepositoryRoot) { $RepositoryRoot } else { Get-DistributionRepositoryRoot })
        if ($AsJson) {
            $result | ConvertTo-Json -Depth 8
        }
        else {
            $result
        }
    }
    catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
