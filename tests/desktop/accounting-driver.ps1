# Command-line driver for the accounting functions, used by accounting.test.mjs.
# Exit codes: 0 pass, 1 scenario failed (a case was skipped, pending, failed, todo, unexpected or
# flaky, a suite failed or was pending, a global error was reported, or nothing ran), 2 the report
# is missing, malformed or lacks a required field.
param(
    [Parameter(Mandatory = $true)][ValidateSet('vitest', 'playwright')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Report
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'accounting.ps1')

try {
    if ($Kind -eq 'vitest') {
        $code = Get-VitestAccountingExitCode $Report
    } else {
        $code = Get-PlaywrightAccountingExitCode $Report
    }
    exit $code
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
