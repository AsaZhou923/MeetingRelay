function Initialize-MeetingRelayPowerShell {
    [CmdletBinding()]
    param([string[]]$RequiredModules = @())

    $builtInModuleRoot = [IO.Path]::Combine($PSHOME, "Modules")
    if (Test-Path -LiteralPath $builtInModuleRoot -PathType Container) {
        $modulePaths = @(([string]$env:PSModulePath).Split(
            [IO.Path]::PathSeparator,
            [StringSplitOptions]::RemoveEmptyEntries
        ))
        if (-not ($modulePaths -contains $builtInModuleRoot)) {
            $env:PSModulePath = if ([string]::IsNullOrWhiteSpace($env:PSModulePath)) {
                $builtInModuleRoot
            }
            else {
                "$builtInModuleRoot$([IO.Path]::PathSeparator)$env:PSModulePath"
            }
        }
    }

    foreach ($module in $RequiredModules) {
        Import-Module -Name $module -ErrorAction Stop
    }
}
