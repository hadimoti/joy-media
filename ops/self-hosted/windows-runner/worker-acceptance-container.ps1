[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateSha,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$Attempt,
    [Parameter(Mandatory = $true)][ValidateSet('1', '2')][string]$Pass,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [switch]$KeepArtifacts
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
# Pairing protects Worker state through DPAPI, which each time pays for a cold
# powershell.exe inside the container. A healthy run still reaches hello/leases
# in a few seconds; the headroom keeps a slow container from being reported as
# "no control-plane traffic".
$daemonReadyTimeoutSeconds = 60
# Diagnostics live outside $acceptanceRoot: the root must be deleted to prove
# uninstall, and a failed run is useless without the Worker's own log.
$diagnosticsRoot = Join-Path (Split-Path -Parent $OutputPath) ("acceptance-diagnostics-{0}-{1}-{2}" -f $RunId, $Attempt, $Pass)
$script:daemonDiagnostics = [ordered]@{}

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

function Get-FileTail([string]$Path, [int]$Lines = 40) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return ((Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop) -join "`n") } catch { return '' }
}

# A daemon run that produced no control-plane traffic must never be reported
# without its cause. The Worker writes its own failures to $stateDirectory\logs,
# and the launcher's stdio is redirected per run.
function Save-DaemonDiagnostics([string]$Label, [string]$StatePath, $Result) {
    $daemonRoot = Split-Path -Parent $StatePath
    $stateLeaf = Split-Path -Leaf $StatePath
    $script:daemonDiagnostics[$Label] = [ordered]@{
        result = $Result
        workerLogTail = Get-FileTail (Join-Path $daemonRoot 'logs\worker.log')
        launcherStdoutTail = Get-FileTail (Join-Path $daemonRoot ($stateLeaf + '.stdout.log'))
        launcherStderrTail = Get-FileTail (Join-Path $daemonRoot ($stateLeaf + '.stderr.log'))
        fixtureStderrTail = Get-FileTail (Join-Path $fixtureRoot 'fixture.stderr.log')
    }
}

function Start-Fixture {
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    $fixtureStdoutPath = Join-Path $fixtureRoot 'fixture.stdout.log'
    $fixtureStderrPath = Join-Path $fixtureRoot 'fixture.stderr.log'
    $fixtureProcess = Start-Process -FilePath $nodePath -ArgumentList @($fixtureScript, '--ready-file', $fixtureReadyPath, '--events-file', $fixtureEventsPath) -PassThru -WindowStyle Hidden -RedirectStandardOutput $fixtureStdoutPath -RedirectStandardError $fixtureStderrPath
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
        # Stop-Process does not wait: the fixture can still hold its log files
        # open, which made the acceptance-root removal fail intermittently.
        [void]$script:fixtureProcess.WaitForExit(30000)
        $script:fixtureProcess = $null
    }
}

function Invoke-Daemon([string]$Path, [string]$StatePath, [string]$PipeName, [string]$Label) {
    $oldRoot = $env:JOY_MEDIA_WORKER_ROOT
    $oldApi = $env:JOY_MEDIA_API_URL
    $oldState = $env:JOY_MEDIA_WORKER_STATE_PATH
    $oldPipe = $env:JOY_MEDIA_WORKER_PIPE
    $oldTestMode = $env:JOY_MEDIA_WORKER_TEST_MODE
    $oldNotification = $env:JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH
    $oldChildPidPath = $env:JOY_MEDIA_WORKER_CHILD_PID_PATH
    $oldHttpProxy = $env:HTTP_PROXY
    $oldHttpsProxy = $env:HTTPS_PROXY
    $oldLowerHttpProxy = $env:http_proxy
    $oldLowerHttpsProxy = $env:https_proxy
    $oldNoProxy = $env:NO_PROXY
    $oldLowerNoProxy = $env:no_proxy
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
        # The acceptance fixture is loopback-only. Do not let the runner's
        # GitHub CONNECT proxy intercept its local HTTP requests.
        $env:HTTP_PROXY = $null
        $env:HTTPS_PROXY = $null
        $env:http_proxy = $null
        $env:https_proxy = $null
        $env:NO_PROXY = 'localhost,127.0.0.1'
        $env:no_proxy = 'localhost,127.0.0.1'
        $daemonRoot = Split-Path -Parent $StatePath
        $daemonStdoutPath = Join-Path $daemonRoot ((Split-Path -Leaf $StatePath) + '.stdout.log')
        $daemonStderrPath = Join-Path $daemonRoot ((Split-Path -Leaf $StatePath) + '.stderr.log')
        # Force-terminating the launcher denies it the chance to remove its own
        # hand-off file, and successive runs reuse one state path. Clear it here
        # so this run can never adopt the previous run's dead child PID.
        Remove-Item -LiteralPath $childPidPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$childPidPath.tmp" -Force -ErrorAction SilentlyContinue
        $process = Start-Process -FilePath $Path -PassThru -WindowStyle Hidden -RedirectStandardOutput $daemonStdoutPath -RedirectStandardError $daemonStderrPath
        $deadline = (Get-Date).AddSeconds($daemonReadyTimeoutSeconds)
        $snapshot = $null
        do {
            Start-Sleep -Milliseconds 250
            # Read the launcher's hand-off as soon as it appears. The launcher
            # removes it once the child exits, so reading it only after the wait
            # would lose the PID of a child that started and then died.
            if ($childPid -le 0) {
                $childMetadata = Get-JsonFile $childPidPath
                if ($null -ne $childMetadata -and [int]$childMetadata.childPid -gt 0) {
                    $childPid = [int]$childMetadata.childPid
                }
            }
            if ($process.HasExited) { break }
            $snapshot = Get-JsonFile $fixtureEventsPath
        } while (($null -eq $snapshot -or [int]$snapshot.counters.hello -le $beforeHello -or [int]$snapshot.counters.leases -le $beforeLeases) -and (Get-Date) -lt $deadline)
        $snapshot = Get-JsonFile $fixtureEventsPath
        $hello = if ($null -eq $snapshot) { 0 } else { [int]$snapshot.counters.hello }
        $leases = if ($null -eq $snapshot) { 0 } else { [int]$snapshot.counters.leases }
        $paired = $null -ne $snapshot -and $snapshot.paired -eq $true
        $started = $null -ne $process -and -not $process.HasExited
        if ($childPid -gt 0) {
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
        $result = [ordered]@{ started = $started; terminated = $terminated; childStarted = $childStarted; childTerminated = $childTerminated; childPid = $childPid; paired = $paired; hello = $hello; leases = $leases; trafficObserved = $hello -gt $beforeHello -and $leases -gt $beforeLeases; notificationCleared = $notificationCleared }
        if (-not (Test-DaemonResult $result)) { Save-DaemonDiagnostics $Label $StatePath $result }
        return $result
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
        $env:HTTP_PROXY = $oldHttpProxy
        $env:HTTPS_PROXY = $oldHttpsProxy
        $env:http_proxy = $oldLowerHttpProxy
        $env:https_proxy = $oldLowerHttpsProxy
        $env:NO_PROXY = $oldNoProxy
        $env:no_proxy = $oldLowerNoProxy
    }
}

function Get-SourceProvenance {
    # The release evidence must come from the exact checkout that Actions
    # selected. A host worktree bind-mounted into the container can expose a
    # .git file whose gitdir points outside the container; that is not a valid
    # provenance source. Fail with an actionable error instead of allowing a
    # null command result to become a misleading clean-worktree claim.
    $head = (& git rev-parse HEAD 2>$null | Out-String).Trim()
    $headExitCode = $LASTEXITCODE
    if ($headExitCode -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
        throw 'Git metadata is unavailable inside the Windows acceptance container; run actions/checkout in the container before collecting evidence.'
    }
    if ($head -ne $CandidateSha) {
        throw "Windows acceptance checkout HEAD $head does not match candidate SHA $CandidateSha."
    }
    $tree = (& git rev-parse 'HEAD^{tree}' 2>$null | Out-String).Trim()
    $treeExitCode = $LASTEXITCODE
    if ($treeExitCode -ne 0 -or $tree -notmatch '^[0-9a-f]{40,64}$') {
        throw 'Git tree provenance could not be resolved inside the Windows acceptance container.'
    }
    $dirty = (& git status --porcelain --untracked-files=all -- . ':(exclude)test-output/**' ':(exclude)test-results/**' ':(exclude)playwright-report/**' 2>$null | Out-String).Trim()
    $statusExitCode = $LASTEXITCODE
    if ($statusExitCode -ne 0) {
        throw 'Git status could not be resolved inside the Windows acceptance container; refusing to claim a clean worktree.'
    }
    return [ordered]@{
        commitSha = $head
        treeHash = $tree
        lockfileSha256 = (Get-FileHash -LiteralPath (Join-Path $PWD 'pnpm-lock.yaml') -Algorithm SHA256).Hash.ToLowerInvariant()
        worktreeClean = [string]::IsNullOrWhiteSpace($dirty)
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
        $packageDirectory = Join-Path $PWD (Join-Path 'packages' $packageName)
        if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
            throw "Required Worker runtime package is missing: $packageDirectory"
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
    $startup = Invoke-Daemon $installedPath $statePath "\\.\pipe\joy-media-start-$RunId-$Attempt-$Pass" 'startup'
    $renewal = Invoke-Daemon $installedPath $statePath "\\.\pipe\joy-media-renew-$RunId-$Attempt-$Pass" 'renewal'
    $state = Get-JsonFile $statePath
    $stateKeys = if ($null -eq $state) { @() } else { @($state.PSObject.Properties.Name) }
    $protectedState = ($stateKeys -contains 'protectedSessionToken') -and ($stateKeys -notcontains 'sessionToken')
    $recovery = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'recovery-state.json') "\\.\pipe\joy-media-recovery-$RunId-$Attempt-$Pass" 'recovery'
    $recovery2 = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'recovery-state-2.json') "\\.\pipe\joy-media-recovery-2-$RunId-$Attempt-$Pass" 'recovery2'

    $repairPath = Join-Path $acceptanceRoot 'joy-worker.repair.exe'
    Copy-Item $installedPath $repairPath -Force
    Remove-Item $installedPath -Force
    Copy-Item $repairPath $installedPath -Force
    $repairHash = (Get-FileHash $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $repair = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'repair-state.json') "\\.\pipe\joy-media-repair-$RunId-$Attempt-$Pass" 'repair'
    $repairPassed = $repairHash -eq $installedHash -and (Test-DaemonResult $repair)

    $nextPath = Join-Path $acceptanceRoot 'joy-worker.next.exe'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PWD 'scripts\build-worker-exe.ps1') -OutputPath $nextPath -NodePath $script:nodePath -BuildMarker ("update-{0}-{1}" -f $RunId, $Pass)
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nextPath -PathType Leaf)) { throw 'The distinct updated Worker package was not built.' }
    $updatedBeforeInstall = Invoke-SelfTest $nextPath
    $updatedHash = (Get-FileHash $nextPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item $nextPath $installedPath -Force
    $updated = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'updated-state.json') "\\.\pipe\joy-media-updated-$RunId-$Attempt-$Pass" 'update'
    Copy-Item $repairPath $installedPath -Force
    $rollbackHash = (Get-FileHash $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $rollback = Invoke-Daemon $installedPath (Join-Path $acceptanceRoot 'rollback-state.json') "\\.\pipe\joy-media-rollback-$RunId-$Attempt-$Pass" 'rollback'

    # Record the real Authenticode status of the installed Worker before the
    # acceptance root is removed. CI builds are normally unsigned; report that
    # honestly rather than omitting the field.
    $signature = Get-AuthenticodeSignature -LiteralPath $installedPath
    $signingStatus = if ($signature.Status -eq 'Valid') { 'signed' } else { 'unsigned' }

    Stop-Fixture
    # Uninstall is a required predicate, so the acceptance root always goes. Any
    # diagnostics worth keeping were copied out of it by Save-DaemonDiagnostics.
    # Bounded retry for handles the OS releases asynchronously after the
    # fixture exits; a root that still cannot be removed fails the uninstall
    # predicate below instead of being ignored.
    for ($removeAttempt = 1; $removeAttempt -le 10; $removeAttempt++) {
        try {
            Remove-Item $acceptanceRoot -Recurse -Force -ErrorAction Stop
            break
        } catch {
            if ($removeAttempt -eq 10) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
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
        signing = [ordered]@{ status = $signingStatus; verified = ($signingStatus -eq 'signed'); signatureStatus = [string]$signature.Status }
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
    # The gated evidence records only predicates. Publish the collected Worker
    # logs alongside it so a failing predicate always arrives with its cause.
    if ($script:daemonDiagnostics.Count -gt 0) {
        New-Item -ItemType Directory -Path $diagnosticsRoot -Force | Out-Null
        [IO.File]::WriteAllText(
            (Join-Path $diagnosticsRoot 'daemon-runs.json'),
            ([ordered]@{ candidateSha = $CandidateSha; pass = $Pass; runs = $script:daemonDiagnostics } | ConvertTo-Json -Depth 12),
            $utf8NoBom)
        Write-Warning ("container-local acceptance diagnostics written to {0}" -f $diagnosticsRoot)
        foreach ($label in $script:daemonDiagnostics.Keys) {
            $diagnostic = $script:daemonDiagnostics[$label]
            Write-Warning ("daemon run '{0}' failed: {1}" -f $label, ($diagnostic['result'] | ConvertTo-Json -Compress))
            foreach ($stream in @('workerLogTail', 'launcherStderrTail')) {
                if (-not [string]::IsNullOrWhiteSpace($diagnostic[$stream])) {
                    Write-Warning ("daemon run '{0}' {1}:`n{2}" -f $label, $stream, $diagnostic[$stream])
                }
            }
        }
    }
    if (-not $verified) { throw 'container-local Windows acceptance did not satisfy every lifecycle predicate' }
}
finally {
    Stop-Fixture
    if (-not $KeepArtifacts -and (Test-Path $acceptanceRoot)) { Remove-Item $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
