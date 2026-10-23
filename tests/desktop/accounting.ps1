# Test accounting for the Windows lifecycle receipt. A step's exit code cannot show that every
# case ran, because skipped and pending cases exit 0. Each step therefore writes a
# machine-readable report, and a scenario passes only when every counter the report needs exists
# and is a non-negative integer, and the counters show no failed, skipped, pending, todo,
# unexpected or flaky case, no failed or pending suite, and no global error. A missing, null,
# non-integer, negative or non-boolean field is an error, never a zero or a pass.

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

function Get-AccountingFlag($Object, [string]$Name, [string]$Context) {
    if ($null -eq $Object) { throw "$Context has no object for $Name" }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { throw "$Context is missing $Name" }
    if (-not ($property.Value -is [bool])) { throw "$Context has a non-boolean $Name" }
    return [bool]$property.Value
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

# Vitest JSON reporter: exit 0 only when at least one case passed, no case failed, is pending
# (skipped) or is todo, no suite failed or is pending, and the run reports success. Suite failures
# and unhandled errors can leave every case passed, so they are checked separately. Every case and
# every suite must also fall into one reported bucket, so a case or suite that no bucket counts
# cannot pass alongside the others.
function Get-VitestAccountingExitCode([string]$ReportPath) {
    $report = Read-AccountingReport $ReportPath
    $total = Get-AccountingCounter $report 'numTotalTests' 'Vitest report'
    $passed = Get-AccountingCounter $report 'numPassedTests' 'Vitest report'
    $failed = Get-AccountingCounter $report 'numFailedTests' 'Vitest report'
    $pending = Get-AccountingCounter $report 'numPendingTests' 'Vitest report'
    $todo = Get-AccountingCounter $report 'numTodoTests' 'Vitest report'
    $totalSuites = Get-AccountingCounter $report 'numTotalTestSuites' 'Vitest report'
    $passedSuites = Get-AccountingCounter $report 'numPassedTestSuites' 'Vitest report'
    $failedSuites = Get-AccountingCounter $report 'numFailedTestSuites' 'Vitest report'
    $pendingSuites = Get-AccountingCounter $report 'numPendingTestSuites' 'Vitest report'
    $success = Get-AccountingFlag $report 'success' 'Vitest report'
    $casesAccounted = $total -eq ($passed + $failed + $pending + $todo)
    $suitesAccounted = $totalSuites -eq ($passedSuites + $failedSuites + $pendingSuites)
    if ($passed -gt 0 -and $casesAccounted -and $failed -eq 0 -and $pending -eq 0 -and $todo -eq 0 -and $suitesAccounted -and $failedSuites -eq 0 -and $pendingSuites -eq 0 -and $success) {
        return 0
    }
    return 1
}

# Playwright JSON reporter: exit 0 only when at least one test ran, none was unexpected, skipped or
# flaky, and the run reports no global error. A failing hook outside a test lands in the top-level
# error list, so the list must be present and empty.
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
    $errorsProperty = $report.PSObject.Properties['errors']
    if ($null -eq $errorsProperty -or $null -eq $errorsProperty.Value) {
        throw 'Playwright report has no errors list'
    }
    $globalErrors = @($errorsProperty.Value).Count
    if ($expected -gt 0 -and $unexpected -eq 0 -and $skipped -eq 0 -and $flaky -eq 0 -and $globalErrors -eq 0) {
        return 0
    }
    return 1
}
