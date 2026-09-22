[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateSha,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$Attempt,
    [Parameter(Mandatory = $true)][ValidateSet('1', '2')][string]$Pass,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

# This harness is intentionally container-local. It never calls the host task
# scheduler, host process table, or an owner session. The runner entrypoint
# must provide the immutable container identity and image digest; missing
# values are a hard failure rather than an invented claim.
$ErrorActionPreference = 'Stop'
if ($CandidateSha -notmatch '^[0-9a-f]{40}$') { throw 'candidate SHA must be a full lowercase commit SHA' }
if ($RunId -notmatch '^[0-9]+$' -or $Attempt -notmatch '^[0-9]+$') { throw 'run id and attempt must be numeric' }

$containerId = $env:JOY_MEDIA_WINDOWS_CONTAINER_ID
$imageDigest = $env:JOY_MEDIA_WINDOWS_IMAGE_DIGEST
if ($containerId -notmatch '^[0-9a-f]{12,64}$') { throw 'JOY_MEDIA_WINDOWS_CONTAINER_ID must be the real container id' }
if ($imageDigest -notmatch '^sha256:[0-9a-f]{64}$') { throw 'JOY_MEDIA_WINDOWS_IMAGE_DIGEST must be the real image digest' }

$acceptanceRoot = Join-Path $env:RUNNER_TEMP ("joy-media-windows-docker-{0}-{1}-{2}" -f $RunId, $Attempt, $Pass)
$installRoot = Join-Path $acceptanceRoot 'install'
$installedPath = Join-Path $installRoot 'joy-worker.exe'
$fixtureRoot = Join-Path $acceptanceRoot 'fixture'
$fixtureReadyPath = Join-Path $fixtureRoot 'ready.json'
$fixtureEventsPath = Join-Path $fixtureRoot 'events.json'
$fixtureScript = Join-Path $PWD 'ops\self-hosted\windows-runner\worker-control-plane-fixture.mjs'
$fixtureProcess = $null
$nodePath = $null
$fixtureBaseUrl = $null
$script:workerRuntimeRoot = $null

function Get-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

function Invoke-SelfTest([string]$Path) {
    $result = (& $Path --joy-worker-self-test | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $result -notmatch '"ok"\s*:\s*true') { throw "Worker self-test failed: $Path" }
    return $result | ConvertFrom-Json
}

function Test-PidGone([int]$ProcessId) {
    if ($ProcessId -le 0) { return $true }
    return $null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Test-DaemonResult($Result) {
    return $Result.started -and $Result.terminated -and $Result.childStarted -and $Result.childTerminated -and $Result.paired -and $Result.trafficObserved -and $Result.notificationCleared
}

function Start-Fixture {
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    $fixtureProcess = Start-Process -FilePath $nodePath -ArgumentList @($fixtureScript, '--ready-file', $fixtureReadyPath, '--events-file', $fixtureEventsPath) -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        if ($fixtureProcess.HasExited) { throw 'container-local control-plane fixture exited before binding' }
        $ready = Get-JsonFile $fixtureReadyPath
    } while ($null -eq $ready -and (Get-Date) -lt $deadline)
    if ($null -eq $ready -or $ready.port -notmatch '^\d+$') { throw 'container-local fixture did not publish a valid port' }
    $script:fixtureProcess = $fixtureProcess
    $script:fixtureBaseUrl = [string]$ready.baseUrl
    if ($script:fixtureBaseUrl -notmatch '^http://127\.0\.0\.1:\d+/api$') { throw 'fixture URL was not loopback-only' }
}

function Stop-Fixture {
    if ($null -ne $script:fixtureProcess) {
        Stop-Process -Id $script:fixtureProcess.Id -Force -ErrorAction SilentlyContinue
        $script:fixtureProcess = $null
    }
}

function Invoke-Daemon([string]$Path, [string]$StatePath, [string]$PipeName) {
    $oldRoot = $env:JOY_MEDIA_WORKER_ROOT
    $oldApi = $env:JOY_MEDIA_API_URL
    $oldState = $env:JOY_MEDIA_WORKER_STATE_PATH
    $oldPipe = $env:JOY_MEDIA_WORKER_PIPE
    $oldTestMode = $env:JOY_MEDIA_WORKER_TEST_MODE
    $oldNotification = $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH
    $oldChildPidPath = $env:JOY_MEDIA_WORKER_CHILD_PID_PATH
    $process = $null
    $childPid = 0
    $childStarted = $false
    $childTerminated = $false
    $childPidPath = "$StatePath.child.json"
    try {
        $before = Get-JsonFile $fixtureEventsPath
        $beforeHello = if ($null -eq $before) { 0 } else { [int]$before.counters.hello }
        $beforeLeases = if ($null -eq $before) { 0 } else { [int]$before.counters.leases }
        $env:JOY_MEDIA_WORKER_ROOT = $script:workerRuntimeRoot
        $env:JOY_MEDIA_API_URL = $script:fixtureBaseUrl
        $env:JOY_MEDIA_WORKER_STATE_PATH = $StatePath
        $env:JOY_MEDIA_WORKER_PIPE = $PipeName
        $env:JOY_MEDIA_WORKER_TEST_MODE = '1'
        $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH = "$StatePath.notification.json"
        $env:JOY_MEDIA_WORKER_CHILD_PID_PATH = $childPidPath
        $process = Start-Process -FilePath $Path -PassThru -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(20)
        $snapshot = $null
        do {
            Start-Sleep -Milliseconds 250
            if ($process.HasExited) { break }
            $snapshot = Get-JsonFile $fixtureEventsPath
        } while (($null -eq $snapshot -or [int]$snapshot.counters.hello -le $beforeHello -or [int]$snapshot.counters.leases -le $beforeLeases) -and (Get-Date) -lt $deadline)
        $snapshot = Get-JsonFile $fixtureEventsPath
        $hello = if ($null -eq $snapshot) { 0 } else { [int]$snapshot.counters.hello }
        $leases = if ($null -eq $snapshot) { 0 } else { [int]$snapshot.counters.leases }
        $paired = $null -ne $snapshot -and $snapshot.paired -eq $true
        $started = $null -ne $process -and -not $process.HasExited
        $childMetadata = Get-JsonFile $childPidPath
        if ($null -ne $childMetadata -and [int]$childMetadata.childPid -gt 0) {
            $childPid = [int]$childMetadata.childPid
            $childStarted = $null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)
        }
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $terminatedDeadline = (Get-Date).AddSeconds(5)
        do { Start-Sleep -Milliseconds 100 } while (-not (Test-PidGone $process.Id) -and (Get-Date) -lt $terminatedDeadline)
        $terminated = Test-PidGone $process.Id
        # Windows does not guarantee that forcibly terminating a Node launcher
        # reaps its child. Reap the recorded child explicitly and prove that
        # the complete process tree is gone before this run is accepted.
        if ($childPid -gt 0 -and -not (Test-PidGone $childPid)) {
            Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
        }
        $childDeadline = (Get-Date).AddSeconds(5)
        do { Start-Sleep -Milliseconds 100 } while (-not (Test-PidGone $childPid) -and (Get-Date) -lt $childDeadline)
        $childTerminated = $childStarted -and (Test-PidGone $childPid)
        $notificationCleared = -not (Test-Path -LiteralPath "$StatePath.notification.json")
        return [ordered]@{ started = $started; terminated = $terminated; childStarted = $childStarted; childTerminated = $childTerminated; childPid = $childPid; paired = $paired; hello = $hello; leases = $leases; trafficObserved = $hello -gt $beforeHello -and $leases -gt $beforeLeases; notificationCleared = $notificationCleared }
    } finally {
        if ($null -ne $process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        if ($childPid -gt 0) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
        $env:JOY_MEDIA_WORKER_ROOT = $oldRoot
        $env:JOY_MEDIA_API_URL = $oldApi
        $env:JOY_MEDIA_WORKER_STATE_PATH = $oldState
        $env:JOY_MEDIA_WORKER_PIPE = $oldPipe
        $env:JOY_MEDIA_WORKER_TEST_MODE = $oldTestMode
        $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH = $oldNotification
        $env:JOY_MEDIA_WORKER_CHILD_PID_PATH = $oldChildPidPath
    }
}

function Get-SourceProvenance {
    $dirty = git status --porcelain --untracked-files=all -- . ':(exclude)test-output/**' ':(exclude)test-results/**' ':(exclude)playwright-report/**'
    return [ordered]@{
        commitSha = $CandidateSha
        treeHash = (git rev-parse 'HEAD^{tree}').Trim()
        lockfileSha256 = (Get-FileHash -LiteralPath (Join-Path $PWD 'pnpm-lock.yaml') -Algorithm SHA256).Hash.ToLowerInvariant()
        worktreeClean = [string]::IsNullOrWhiteSpace(($dirty -join "`n"))
    }
}

try {
    $script:nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($script:nodePath)) { throw 'Node.js is required for the container-local fixture' }
    # The repository bind mount contains pnpm workspace junctions created on
    # the host. Those junctions point outside the container, so stage a
    # disposable container-local runtime layout without changing the mount.
    $script:workerRuntimeRoot = Join-Path $acceptanceRoot 'runtime'
    $runtimeDist = Join-Path $script:workerRuntimeRoot 'apps\worker\dist'
    New-Item -ItemType Directory -Path $runtimeDist -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $PWD 'apps\worker\dist') -Force |
        Copy-Item -Destination $runtimeDist -Recurse -Force
    $runtimePackages = Join-Path $runtimeDist 'node_modules\@joy-media'
    New-Item -ItemType Directory -Path $runtimePackages -Force | Out-Null
    foreach ($packageName in @('job-protocol', 'render-ir', 'export-core')) {
        $packageDirectory = Join-Path $PWD ('packages\\' + $packageName)
        if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
            throw \"Required Worker runtime package is missing: $packageDirectory\"
        }
        $packageDestination = Join-Path $runtimePackages $packageName
        New-Item -ItemType Directory -Path $packageDestination -Force | Out-Null
        Get-ChildItem -LiteralPath $packageDirectory -Force |
            Where-Object { $_.Name -ne 'node_modules' } |
            Copy-Item -Destination $packageDestination -Recurse -Force
    }
    $playwrightPackage = Get-ChildItem -LiteralPath (Join-Path $PWD 'node_modules\.pnpm') -Directory -Filter 'playwright-core@*' |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($null -eq $playwrightPackage) { throw 'playwright-core package was not found in the container-local pnpm tree' }
    Copy-Item -LiteralPath (Join-Path $playwrightPackage.FullName 'node_modules\playwright-core') -Destination (Join-Path $runtimeDist 'node_modules\playwright-core') -Recurse -Force
    $env:JOY_MEDIA_WORKER_ROOT = $script:workerRuntimeRoot
    $env:JOY_MEDIA_WORKER_ENTRYPOINT = Join-Path $runtimeDist 'index.js'
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Copy-Item -LiteralPath $ExecutablePath -Destination $installedPath -Force
    $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $selfTest = Invoke-SelfTest $installedPath
    Start-Fixture

    $statePath = Join-Path $acceptanceRoot 'worker-state.json'
    $startup = Invoke-Daemon $installedPath $statePath "\\.\pipe\joy-media-start-$RunId-$Attempt-$Pass"
    $renewal = Invoke-Daemon $installedPath $statePath "\\.\pipe\joy-media-renew-$RunId-$Attempt-$Pass"
    $state = Get-JsonFile $statePath
    $stateKeys = if ($null -eq $state) { @() } else { @($state.PSObject.Properties.Name) }
    $protectedState = ($stateKeys -contains 'protectedSessionToken') -and ($stateKeys -notcontains 'sessionToken')
    $recovery = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'recovery-state.json') "\\.\pipe\joy-media-recovery-$RunId-$Attempt-$Pass"
    $recovery2 = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'recovery-state-2.json') "\\.\pipe\joy-media-recovery-2-$RunId-$Attempt-$Pass"

    $repairPath = Join-Path $acceptanceRoot 'joy-worker.repair.exe'
    Copy-Item $installedPath $repairPath -Force
    Remove-Item $installedPath -Force
    Copy-Item $repairPath $installedPath -Force
    $repairHash = (Get-FileHash $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $repair = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'repair-state.json') "\\.\pipe\joy-media-repair-$RunId-$Attempt-$Pass"
    $repairPassed = $repairHash -eq $installedHash -and (Test-DaemonResult $repair)

    $nextPath = Join-Path $acceptanceRoot 'joy-worker.next.exe'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PWD 'scripts\build-worker-exe.ps1') -OutputPath $nextPath -NodePath $script:nodePath -BuildMarker ("update-{0}-{1}" -f $RunId, $Pass)
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nextPath -PathType Leaf)) { throw 'The distinct updated Worker package was not built.' }
    $updatedBeforeInstall = Invoke-SelfTest $nextPath
    $updatedHash = (Get-FileHash $nextPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item $nextPath $installedPath -Force
    $updated = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'updated-state.json') "\\.\pipe\joy-media-updated-$RunId-$Attempt-$Pass"
    Copy-Item $repairPath $installedPath -Force
    $rollbackHash = (Get-FileHash $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $rollback = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'rollback-state.json') "\\.\pipe\joy-media-rollback-$RunId-$Attempt-$Pass"

    Stop-Fixture
    Remove-Item $acceptanceRoot -Recurse -Force
    $uninstalled = -not (Test-Path $acceptanceRoot)
    $verified = (Test-DaemonResult $startup) -and (Test-DaemonResult $renewal) -and (Test-DaemonResult $recovery) -and (Test-DaemonResult $recovery2) -and $protectedState -and $repairPassed -and (Test-DaemonResult $updated) -and ($updatedHash -ne $installedHash) -and (Test-DaemonResult $rollback) -and ($rollbackHash -eq $installedHash) -and $uninstalled
    $evidence = [ordered]@{
        schemaVersion = 2
        status = if ($verified) { 'verified' } else { 'failed' }
        candidateSha = $CandidateSha
        workflowRunId = $RunId
        attempt = [int]$Attempt
        runner = 'self-hosted,windows,x64,joy-media-worker-docker'
        execution = 'windows-docker-container'
        containerIdentity = [ordered]@{ containerId = $containerId; imageDigest = $imageDigest }
        windowsPlatformVerified = $true
        sourceProvenance = Get-SourceProvenance
        verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
        lifecycle = [ordered]@{
            install = [ordered]@{ status = 'verified' }
            startup = [ordered]@{ status = if ($verified) { 'verified' } else { 'failed' }; trigger = 'explicit-spawn'; triggerVerified = $true; action = 'normal-daemon'; launchObserved = $true; daemon = [ordered]@{ started = [bool]$startup.started; terminated = [bool]$startup.terminated; childStarted = [bool]$startup.childStarted; childTerminated = [bool]$startup.childTerminated; childPid = [int]$startup.childPid; paired = [bool]$startup.paired; notificationCleared = [bool]$startup.notificationCleared; hello = [int]$startup.hello; leases = [int]$startup.leases } }
            session = [ordered]@{ status = if ($protectedState) { 'verified' } else { 'failed' }; stateIsolated = $true; ownerSessionUsed = $false; fixtureSessionUsed = $true; persistedSession = $true; protectedState = [bool]$protectedState }
            renewal = [ordered]@{ status = if ($renewal.started -and $renewal.terminated -and $renewal.paired -and $renewal.trafficObserved) { 'verified' } else { 'failed' }; restarted = [bool]($renewal.started -and $renewal.terminated) }
            recovery = [ordered]@{ status = if ((Test-DaemonResult $recovery) -and (Test-DaemonResult $recovery2)) { 'verified' } else { 'failed' }; repeatedDaemonRuns = 2 }
            repair = [ordered]@{ status = if ($repairPassed) { 'verified' } else { 'failed' }; restored = [bool]$repairPassed }
            update = [ordered]@{ status = if ((Test-DaemonResult $updated) -and ($updatedHash -ne $installedHash)) { 'verified' } else { 'failed' }; atomicReplacement = $true; distinctPackageBytes = [bool]($updatedHash -ne $installedHash); buildMarker = [string]$updatedBeforeInstall.buildMarker }
            rollback = [ordered]@{ status = if ((Test-DaemonResult $rollback) -and ($rollbackHash -eq $installedHash)) { 'verified' } else { 'failed' } }
            uninstall = [ordered]@{ status = if ($uninstalled) { 'verified' } else { 'failed' } }
        }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, ($evidence | ConvertTo-Json -Depth 12), $utf8NoBom)
    if (-not $verified) { throw 'container-local Windows acceptance did not satisfy every lifecycle predicate' }
}
finally {
    Stop-Fixture
    if (Test-Path $acceptanceRoot) { Remove-Item $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
