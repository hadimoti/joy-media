# Runs one installer lifecycle sequence inside Windows Sandbox. The host launcher (run-windows-sandbox-lifecycle.mjs)
# stages this folder read-only, writes session.json with the launch nonce, and starts this script from the sandbox
# logon command with JOY_MEDIA_SANDBOX_NONCE set. The sandbox discards its state when it closes, so each sequence
# runs to its end in one session, and every step is written to the writable evidence folder as it finishes.
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
$desktopShortcut = Join-Path $env:USERPROFILE 'Desktop\JOY Media.lnk'
$startMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\JOY Media.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia'
$steps = [System.Collections.Generic.List[object]]::new()

function Add-Step([string]$Name, [bool]$Passed, [string]$Detail) {
    $record = [pscustomobject]@{
        step = $Name
        status = $(if ($Passed) { 'passed' } else { 'failed' })
        detail = $Detail
        utcTime = [DateTime]::UtcNow.ToString('o')
    }
    $steps.Add($record)
    Add-Content -LiteralPath (Join-Path $evidenceDirectory 'steps.jsonl') -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
}

function Get-Sha256Lower([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Runs a program with captured output and a time limit. The argument line is passed raw, because cmd.exe needs its
# own quoting. A program that outlives the limit is stopped.
function Invoke-Program([string]$FilePath, [string]$ArgumentLine, [int]$TimeoutSeconds) {
    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentLine -WorkingDirectory $stagingRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            return [pscustomobject]@{ ExitCode = -1; Stdout = ''; Stderr = 'timed out' }
        }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = [string](Get-Content -LiteralPath $stdoutPath -Raw)
            Stderr = [string](Get-Content -LiteralPath $stderrPath -Raw)
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
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
    if ($run.ExitCode -ne 0) {
        Add-Step $Name $false "setup exited with $($run.ExitCode)"
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

function Test-Assertion([string]$Name, [bool]$Passed, [string]$Detail) {
    Add-Step $Name $Passed $Detail
    return $Passed
}

function Test-AppStart([string]$Name, [string]$Version) {
    $smokeProfile = Join-Path $env:TEMP "joy-smoke-$Sequence-$Name"
    $run = Invoke-Program (Join-Path $installRoot 'joy-media.exe') ('--smoke --user-data-dir="' + $smokeProfile + '"') 180
    $passed = ($run.ExitCode -eq 0) -and ($run.Stdout -match '\[joy-desktop\] packaged renderer smoke passed') -and ($run.Stderr -notmatch '\[joy-desktop\] packaged renderer smoke failed')
    $detail = if ($passed) { "the application starts and passes its renderer smoke ($Version)" } else { "smoke exit $($run.ExitCode) for $Version" }
    Add-Step "application starts: $Name" $passed $detail
    return $passed
}

function Test-FreshShellCli([string]$Version) {
    $savedPath = $env:Path
    try {
        # A new shell builds its PATH from the registry, so this sees only what the installer registered.
        $env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine')) | Where-Object { $_ }) -join ';'
        $run = Invoke-Program (Join-Path $env:SystemRoot 'System32\cmd.exe') '/d /s /c "joy-media --version"' 120
    } finally {
        $env:Path = $savedPath
    }
    $passed = ($run.ExitCode -eq 0) -and ($run.Stdout -match [regex]::Escape($Version))
    $detail = if ($passed) { "a fresh shell ran joy-media --version and reported $Version" } else { "fresh-shell exit $($run.ExitCode); output did not report $Version" }
    Add-Step 'fresh shell runs joy-media --version' $passed $detail
}

function Invoke-Uninstall([string]$Name) {
    $uninstaller = Join-Path $installRoot 'uninstall.cmd'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        Add-Step $Name $false 'uninstall.cmd is missing from the install folder'
        return
    }
    $run = Invoke-Program (Join-Path $env:SystemRoot 'System32\cmd.exe') ('/d /s /c ""' + $uninstaller + '""') 120
    # The uninstaller deletes the install folder in the background after it returns, so wait for that.
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ((Test-Path -LiteralPath $installRoot) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    $problems = @()
    if ($run.ExitCode -ne 0) { $problems += "uninstall.cmd exited with $($run.ExitCode)" }
    if (Test-Path -LiteralPath $installRoot) { $problems += 'the install folder remained' }
    if (Test-Path -LiteralPath $uninstallKey) { $problems += 'the uninstall key remained' }
    if ((Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $startMenuShortcut)) { $problems += 'a shortcut remained' }
    if (Test-UserPathEntry $installRoot) { $problems += 'the install root remained on the user PATH' }
    if (Test-UserPathEntry $binDirectory) { $problems += 'the bin folder remained on the user PATH' }
    $passed = $problems.Count -eq 0
    $detail = if ($passed) { 'the folder, key, shortcuts and both PATH entries are gone' } else { $problems -join '; ' }
    Add-Step $Name $passed $detail
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
                    # Rollback: the previous setup runs over the candidate install.
                    if (Install-Version 'roll back to previous version' $manifest.previous) {
                        Test-AppStart 'previous after rollback' $manifest.previous.version | Out-Null
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
    $passedCount = @($steps | Where-Object { $_.status -eq 'passed' }).Count
    $summary = [pscustomobject]@{
        sequence = $Sequence
        environment = 'windows-sandbox'
        passed = $passedCount
        failed = $steps.Count - $passedCount
        steps = $steps
        completedUtc = [DateTime]::UtcNow.ToString('o')
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'summary.json') -Encoding utf8
    [pscustomobject]@{ status = 'completed'; sequence = $Sequence } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'done.json') -Encoding utf8
    try { Stop-Transcript | Out-Null } catch { }
}
