# Test accounting for the Windows lifecycle receipt. A step's exit code cannot show that every
# case ran, because skipped and pending cases exit 0. Each step therefore writes a
# machine-readable report, and a scenario passes only when every counter the report needs exists
# and is a non-negative integer, and the counters show no failed, skipped, pending, todo,
# unexpected or flaky case. A missing, null, non-integer or negative counter is an error,
# never a zero.

function Get-AccountingCounter($Object, [string]$Name, [string]$Context) {
    if ($null -eq $Object) { throw "$Context has no object for $Name" }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { throw "$Context is missing $Name" }
    $value = $property.Value
    if ($null -eq $value) { throw "$Context has a null $Name" }
    if (-not ($value -is [int] -or $value -is [long])) { throw "$Context has a non-integer $Name" }
    if ([long]$value -lt 0) { throw "$Context has a negative $Name" }
    return [long]$value
}

function Read-AccountingReport([string]$ReportPath) {
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        throw "Accounting report is missing: $ReportPath"
    }
    try {
        return Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Accounting report is not valid JSON: $ReportPath"
    }
}

# Vitest JSON reporter: exit 0 only when at least one case passed and no case failed, is pending
# (skipped), or is todo.
function Get-VitestAccountingExitCode([string]$ReportPath) {
    $report = Read-AccountingReport $ReportPath
    $passed = Get-AccountingCounter $report 'numPassedTests' 'Vitest report'
    $failed = Get-AccountingCounter $report 'numFailedTests' 'Vitest report'
    $pending = Get-AccountingCounter $report 'numPendingTests' 'Vitest report'
    $todo = Get-AccountingCounter $report 'numTodoTests' 'Vitest report'
    if ($passed -gt 0 -and $failed -eq 0 -and $pending -eq 0 -and $todo -eq 0) { return 0 }
    return 1
}

# Playwright JSON reporter: exit 0 only when at least one test ran and none was unexpected,
# skipped, or flaky.
function Get-PlaywrightAccountingExitCode([string]$ReportPath) {
    $report = Read-AccountingReport $ReportPath
    $statsProperty = $report.PSObject.Properties['stats']
    if ($null -eq $statsProperty -or $null -eq $statsProperty.Value) {
        throw 'Playwright report has no stats object'
    }
    $stats = $statsProperty.Value
    $expected = Get-AccountingCounter $stats 'expected' 'Playwright stats'
    $unexpected = Get-AccountingCounter $stats 'unexpected' 'Playwright stats'
    $skipped = Get-AccountingCounter $stats 'skipped' 'Playwright stats'
    $flaky = Get-AccountingCounter $stats 'flaky' 'Playwright stats'
    if ($expected -gt 0 -and $unexpected -eq 0 -and $skipped -eq 0 -and $flaky -eq 0) { return 0 }
    return 1
}
