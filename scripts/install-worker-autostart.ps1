[CmdletBinding()]
param(
    [string]$TaskName = 'JOY Media Local Worker',
    [string]$ApiUrl = 'https://joyst.ir/api',
    [string]$StatePath = ''
)

$ErrorActionPreference = 'Stop'
$parsedApiUrl = [Uri]$ApiUrl
if ($parsedApiUrl.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($parsedApiUrl.Host)) {
    throw 'ApiUrl must be an HTTPS URL.'
}

if ([string]::IsNullOrWhiteSpace($StatePath)) {
    $StatePath = Join-Path $env:USERPROFILE '.joy-media\worker-state.json'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $PSScriptRoot 'run-worker-headless.ps1'
$entryPoint = Join-Path $repoRoot 'apps\worker\dist\index.js'
$workerExecutable = Join-Path $repoRoot 'apps\worker\bin\joy-worker.exe'
$workerBuildScript = Join-Path $PSScriptRoot 'build-worker-exe.ps1'
$powershellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($powershellPath)) {
    $powershellPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
}
if ([string]::IsNullOrWhiteSpace($powershellPath)) {
    throw 'Windows PowerShell was not found.'
}
if (-not (Test-Path -LiteralPath $workerExecutable -PathType Leaf)) {
    & $powershellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $workerBuildScript
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $workerExecutable -PathType Leaf)) {
        throw 'joy-worker.exe could not be built.'
    }
}
$stateDirectory = Split-Path -Parent $StatePath
New-Item -ItemType Directory -Force -Path (Join-Path $stateDirectory 'logs') | Out-Null

$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -ApiUrl "{1}" -StatePath "{2}" -WorkerExecutable "{3}"' -f $runnerPath, $ApiUrl, $StatePath, $workerExecutable
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $repoRoot
$userId = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.MultipleInstances = 'IgnoreNew'

function Get-WorkerProcessTreeIds {
    param([int[]]$RootIds)

    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    foreach ($rootId in $RootIds) {
        if ($seen.Add($rootId)) { $queue.Enqueue($rootId) }
    }
    while ($queue.Count -gt 0) {
        $parentId = $queue.Dequeue()
        foreach ($child in $allProcesses | Where-Object { $_.ParentProcessId -eq $parentId }) {
            $childId = [int]$child.ProcessId
            if ($seen.Add($childId)) { $queue.Enqueue($childId) }
        }
    }
    return @($seen)
}

function Get-WorkerRootIds {
    param(
        [string]$WorkerPath,
        [string]$EntryPoint
    )

    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $entryPointPattern = '(?i)(?<!\S)"?' + [regex]::Escape($EntryPoint) + '"?(?=\s|$)'
    $workerRootIds = @(
        $processes |
            Where-Object { $_.Name -eq 'joy-worker.exe' -and $_.CommandLine -eq ('"{0}"' -f $WorkerPath) } |
            ForEach-Object { [int]$_.ProcessId }
    )
    $nodeRootIds = @(
        $processes |
            Where-Object {
                ($_.Name -eq 'node.exe' -or $_.Name -eq 'node') -and
                -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
                $_.CommandLine -match $entryPointPattern
            } |
            ForEach-Object { [int]$_.ProcessId }
    )
    return @($workerRootIds + $nodeRootIds | Sort-Object -Unique)
}

function Get-WorkerProcessIds {
    param(
        [string]$WorkerPath,
        [string]$EntryPoint
    )

    $rootIds = @(Get-WorkerRootIds -WorkerPath $WorkerPath -EntryPoint $EntryPoint)
    if ($rootIds.Count -eq 0) { return @() }
    return @(Get-WorkerProcessTreeIds -RootIds $rootIds)
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Headless JOY Media local Worker; starts at Windows logon and reconnects to joyst.ir.' | Out-Null
} else {
    $workerProcessIds = @(Get-WorkerProcessIds -WorkerPath $workerExecutable -EntryPoint $entryPoint)
    if ($existing.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
            Start-Sleep -Milliseconds 250
            $state = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
            if ($state -ne 'Running') { break }
        }
        if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State -eq 'Running') {
            throw "Scheduled task '$TaskName' did not stop before replacement."
        }
    }

    # The SEA parent can disappear with the scheduled-task wrapper while its
    # fixed Node entrypoint child remains alive. Capture any late roots again
    # after stopping the task, then terminate the complete exact process set.
    $lateWorkerProcessIds = @(Get-WorkerProcessIds -WorkerPath $workerExecutable -EntryPoint $entryPoint)
    $workerProcessIds = @($workerProcessIds + $lateWorkerProcessIds | Sort-Object -Unique)
    foreach ($processId in ($workerProcessIds | Sort-Object -Descending -Unique)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
        $runningWorkerProcesses = @(Get-WorkerProcessIds -WorkerPath $workerExecutable -EntryPoint $entryPoint)
        if ($runningWorkerProcesses.Count -eq 0) { break }
        foreach ($processId in ($runningWorkerProcesses | Sort-Object -Descending -Unique)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 250
    }
    if (@(Get-WorkerProcessIds -WorkerPath $workerExecutable -EntryPoint $entryPoint).Count -gt 0) {
        throw "Worker process tree did not stop before replacement."
    }
    Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed hidden '$TaskName' for $userId."
Write-Output "Worker source: $repoRoot"
Write-Output "State file: $StatePath"
