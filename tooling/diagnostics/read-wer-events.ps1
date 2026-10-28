<#
.SYNOPSIS
Reads the Windows Error Reporting crash events for joy-media.exe in a time window, with redacted fields (plan section 10d, G1 step 6).

.DESCRIPTION
Read-only. It prints one JSON line per crash event: the time, the exception code, and the faulting module's file name. It never
prints a path, a message, or a user name. The window is given in UTC, so it matches the run window the owner records.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/read-wer-events.ps1 -Start '2026-10-28T10:00:00Z' -End '2026-10-28T10:05:00Z'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][datetime]$Start,
    [Parameter(Mandatory = $true)][datetime]$End
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $events = @(Get-WinEvent -FilterHashtable @{
            LogName = 'Application'
            ProviderName = 'Application Error'
            StartTime = $Start.ToLocalTime()
            EndTime = $End.ToLocalTime()
        } -ErrorAction Stop)
}
catch {
    # "No events matched" is an empty answer. Any other failure stops the script: a failed query is never a zero.
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $events = @() } else { throw }
}

foreach ($event in $events) {
    $message = [string]$event.Message
    if ($message -notmatch 'joy-media\.exe') { continue }
    $code = 'unknown'
    if ($message -match 'Exception code:\s*0x([0-9a-fA-F]+)') {
        $value = [Convert]::ToInt64($Matches[1], 16) -band 0xFFFFFFFFL
        $code = '0x{0:X8}' -f [uint32]$value
    }
    $module = 'unknown'
    if ($message -match 'Faulting module name:\s*([^\s,\\/]+)') { $module = $Matches[1] }
    [pscustomobject]@{
        time = $event.TimeCreated.ToUniversalTime().ToString('o')
        exceptionCode = $code
        faultingModule = $module
    } | ConvertTo-Json -Compress
}
