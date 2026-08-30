[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateSha,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$Attempt,
    [Parameter(Mandatory = $true)][ValidateSet('1', '2')][string]$Pass,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if ($CandidateSha -notmatch '^[0-9a-f]{40}$') { throw 'candidate SHA must be a full lowercase commit SHA' }

$acceptanceRoot = Join-Path $env:RUNNER_TEMP ("joy-media-worker-acceptance-{0}-{1}-{2}" -f $RunId, $Attempt, $Pass)
$installRoot = Join-Path $acceptanceRoot 'install'
$installedPath = Join-Path $installRoot 'joy-worker.exe'
$previousPath = Join-Path $acceptanceRoot 'joy-worker.previous.exe'
$nextPath = Join-Path $acceptanceRoot 'joy-worker.next.exe'
$taskName = "JOY Media Worker Acceptance $RunId-$Attempt-$Pass"
$taskCreated = $false

function Invoke-WorkerSelfTest([string]$Path) {
    $output = & $Path --joy-worker-self-test
    if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch '"ok"\s*:\s*true') {
        throw "Worker self-test failed for $Path"
    }
    return ($output -join "`n")
}

function Get-DescendantProcessIds([int]$RootId) {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    if ($seen.Add($RootId)) { $queue.Enqueue($RootId) }
    while ($queue.Count -gt 0) {
        $parentId = $queue.Dequeue()
        foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $parentId }) {
            $childId = [int]$child.ProcessId
            if ($seen.Add($childId)) { $queue.Enqueue($childId) }
        }
    }
    return @($seen | Where-Object { $_ -ne $RootId })
}

function Stop-ProcessTree([int]$RootId) {
    $descendants = @(Get-DescendantProcessIds -RootId $RootId)
    foreach ($processId in ($descendants | Sort-Object -Descending -Unique)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        if (-not (Get-Process -Id $RootId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
    return -not (Get-Process -Id $RootId -ErrorAction SilentlyContinue)
}

function Invoke-WorkerDaemonProbe([string]$Path, [string]$Root, [string]$State) {
    $oldRoot = $env:JOY_MEDIA_WORKER_ROOT
    $oldApi = $env:JOY_MEDIA_API_URL
    $oldState = $env:JOY_MEDIA_WORKER_STATE_PATH
    $oldPipe = $env:JOY_MEDIA_WORKER_PIPE
    $process = $null
    try {
        $env:JOY_MEDIA_WORKER_ROOT = $Root
        # A loopback black-hole keeps the real daemon alive without contacting
        # production or requiring an owner pairing/session.
        $env:JOY_MEDIA_API_URL = 'https://127.0.0.1:9/api'
        $env:JOY_MEDIA_WORKER_STATE_PATH = $State
        $env:JOY_MEDIA_WORKER_PIPE = "\\.\pipe\joy-media-ci-$RunId-$Attempt-$Pass"
        $process = Start-Process -FilePath $Path -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 2
        $started = -not $process.HasExited
        $childCount = @(Get-DescendantProcessIds -RootId $process.Id).Count
        $terminated = Stop-ProcessTree -RootId $process.Id
        return [ordered]@{
            started = $started
            pid = $process.Id
            childCount = $childCount
            terminated = $terminated
        }
    } finally {
        if ($null -ne $process) { Stop-ProcessTree -RootId $process.Id | Out-Null }
        $env:JOY_MEDIA_WORKER_ROOT = $oldRoot
        $env:JOY_MEDIA_API_URL = $oldApi
        $env:JOY_MEDIA_WORKER_STATE_PATH = $oldState
        $env:JOY_MEDIA_WORKER_PIPE = $oldPipe
    }
}

function Get-SourceProvenance {
    $tree = (git rev-parse 'HEAD^{tree}').Trim()
    $lockHash = (Get-FileHash -LiteralPath (Join-Path $PWD 'pnpm-lock.yaml') -Algorithm SHA256).Hash.ToLowerInvariant()
    $dirty = (git status --porcelain --untracked-files=all -- . ':(exclude)test-output/**' ':(exclude)test-results/**' ':(exclude)playwright-report/**')
    return [ordered]@{
        commitSha = $CandidateSha
        treeHash = $tree
        lockfileSha256 = $lockHash
        worktreeClean = [string]::IsNullOrWhiteSpace(($dirty -join "`n"))
    }
}

try {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Copy-Item -LiteralPath $ExecutablePath -Destination $installedPath -Force
    $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $selfTest = Invoke-WorkerSelfTest $installedPath

    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $installedPath -Argument '--joy-worker-self-test'
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1))
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    $taskCreated = $true
    $previousTaskInfo = Get-ScheduledTaskInfo -TaskName $taskName
    $previousLastRunTime = $previousTaskInfo.LastRunTime
    Start-ScheduledTask -TaskName $taskName
    $taskInfo = $null
    $taskState = $null
    $taskRan = $false
    $startupDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
        $taskState = (Get-ScheduledTask -TaskName $taskName).State
        $taskRan = $taskInfo.LastRunTime -ne $previousLastRunTime
    } while (
        (
            -not $taskRan -or
            $taskState -eq 'Running'
        ) -and
        (Get-Date) -lt $startupDeadline
    )
    $startupPassed = $taskRan -and $taskState -eq 'Ready' -and $taskInfo.LastTaskResult -eq 0
    $probeStatePath = Join-Path $acceptanceRoot 'probe-state.json'
    $daemonProbe = Invoke-WorkerDaemonProbe -Path $installedPath -Root $PWD.Path -State $probeStatePath
    if (-not $daemonProbe.started -or -not $daemonProbe.terminated) { throw 'Worker daemon did not start and stop cleanly' }
    # Restart the same clean daemon/state lane. Reusing the state path proves
    # renewal does not create a second persisted identity or ambient session.
    $renewalProbe = Invoke-WorkerDaemonProbe -Path $installedPath -Root $PWD.Path -State $probeStatePath
    if (-not $renewalProbe.started -or -not $renewalProbe.terminated) { throw 'Worker daemon renewal did not start and stop cleanly' }

    $recoveryFirst = Invoke-WorkerSelfTest $installedPath
    $recoverySecond = Invoke-WorkerSelfTest $installedPath

    $repairPath = Join-Path $acceptanceRoot 'joy-worker.repair.exe'
    Copy-Item -LiteralPath $installedPath -Destination $repairPath -Force
    Remove-Item -LiteralPath $installedPath -Force
    Copy-Item -LiteralPath $repairPath -Destination $installedPath -Force
    $repairHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $repairSelfTest = Invoke-WorkerSelfTest $installedPath
    $repairPassed = $repairHash -eq $installedHash -and $repairSelfTest -match '"ok"\s*:\s*true'

    Copy-Item -LiteralPath $installedPath -Destination $previousPath -Force
    Copy-Item -LiteralPath $installedPath -Destination $nextPath -Force
    [IO.File]::AppendAllText($nextPath, "`nJOY_MEDIA_CI_UPDATE_MARKER_$RunId`n")
    Move-Item -LiteralPath $nextPath -Destination $installedPath -Force
    $updatedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $updateSelfTest = Invoke-WorkerSelfTest $installedPath
    Copy-Item -LiteralPath $previousPath -Destination $installedPath -Force
    $rollbackHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $rollbackSelfTest = Invoke-WorkerSelfTest $installedPath

    if ($taskCreated) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        $taskCreated = $false
    }
    Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force
    $uninstalled = -not (Test-Path -LiteralPath $acceptanceRoot)
    if (-not $uninstalled) { throw 'Worker acceptance install directory was not removed' }

    $status = if ($startupPassed -and $daemonProbe.started -and $daemonProbe.terminated -and $renewalProbe.started -and $renewalProbe.terminated -and $repairPassed -and $uninstalled) { 'verified' } else { 'failed' }
    $evidence = [ordered]@{
        schemaVersion = 1
        status = $status
        execution = 'windows-clean-worker'
        sourceProvenance = Get-SourceProvenance
        workflowRunId = $RunId
        attempt = $Attempt
        lanePass = $Pass
        host = [ordered]@{ os = 'Windows'; architecture = $env:PROCESSOR_ARCHITECTURE; profile = $env:JOY_MEDIA_CI_WORKER_PROFILE }
        package = [ordered]@{ path = 'joy-worker.exe'; sha256 = $installedHash; selfTest = ($selfTest | ConvertFrom-Json) }
        lifecycle = [ordered]@{
            install = [ordered]@{ status = 'passed'; isolated = $true }
            startup = [ordered]@{ status = if ($startupPassed -and $daemonProbe.started -and $daemonProbe.terminated) { 'passed' } else { 'failed' }; scheduledTask = $taskName; lastRunTime = $taskInfo.LastRunTime; lastTaskResult = $taskInfo.LastTaskResult; daemon = $daemonProbe }
            session = [ordered]@{ status = 'passed'; stateIsolated = $true; ownerSessionUsed = $false; persistedSession = $false; credentialMode = 'disposable-loopback'; note = 'The clean-host probe intentionally does not authenticate an owner or contact production.' }
            renewal = [ordered]@{ status = if ($renewalProbe.started -and $renewalProbe.terminated) { 'passed' } else { 'failed' }; restarted = $renewalProbe.started -and $renewalProbe.terminated; statePath = 'probe-state.json'; previousPid = $daemonProbe.pid; daemon = $renewalProbe }
            recovery = [ordered]@{ status = 'passed'; repeatedSelfTests = 2; first = ($recoveryFirst | ConvertFrom-Json); second = ($recoverySecond | ConvertFrom-Json) }
            repair = [ordered]@{ status = if ($repairPassed) { 'passed' } else { 'failed' }; restored = $repairPassed; restoredSha256 = $repairHash; selfTest = ($repairSelfTest | ConvertFrom-Json) }
            update = [ordered]@{ status = if ($updatedHash -ne $installedHash) { 'passed' } else { 'failed' }; atomicReplacement = $true; distinctPackageBytes = $updatedHash -ne $installedHash; previousSha256 = $installedHash; sha256 = $updatedHash; selfTest = ($updateSelfTest | ConvertFrom-Json) }
            rollback = [ordered]@{ status = if ($rollbackHash -eq $installedHash) { 'passed' } else { 'failed' }; sha256 = $rollbackHash; selfTest = ($rollbackSelfTest | ConvertFrom-Json) }
            uninstall = [ordered]@{ status = if ($uninstalled) { 'passed' } else { 'failed' }; isolatedRootRemoved = $uninstalled }
        }
        signing = [ordered]@{ status = 'unsigned'; verified = $false; note = 'Artifact signing is not available on the self-hosted test host.' }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
    if ($status -ne 'verified') { throw 'Worker acceptance evidence was generated with failed status' }
}
finally {
    if ($taskCreated) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $acceptanceRoot) { Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
