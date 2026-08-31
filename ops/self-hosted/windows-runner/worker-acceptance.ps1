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
$fixtureRoot = Join-Path $acceptanceRoot 'control-plane-fixture'
$fixtureReadyPath = Join-Path $fixtureRoot 'ready.json'
$fixtureEventsPath = Join-Path $fixtureRoot 'events.json'
$fixtureScript = Join-Path $PWD 'ops\self-hosted\windows-runner\worker-control-plane-fixture.mjs'
$taskName = "JOY Media Worker Acceptance $RunId-$Attempt-$Pass"
$taskCreated = $false
$fixtureProcess = $null
$scheduledRootIds = @()
$nodePath = $null
$fixtureBaseUrl = $null

function Invoke-WorkerSelfTest([string]$Path) {
    $output = & $Path --joy-worker-self-test
    if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch '"ok"\s*:\s*true') {
        throw "Worker self-test failed for $Path"
    }
    return ($output -join "`n")
}

function Get-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
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
    for ($stopAttempt = 0; $stopAttempt -lt 40; $stopAttempt += 1) {
        if (-not (Get-Process -Id $RootId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
    return -not (Get-Process -Id $RootId -ErrorAction SilentlyContinue)
}

function Get-WorkerRootProcesses([string]$Path) {
    $escapedPath = [regex]::Escape($Path)
    return @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq 'joy-worker.exe' -and
                -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
                $_.CommandLine -match $escapedPath
            }
    )
}

function Start-LoopbackFixture {
    if (-not (Test-Path -LiteralPath $fixtureScript -PathType Leaf)) {
        throw "Worker control-plane fixture is missing: $fixtureScript"
    }
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    $scriptArgs = @(
        $fixtureScript,
        '--ready-file',
        $fixtureReadyPath,
        '--events-file',
        $fixtureEventsPath
    )
    $script:fixtureProcess = Start-Process -FilePath $script:nodePath -ArgumentList $scriptArgs -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        if ($script:fixtureProcess.HasExited) { throw 'Worker control-plane fixture exited before binding' }
        $ready = Get-JsonFile -Path $fixtureReadyPath
    } while ($null -eq $ready -and (Get-Date) -lt $deadline)
    if ($null -eq $ready -or $ready.port -notmatch '^\d+$') { throw 'Worker control-plane fixture did not publish a valid port' }
    $script:fixtureBaseUrl = [string]$ready.baseUrl
    if ($script:fixtureBaseUrl -notmatch '^http://127\.0\.0\.1:\d+/api$') {
        throw 'Worker control-plane fixture did not publish a loopback API URL'
    }
}

function Stop-LoopbackFixture {
    if ($null -ne $script:fixtureProcess) {
        Stop-Process -Id $script:fixtureProcess.Id -Force -ErrorAction SilentlyContinue
        for ($fixtureStopAttempt = 0; $fixtureStopAttempt -lt 40; $fixtureStopAttempt += 1) {
            if (-not (Get-Process -Id $script:fixtureProcess.Id -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
        $script:fixtureProcess = $null
    }
}

function Get-FixtureSnapshot {
    return Get-JsonFile -Path $fixtureEventsPath
}

function Invoke-WorkerDaemonProbe([string]$Path, [string]$Root, [string]$State, [string]$ApiUrl, [string]$Pipe) {
    $oldRoot = $env:JOY_MEDIA_WORKER_ROOT
    $oldApi = $env:JOY_MEDIA_API_URL
    $oldState = $env:JOY_MEDIA_WORKER_STATE_PATH
    $oldPipe = $env:JOY_MEDIA_WORKER_PIPE
    $oldTestMode = $env:JOY_MEDIA_WORKER_TEST_MODE
    $oldNotification = $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH
    $process = $null
    try {
        $baselineSnapshot = Get-FixtureSnapshot
        $baselineHello = if ($null -eq $baselineSnapshot) { 0 } else { [int]$baselineSnapshot.counters.hello }
        $baselineLeases = if ($null -eq $baselineSnapshot) { 0 } else { [int]$baselineSnapshot.counters.leases }
        $env:JOY_MEDIA_WORKER_ROOT = $Root
        $env:JOY_MEDIA_API_URL = $ApiUrl
        $env:JOY_MEDIA_WORKER_STATE_PATH = $State
        $env:JOY_MEDIA_WORKER_PIPE = $Pipe
        $env:JOY_MEDIA_WORKER_TEST_MODE = '1'
        $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH = "$State.notification.json"
        $process = Start-Process -FilePath $Path -PassThru -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(15)
        $snapshot = $null
        do {
            Start-Sleep -Milliseconds 250
            if ($process.HasExited) { break }
            $snapshot = Get-FixtureSnapshot
        } while (
            ($null -eq $snapshot -or $snapshot.counters.hello -le $baselineHello -or $snapshot.counters.leases -le $baselineLeases) -and
            (Get-Date) -lt $deadline
        )
        $started = -not $process.HasExited
        $snapshot = Get-FixtureSnapshot
        $paired = $null -ne $snapshot -and $snapshot.paired -eq $true
        $hello = if ($null -eq $snapshot) { 0 } else { [int]$snapshot.counters.hello }
        $leases = if ($null -eq $snapshot) { 0 } else { [int]$snapshot.counters.leases }
        $childCount = @(Get-DescendantProcessIds -RootId $process.Id).Count
        $terminated = Stop-ProcessTree -RootId $process.Id
        $notificationCleared = -not (Test-Path -LiteralPath "$State.notification.json")
        $stateAfter = Get-JsonFile -Path $State
        $stateKeys = if ($null -eq $stateAfter) { @() } else { @($stateAfter.PSObject.Properties.Name) }
        return [ordered]@{
            started = $started
            pid = $process.Id
            childCount = $childCount
            terminated = $terminated
            paired = $paired
            hello = $hello
            leases = $leases
            baselineHello = $baselineHello
            baselineLeases = $baselineLeases
            helloDelta = $hello - $baselineHello
            leaseDelta = $leases - $baselineLeases
            trafficObserved = $hello -gt $baselineHello -and $leases -gt $baselineLeases
            notificationCleared = $notificationCleared
            stateKeys = $stateKeys
        }
    } finally {
        if ($null -ne $process) { Stop-ProcessTree -RootId $process.Id | Out-Null }
        $env:JOY_MEDIA_WORKER_ROOT = $oldRoot
        $env:JOY_MEDIA_API_URL = $oldApi
        $env:JOY_MEDIA_WORKER_STATE_PATH = $oldState
        $env:JOY_MEDIA_WORKER_PIPE = $oldPipe
        $env:JOY_MEDIA_WORKER_TEST_MODE = $oldTestMode
        $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH = $oldNotification
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
    $script:nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($script:nodePath)) { throw 'Node.js is required for the isolated Worker control-plane fixture' }
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Copy-Item -LiteralPath $ExecutablePath -Destination $installedPath -Force
    $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $selfTest = Invoke-WorkerSelfTest $installedPath
    Start-LoopbackFixture

    # The scheduled task must launch the normal hidden daemon, not the package
    # self-test. The fixture is loopback-only and is explicitly enabled as a
    # test API, so no production URL or owner credential can be contacted.
    $scheduledStatePath = Join-Path $acceptanceRoot 'scheduled-state.json'
    $scheduledPipe = "\\.\pipe\joy-media-ci-scheduled-$RunId-$Attempt-$Pass"
    $powershellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($powershellPath)) { $powershellPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source }
    if ([string]::IsNullOrWhiteSpace($powershellPath)) { throw 'PowerShell is required for scheduled-task acceptance' }
    $runnerPath = Join-Path $PWD 'scripts\run-worker-headless.ps1'
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ApiUrl "{1}" -StatePath "{2}" -WorkerExecutable "{3}" -WorkerPipe "{4}" -TestMode' -f $runnerPath, $fixtureBaseUrl, $scheduledStatePath, $installedPath, $scheduledPipe
    $userId = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $PWD.Path
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    $taskCreated = $true
    $registeredTask = Get-ScheduledTask -TaskName $taskName
    $logonTriggers = @(
        $registeredTask.Triggers |
            Where-Object {
                ($_.TriggerType -eq 'AtLogOn' -or $_.CimClass.CimClassName -match 'LogonTrigger') -and
                ($_.UserId -eq $userId -or $_.UserId -eq $env:USERNAME)
            }
    )
    $startupTriggerPassed = $logonTriggers.Count -eq 1
    $previousTaskInfo = Get-ScheduledTaskInfo -TaskName $taskName
    $previousLastRunTime = $previousTaskInfo.LastRunTime
    Start-ScheduledTask -TaskName $taskName
    $taskInfo = $null
    $taskState = $null
    $taskRan = $false
    $scheduledProcesses = @()
    $scheduledSnapshot = $null
    $startupDeadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
        $taskState = (Get-ScheduledTask -TaskName $taskName).State
        $taskRan = $taskInfo.LastRunTime -ne $previousLastRunTime
        $scheduledProcesses = @(Get-WorkerRootProcesses -Path $installedPath)
        $scheduledSnapshot = Get-FixtureSnapshot
    } while (
        (
            -not $taskRan -or
            $taskState -ne 'Running' -or
            $scheduledProcesses.Count -eq 0 -or
            $null -eq $scheduledSnapshot -or
            $scheduledSnapshot.counters.hello -lt 1
        ) -and
        (Get-Date) -lt $startupDeadline
    )
    $scheduledRootIds = @($scheduledProcesses | ForEach-Object { [int]$_.ProcessId })
    $startupTaskState = $taskState
    $scheduledNotificationPath = "$scheduledStatePath.notification.json"
    $scheduledNotificationCleared = -not (Test-Path -LiteralPath $scheduledNotificationPath)
    $startupTaskExecutionPassed = $startupTaskState -in @('Running', 'Ready')
    $startupPassed = $startupTriggerPassed -and $taskRan -and $startupTaskExecutionPassed -and $scheduledProcesses.Count -gt 0 -and $null -ne $scheduledSnapshot -and $scheduledSnapshot.paired -eq $true -and $scheduledSnapshot.counters.hello -ge 1 -and $scheduledSnapshot.counters.leases -ge 1 -and $scheduledNotificationCleared
    $scheduledChildCount = 0
    if ($scheduledRootIds.Count -gt 0) { $scheduledChildCount = @(Get-DescendantProcessIds -RootId $scheduledRootIds[0]).Count }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    for ($taskStopAttempt = 0; $taskStopAttempt -lt 80; $taskStopAttempt += 1) {
        Start-Sleep -Milliseconds 250
        $taskState = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
        if ($taskState -ne 'Running') { break }
    }
    $scheduledTerminated = $true
    foreach ($rootId in $scheduledRootIds) { $scheduledTerminated = (Stop-ProcessTree -RootId $rootId) -and $scheduledTerminated }
    if (@(Get-WorkerRootProcesses -Path $installedPath).Count -gt 0) { $scheduledTerminated = $false }
    $scheduledState = Get-JsonFile -Path $scheduledStatePath
    $scheduledStateProperties = if ($null -eq $scheduledState) { @() } else { @($scheduledState.PSObject.Properties.Name) }
    $scheduledStateProtected = ($scheduledStateProperties -contains 'protectedSessionToken') -and -not ($scheduledStateProperties -contains 'sessionToken')
    $scheduledSnapshot = Get-FixtureSnapshot
    $scheduledDaemon = [ordered]@{
        started = $scheduledProcesses.Count -gt 0
        pid = if ($scheduledRootIds.Count -gt 0) { $scheduledRootIds[0] } else { 0 }
        childCount = $scheduledChildCount
        terminated = $scheduledTerminated
        paired = $null -ne $scheduledSnapshot -and $scheduledSnapshot.paired -eq $true
        hello = if ($null -eq $scheduledSnapshot) { 0 } else { [int]$scheduledSnapshot.counters.hello }
        leases = if ($null -eq $scheduledSnapshot) { 0 } else { [int]$scheduledSnapshot.counters.leases }
        notificationCleared = $scheduledNotificationCleared
    }

    $probeStatePath = Join-Path $acceptanceRoot 'probe-state.json'
    $probePipe = "\\.\pipe\joy-media-ci-probe-$RunId-$Attempt-$Pass"
    $daemonProbe = Invoke-WorkerDaemonProbe -Path $installedPath -Root $PWD.Path -State $probeStatePath -ApiUrl $fixtureBaseUrl -Pipe $probePipe
    $daemonProbePassed = $daemonProbe.started -and $daemonProbe.paired -and $daemonProbe.trafficObserved -and $daemonProbe.notificationCleared -and $daemonProbe.terminated
    # Reusing the same protected state proves restart/renewal without creating
    # a second identity or a second pairing offer.
    $renewalProbe = Invoke-WorkerDaemonProbe -Path $installedPath -Root $PWD.Path -State $probeStatePath -ApiUrl $fixtureBaseUrl -Pipe "$probePipe-renewal"
    $renewalProbePassed = $renewalProbe.started -and $renewalProbe.paired -and $renewalProbe.trafficObserved -and $renewalProbe.notificationCleared -and $renewalProbe.terminated
    $probeState = Get-JsonFile -Path $probeStatePath
    $probeStateProperties = if ($null -eq $probeState) { @() } else { @($probeState.PSObject.Properties.Name) }
    $probeStateProtected = ($probeStateProperties -contains 'protectedSessionToken') -and -not ($probeStateProperties -contains 'sessionToken')
    $fixtureSnapshot = Get-FixtureSnapshot
    $fixturePassed = $null -ne $fixtureSnapshot -and $fixtureSnapshot.counters.offers -ge 1 -and $fixtureSnapshot.counters.claims -ge 1 -and $fixtureSnapshot.counters.hello -ge 3 -and $fixtureSnapshot.counters.leases -ge 3

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
    Stop-LoopbackFixture
    Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force
    $uninstalled = -not (Test-Path -LiteralPath $acceptanceRoot)
    if (-not $uninstalled) { throw 'Worker acceptance install directory was not removed' }

    $sessionPassed = $scheduledStateProtected -and $probeStateProtected -and $fixturePassed
    $status = if ($startupPassed -and $scheduledDaemon.terminated -and $daemonProbePassed -and $renewalProbePassed -and $sessionPassed -and $repairPassed -and $uninstalled) { 'verified' } else { 'failed' }
    $evidence = [ordered]@{
        schemaVersion = 2
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
            startup = [ordered]@{ status = if ($startupPassed -and $scheduledDaemon.terminated) { 'passed' } else { 'failed' }; scheduledTask = $taskName; trigger = 'at-logon'; triggerVerified = $startupTriggerPassed; user = $userId; action = 'normal-daemon'; taskState = $startupTaskState; taskRan = $taskRan; lastRunTime = $taskInfo.LastRunTime; lastTaskResult = $taskInfo.LastTaskResult; daemon = $scheduledDaemon }
            session = [ordered]@{ status = if ($sessionPassed) { 'passed' } else { 'failed' }; stateIsolated = $true; ownerSessionUsed = $false; fixtureSessionUsed = $true; persistedSession = $probeStateProtected; protectedState = $scheduledStateProtected -and $probeStateProtected; scheduledStateKeys = $scheduledStateProperties; probeStateKeys = $probeStateProperties; credentialMode = 'disposable-loopback-fixture'; offers = if ($null -eq $fixtureSnapshot) { 0 } else { [int]$fixtureSnapshot.counters.offers }; claims = if ($null -eq $fixtureSnapshot) { 0 } else { [int]$fixtureSnapshot.counters.claims }; note = 'The clean-host lane authenticates only against an isolated loopback control-plane fixture; it never contacts production or uses an owner session.' }
            renewal = [ordered]@{ status = if ($renewalProbe.started -and $renewalProbe.paired -and $renewalProbe.terminated) { 'passed' } else { 'failed' }; restarted = $renewalProbe.started -and $renewalProbe.terminated; statePath = 'probe-state.json'; previousPid = $daemonProbe.pid; daemon = $renewalProbe }
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
    foreach ($rootId in $scheduledRootIds) { Stop-ProcessTree -RootId $rootId | Out-Null }
    Stop-LoopbackFixture
    if (Test-Path -LiteralPath $acceptanceRoot) { Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
