# Runs one installer lifecycle sequence inside Windows Sandbox. The host launcher (sandbox-run.mjs) stages this folder
# read-only, writes session.json with the launch nonce, and starts this script from the sandbox logon command with
# JOY_MEDIA_SANDBOX_NONCE set. The sandbox discards its state when it closes, so each sequence runs to its end in one
# session, and every step is written to the writable evidence folder as it finishes.
param(
    [Parameter(Mandatory = $true)][ValidateSet('previous-upgrade-rollback', 'fresh-candidate')][string]$Sequence,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{32}$')][string]$SessionNonce
)

$ErrorActionPreference = 'Stop'
$stagingRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $stagingRoot 'disposable-environment.ps1')
# The gate reads the nonce from the environment, so the launch nonce is copied there before the check.
$env:JOY_MEDIA_SANDBOX_NONCE = $SessionNonce
$null = Assert-DisposableEnvironment 'Refusing to run the Windows Sandbox lifecycle outside a genuine sandbox session'

$evidenceDirectory = Join-Path (Join-Path $env:USERPROFILE 'Desktop\JOY-Evidence') $Sequence
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
Start-Transcript -Path (Join-Path $evidenceDirectory 'transcript.txt') -Force | Out-Null

$manifest = Get-Content -LiteralPath (Join-Path $stagingRoot 'manifest.json') -Raw | ConvertFrom-Json
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\JOY Media'
$binDirectory = Join-Path $installRoot 'bin'
# The version an update keeps beside the installed one, which a kept-previous rollback puts back.
$keptFolder = Join-Path (Split-Path -Parent $installRoot) 'JOY Media.previous'
$desktopShortcut = Join-Path $env:USERPROFILE 'Desktop\JOY Media.lnk'
$startMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\JOY Media.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia'
$steps = [System.Collections.Generic.List[object]]::new()
# Windows PowerShell 5.1 writes "utf8" with a byte order mark, and the host's JSON reader rejects that mark. The
# evidence is therefore written as UTF-8 without a mark.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Evidence([string]$Name, [string]$Text) {
    [System.IO.File]::WriteAllText((Join-Path $evidenceDirectory $Name), $Text, $utf8NoBom)
}

function Add-EvidenceLine([string]$Name, [string]$Line) {
    [System.IO.File]::AppendAllText((Join-Path $evidenceDirectory $Name), $Line + "`n", $utf8NoBom)
}

function Add-Step([string]$Name, [bool]$Passed, [string]$Detail) {
    $record = [pscustomobject]@{
        step = $Name
        status = $(if ($Passed) { 'passed' } else { 'failed' })
        detail = $Detail
        utcTime = [DateTime]::UtcNow.ToString('o')
    }
    $steps.Add($record)
    Add-EvidenceLine 'steps.jsonl' ($record | ConvertTo-Json -Compress)
}

function Get-Sha256Lower([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Runs a program with captured output and a time limit. The argument line is passed raw, because cmd.exe needs its
# own quoting. A program that outlives the limit is stopped. The process is started directly, not with Start-Process,
# because Windows PowerShell 5.1 returns a null ExitCode from Start-Process when output is redirected. A child that
# keeps an output pipe open cannot hold the run, because each read is bounded.
function Invoke-Program([string]$FilePath, [string]$ArgumentLine, [int]$TimeoutSeconds) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.Arguments = $ArgumentLine
    $start.WorkingDirectory = $stagingRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Could not start $FilePath" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch { }
        return [pscustomobject]@{ ExitCode = -1; Stdout = ''; Stderr = 'timed out' }
    }
    [void]$process.WaitForExit()
    $stdout = if ($stdoutTask.Wait(20000)) { $stdoutTask.Result } else { '' }
    $stderr = if ($stderrTask.Wait(20000)) { $stderrTask.Result } else { '' }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = [string]$stdout; Stderr = [string]$stderr }
}

# Keeps what a program printed, with its exit code, in the evidence folder, so a failed step can be read later.
function Save-ProgramOutput([string]$Label, $Run) {
    $fileName = 'output-' + (($Label -replace '[^A-Za-z0-9]+', '-').Trim('-')) + '.txt'
    Write-Evidence $fileName ("exit code: $($Run.ExitCode)`r`n--- stdout ---`r`n$($Run.Stdout)`r`n--- stderr ---`r`n$($Run.Stderr)`r`n")
}

# The end of a program's output on one line, for a step's detail.
function Get-OutputTail($Run) {
    $text = (([string]$Run.Stderr) + ' ' + ([string]$Run.Stdout)) -replace '\s+', ' '
    if ($text.Length -gt 400) { $text = $text.Substring($text.Length - 400) }
    return $text.Trim()
}

function Test-UserPathEntry([string]$Entry) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ([string]::IsNullOrWhiteSpace($userPath)) { return $false }
    foreach ($part in ($userPath -split ';')) {
        if ($part.TrimEnd('\') -ieq $Entry.TrimEnd('\')) { return $true }
    }
    return $false
}

function Get-RegisteredVersion {
    try { return [string](Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction Stop).DisplayVersion } catch { return $null }
}

function Get-InstalledFileProblems($Expected) {
    $problems = @()
    foreach ($file in $Expected) {
        $path = Join-Path $installRoot $file.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $problems += "$($file.path) is missing"; continue }
        if ((Get-Sha256Lower $path) -ne $file.sha256) { $problems += "$($file.path) differs from the manifest" }
    }
    return $problems
}

# Installs one version with the silent setup and checks its registration, shortcuts and installed files.
function Install-Version([string]$Name, $Build) {
    $setupPath = Join-Path $stagingRoot $Build.setup
    if ((Get-Sha256Lower $setupPath) -ne $Build.setupSha256) {
        Add-Step $Name $false 'the setup file does not match the manifest hash'
        return $false
    }
    $run = Invoke-Program $setupPath '/s' 900
    Save-ProgramOutput $Name $run
    if ($run.ExitCode -ne 0) {
        Add-Step $Name $false "setup exited with $($run.ExitCode): $(Get-OutputTail $run)"
        return $false
    }
    $problems = @()
    $registered = Get-RegisteredVersion
    if ($registered -ne $Build.version) { $problems += "registered version is '$registered'" }
    if (-not ((Test-Path -LiteralPath $desktopShortcut -PathType Leaf) -and (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf))) {
        $problems += 'a shortcut is missing'
    }
    $problems += Get-InstalledFileProblems $Build.installed
    $passed = $problems.Count -eq 0
    $detail = if ($passed) { "installed $($Build.version): registration, shortcuts and files match" } else { $problems -join '; ' }
    Add-Step $Name $passed $detail
    return $passed
}

# Rolls back with the candidate setup itself: the kept previous version is put back, and the candidate it replaces is kept
# beside it. Nothing is removed and reinstalled, so the user's PATH entries and shortcuts stay as the candidate left them.
function Invoke-KeptRollback([string]$Name) {
    $build = $manifest.candidate
    $setupPath = Join-Path $stagingRoot $build.setup
    if ((Get-Sha256Lower $setupPath) -ne $build.setupSha256) {
        Add-Step $Name $false 'the setup file does not match the manifest hash'
        return $false
    }
    $run = Invoke-Program $setupPath '/rollback' 900
    Save-ProgramOutput $Name $run
    if ($run.ExitCode -ne 0) {
        Add-Step $Name $false "rollback exited with $($run.ExitCode): $(Get-OutputTail $run)"
        return $false
    }
    $problems = @()
    $registered = Get-RegisteredVersion
    if ($registered -ne $manifest.previous.version) { $problems += "registered version is '$registered', not $($manifest.previous.version)" }
    $problems += Get-InstalledFileProblems $manifest.previous.installed
    if (-not (Test-Path -LiteralPath (Join-Path $keptFolder 'joy-media.exe') -PathType Leaf)) { $problems += 'the replaced version was not kept beside the restored one' }
    # The restored layout decides the user PATH entry: the bin folder for the bin layout, the install root before it.
    # A version without a bin folder must be listed under the root, and the bin entry must be gone.
    $pathEntries = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $binFolder = Join-Path $installRoot 'bin'
    $restoredHasBin = Test-Path -LiteralPath $binFolder -PathType Container
    $expectedEntry = if ($restoredHasBin) { $binFolder } else { $installRoot }
    $otherEntry = if ($restoredHasBin) { $installRoot } else { $binFolder }
    if (-not ($pathEntries | Where-Object { $_ -ieq $expectedEntry })) { $problems += "the user PATH does not list $expectedEntry for the restored version" }
    if ($pathEntries | Where-Object { $_ -ieq $otherEntry }) { $problems += "the user PATH still lists $otherEntry" }
    $passed = $problems.Count -eq 0
    $detail = if ($passed) { "rolled back to $($manifest.previous.version) and kept $($manifest.candidate.version) beside it; PATH follows the restored layout" } else { $problems -join '; ' }
    Add-Step $Name $passed $detail
    return $passed
}

# Holds one installed file open without sharing, as a running program does, and runs the candidate setup. The update
# must be refused, say the installation is in use, and leave both the installed version and the kept previous version.
function Test-HeldFileRefusal([string]$Name) {
    $build = $manifest.candidate
    $setupPath = Join-Path $stagingRoot $build.setup
    $heldPath = Join-Path $installRoot 'resources\app\cli\joy-media-bundle.mjs'
    $lock = [System.IO.File]::Open($heldPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    try {
        $run = Invoke-Program $setupPath '/s' 900
    } finally {
        $lock.Dispose()
    }
    Save-ProgramOutput $Name $run
    $problems = @()
    if ($run.ExitCode -eq 0) { $problems += 'the setup succeeded although a file was held' }
    if ($run.Stderr -notmatch 'in use') { $problems += 'the setup did not say that the installation was in use' }
    $registered = Get-RegisteredVersion
    if ($registered -ne $build.version) { $problems += "registered version changed to '$registered'" }
    $problems += Get-InstalledFileProblems $build.installed
    if (-not (Test-Path -LiteralPath (Join-Path $keptFolder 'joy-media.exe') -PathType Leaf)) { $problems += 'the kept previous version was lost' }
    $passed = $problems.Count -eq 0
    $detail = if ($passed) { 'the update was refused while a file was held; the installed and kept versions are unchanged' } else { $problems -join '; ' }
    Add-Step $Name $passed $detail
    return $passed
}

# The shipped CLI must refuse a manifest changed after signing, and a manifest whose signature no pinned key made. This
# build pins no release key, so both are refused as release-key-unconfigured. The owner-key pass expects signature-invalid
# (plan section 3.1). These are the same two cases as the CI lifecycle in tests/desktop/windows-lifecycle.ps1.
function Test-ShippedCliRefusals {
    $verifyRoot = Join-Path $env:TEMP 'joy-media-update-verify'
    New-Item -ItemType Directory -Path $verifyRoot -Force | Out-Null
    $releaseFile = Join-Path $verifyRoot 'joy-media-setup.exe'
    [System.IO.File]::WriteAllBytes($releaseFile, [byte[]](1..64))
    $releaseSha = Get-Sha256Lower $releaseFile
    $manifestText = '{"channel":"stable","version":"9.9.9","issuedAt":"2026-10-26T00:00:00Z","files":[{"name":"joy-media-setup.exe","size":64,"sha256":"' + $releaseSha + '"}]}'
    $cliCommand = Join-Path $binDirectory 'joy-media.cmd'
    $cases = @(
        @{ Name = 'shipped CLI refuses a manifest changed after signing'; Manifest = ($manifestText -replace '9\.9\.9', '9.9.8'); Signature = ('A' * 86) },
        @{ Name = 'shipped CLI refuses a manifest signed by no pinned key'; Manifest = $manifestText; Signature = ('B' * 86) }
    )
    foreach ($case in $cases) {
        if (-not (Test-Path -LiteralPath $cliCommand -PathType Leaf)) {
            Add-Step $case.Name $false 'bin\joy-media.cmd is missing from the install folder'
            continue
        }
        [System.IO.File]::WriteAllText((Join-Path $verifyRoot 'release-manifest.json'), $case.Manifest, $utf8NoBom)
        [System.IO.File]::WriteAllText((Join-Path $verifyRoot 'release-manifest.json.sig'), $case.Signature + "`n", $utf8NoBom)
        $run = Invoke-Program (Join-Path $env:SystemRoot 'System32\cmd.exe') ('/d /s /c ""' + $cliCommand + '" update verify "' + $releaseFile + '""') 300
        Save-ProgramOutput $case.Name $run
        $output = ([string]$run.Stdout) + ' ' + ([string]$run.Stderr)
        $passed = ($run.ExitCode -ne 0) -and ($output -match 'release-key-unconfigured|signature-invalid|trusts no release key')
        $detail = if ($passed) { 'refused with a key or signature reason' } else { "exit $($run.ExitCode): $(Get-OutputTail $run)" }
        Add-Step $case.Name $passed $detail
    }
}

function Test-Assertion([string]$Name, [bool]$Passed, [string]$Detail) {
    Add-Step $Name $Passed $Detail
    return $Passed
}

function Test-AppStart([string]$Name, [string]$Version) {
    # The supervisor starts the app, waits for the app and its processes to exit, and removes the profile it used.
    $nodeExe = Join-Path $stagingRoot 'node\node.exe'
    $supervisor = Join-Path $stagingRoot 'smoke-supervisor.mjs'
    # Chromium writes its startup log to the evidence folder, so a run that stalls shows how far startup got.
    $chromiumLog = Join-Path $evidenceDirectory ('chromium-' + (($Name -replace '[^A-Za-z0-9]+', '-').Trim('-')) + '.log')
    $supervisorArguments = '"' + $supervisor + '" --exe "' + (Join-Path $installRoot 'joy-media.exe') + '" --cwd "' + $installRoot + '" -- --smoke --enable-logging=file --log-file="' + $chromiumLog + '"'
    $smokeStarted = Get-Date
    # Diagnostics for a smoke run that does not finish: every 10 seconds, the smoke processes and the smoke profile folders
    # are recorded, so a run that stalls shows whether the app ever started and whether it is busy or idle.
    $watchName = 'smoke-watch-' + (($Name -replace '[^A-Za-z0-9]+', '-').Trim('-')) + '.txt'
    $watch = $null
    try {
        $watch = Start-Job -ScriptBlock {
            param($file, $tempFolder)
            for ($tick = 0; $tick -lt 36; $tick++) {
                $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(node|joy-media|joy-worker|powershell)$' } | ForEach-Object { '{0}#{1} cpu={2:N1}s' -f $_.ProcessName, $_.Id, $_.TotalProcessorTime.TotalSeconds })
                $profiles = @(Get-ChildItem -LiteralPath $tempFolder -Directory -Filter 'joy-media-smoke-*' -ErrorAction SilentlyContinue).Count
                $threadLines = @(Get-Process -Name 'joy-media' -ErrorAction SilentlyContinue | ForEach-Object { $proc = $_; $states = @($proc.Threads | ForEach-Object { if ($_.ThreadState -eq 'Wait') { 'Wait/' + $_.WaitReason } else { [string]$_.ThreadState } }); 'joy-media#' + $proc.Id + ' ' + (($states | Group-Object | ForEach-Object { $_.Name + 'x' + $_.Count }) -join ',') })
                if ($tick -eq 1) {
                    $moduleNames = @(Get-Process -Name 'joy-media' -ErrorAction SilentlyContinue | ForEach-Object { $_.Modules | ForEach-Object { $_.FileName } })
                    [System.IO.File]::WriteAllText(($file + '.modules.txt'), (($moduleNames -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
                }
                $encoding = [System.Text.UTF8Encoding]::new($false)
                [System.IO.File]::AppendAllText($file, ((Get-Date).ToUniversalTime().ToString('o') + ' profiles=' + $profiles + ' ' + ($processes -join ' | ') + ' threads: ' + ($threadLines -join ' | ')) + "`n", $encoding)
                Start-Sleep -Seconds 10
            }
        } -ArgumentList (Join-Path $evidenceDirectory $watchName), $env:TEMP
    } catch {
        $watch = $null
    }
    try {
        $run = Invoke-Program $nodeExe $supervisorArguments 300
    } finally {
        if ($null -ne $watch) {
            Stop-Job -Job $watch -ErrorAction SilentlyContinue
            Remove-Job -Job $watch -Force -ErrorAction SilentlyContinue
        }
    }
    # Windows' own records of a hang or crash of the app in the same window of time.
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $smokeStarted; Id = 1000, 1001, 1002 } -ErrorAction SilentlyContinue | Select-Object -First 30)
        $eventLines = @($events | ForEach-Object { $_.TimeCreated.ToUniversalTime().ToString('o') + ' id=' + $_.Id + ' provider=' + $_.ProviderName + ' ' + (([string]$_.Message) -split "`r?`n" | Select-Object -First 1) })
        [System.IO.File]::WriteAllText((Join-Path $evidenceDirectory ('app-events-' + (($Name -replace '[^A-Za-z0-9]+', '-').Trim('-')) + '.txt')), (($eventLines -join "`n") + "`n"), $utf8NoBom)
    } catch {
        # The event log is diagnostics only; a failure here must not change the smoke result.
    }
    Save-ProgramOutput "smoke $Name" $run
    $passed = ($run.ExitCode -eq 0) -and ($run.Stdout -match '\[joy-desktop\] packaged renderer smoke passed') -and ($run.Stderr -notmatch '\[joy-desktop\] packaged renderer smoke failed')
    $detail = if ($passed) { "the application starts and passes its renderer smoke ($Version)" } else { "smoke exit $($run.ExitCode) for ${Version}: $(Get-OutputTail $run)" }
    Add-Step "application starts: $Name" $passed $detail
    # The profile must be gone from the temp folder once the supervisor has finished.
    $leftoverProfiles = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'joy-media-smoke-*' -ErrorAction SilentlyContinue).Count
    Add-Step "no smoke profile is left in temp: $Name" ($leftoverProfiles -eq 0) "$leftoverProfiles smoke profile folder(s) left in the temp folder"
    # A smoke run should leave no worker behind. A worker that outlives the app can also hold files in the profile.
    $workers = @(Get-Process -Name 'joy-worker' -ErrorAction SilentlyContinue).Count
    Add-Step "no worker outlives the smoke run: $Name" ($workers -eq 0) "$workers joy-worker process(es) still running after the app exited"
    return $passed
}

function Test-FreshShellCli([string]$Version) {
    $savedPath = $env:Path
    try {
        # A new shell builds its PATH from the registry, so this sees only what the installer registered.
        $env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine')) | Where-Object { $_ }) -join ';'
        foreach ($launcher in @('joy-media', 'joy')) {
            $run = Invoke-Program (Join-Path $env:SystemRoot 'System32\cmd.exe') ('/d /s /c "' + $launcher + ' --version"') 120
            Save-ProgramOutput "fresh shell $launcher $Version" $run
            $passed = ($run.ExitCode -eq 0) -and ($run.Stdout -match [regex]::Escape($Version))
            $detail = if ($passed) { "a fresh shell ran $launcher --version and reported $Version" } else { "fresh-shell exit $($run.ExitCode); output did not report ${Version}: $(Get-OutputTail $run)" }
            Add-Step "fresh shell runs $launcher --version" $passed $detail
        }
    } finally {
        $env:Path = $savedPath
    }
}

function Invoke-Uninstall([string]$Name) {
    $uninstaller = Join-Path $installRoot 'uninstall.cmd'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        Add-Step $Name $false 'uninstall.cmd is missing from the install folder'
        return
    }
    $run = Invoke-Program (Join-Path $env:SystemRoot 'System32\cmd.exe') ('/d /s /c ""' + $uninstaller + '""') 120
    Save-ProgramOutput $Name $run
    # The uninstaller deletes the install folder in the background after it returns, so wait for that.
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $keptFolder)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    $problems = @()
    if ($run.ExitCode -ne 0) { $problems += "uninstall.cmd exited with $($run.ExitCode): $(Get-OutputTail $run)" }
    if (Test-Path -LiteralPath $installRoot) { $problems += 'the install folder remained' }
    if (Test-Path -LiteralPath $uninstallKey) { $problems += 'the uninstall key remained' }
    if ((Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $startMenuShortcut)) { $problems += 'a shortcut remained' }
    if (Test-UserPathEntry $installRoot) { $problems += 'the install root remained on the user PATH' }
    if (Test-UserPathEntry $binDirectory) { $problems += 'the bin folder remained on the user PATH' }
    # The uninstaller must leave no kept or staging folder beside the install folder.
    if (Test-Path -LiteralPath $keptFolder) { $problems += 'the kept previous folder remained' }
    $siblings = @(Get-ChildItem -LiteralPath (Split-Path -Parent $installRoot) -Directory -Filter 'JOY Media*' -ErrorAction SilentlyContinue)
    if ($siblings.Count -gt 0) { $problems += 'a JOY Media folder remained beside the install: ' + (($siblings | ForEach-Object { $_.Name }) -join ', ') }
    $passed = $problems.Count -eq 0
    $detail = if ($passed) { 'the folder, key, shortcuts and both PATH entries are gone' } else { $problems -join '; ' }
    Add-Step $Name $passed $detail
    return $passed
}

try {
    if ($Sequence -eq 'previous-upgrade-rollback') {
        if (Install-Version 'install previous version' $manifest.previous) {
            Test-Assertion 'previous layout registers the install root (v1.0.1 behaviour)' (Test-UserPathEntry $installRoot) 'the previous installer adds the install root to the user PATH' | Out-Null
            Test-AppStart 'previous' $manifest.previous.version | Out-Null
            if (Install-Version 'upgrade to candidate' $manifest.candidate) {
                $pathDetail = 'bin is on the user PATH and the install root is not'
                Test-Assertion 'candidate PATH holds only bin' ((Test-UserPathEntry $binDirectory) -and -not (Test-UserPathEntry $installRoot)) $pathDetail | Out-Null
                Test-FreshShellCli $manifest.candidate.version
                Test-AppStart 'candidate after upgrade' $manifest.candidate.version | Out-Null
                # Repair: remove an installed file, then run the candidate setup again, which must restore it.
                Remove-Item -LiteralPath (Join-Path $installRoot 'resources\app\cli\joy-media-bundle.mjs') -Force
                if (Install-Version 'repair restores a removed CLI bundle' $manifest.candidate) {
                    # Kept-previous rollback (L1): the candidate setup puts back the version its last update kept, and keeps
                    # the candidate beside it. Then the previous version starts, and the candidate is installed again so the
                    # held-file refusal and the final uninstall run against the candidate.
                    if (Invoke-KeptRollback 'roll back to the kept previous version') {
                        Test-AppStart 'previous after kept rollback' $manifest.previous.version | Out-Null
                        if (Install-Version 'upgrade again after rollback' $manifest.candidate) {
                            Test-HeldFileRefusal 'update refused while a file is held'
                            Test-AppStart 'candidate after the refused update' $manifest.candidate.version | Out-Null
                            Test-ShippedCliRefusals
                        }
                    }
                }
            }
        }
        if (Test-Path -LiteralPath $installRoot) { Invoke-Uninstall 'uninstall the rolled-back install' }
    } else {
        if (Install-Version 'fresh install of candidate' $manifest.candidate) {
            Test-Assertion 'fresh candidate PATH holds only bin' ((Test-UserPathEntry $binDirectory) -and -not (Test-UserPathEntry $installRoot)) 'bin is on the user PATH and the install root is not' | Out-Null
            Test-FreshShellCli $manifest.candidate.version
            Test-AppStart 'candidate fresh install' $manifest.candidate.version | Out-Null
        }
        if (Test-Path -LiteralPath $installRoot) { Invoke-Uninstall 'uninstall the candidate with its own uninstaller' }
    }
} catch {
    Add-Step 'sequence error' $false $_.Exception.Message
} finally {
    try {
        $passedCount = @($steps | Where-Object { $_.status -eq 'passed' }).Count
        $summary = [pscustomobject]@{
            sequence = $Sequence
            environment = 'windows-sandbox'
            passed = $passedCount
            failed = $steps.Count - $passedCount
            steps = $steps
            completedUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-Evidence 'summary.json' (($summary | ConvertTo-Json -Depth 6) + "`n")
    } finally {
        # done.json is written last, so the host reads the summary only once it is complete.
        Write-Evidence 'done.json' (([pscustomobject]@{ status = 'completed'; sequence = $Sequence } | ConvertTo-Json -Compress) + "`n")
        try { Stop-Transcript | Out-Null } catch { }
    }
}
