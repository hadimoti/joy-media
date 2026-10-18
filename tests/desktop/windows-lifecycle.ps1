[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$CandidateSha,
    [Parameter(Mandatory = $true)][string]$CandidateSetupPath,
    [Parameter(Mandatory = $true)][string]$CandidateArchivePath,
    [Parameter(Mandatory = $true)][string]$CandidateStandalonePath,
    [Parameter(Mandatory = $true)][string]$PreviousSetupPath,
    [Parameter(Mandatory = $true)][string]$PreviousArchivePath,
    [Parameter(Mandatory = $true)][string]$PreviousChecksumsPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]+$')][string]$RunId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[1-9][0-9]*$')][string]$Attempt,
    [Parameter(Mandatory = $true)][ValidateSet('1', '2')][string]$Pass
)

$ErrorActionPreference = 'Stop'
$PreviousVersion = '1.0.1'
$PreviousSetupSha256 = '3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04'
$PreviousChecksumsSha256 = 'a7b933f44ec82edd2f166dcde0bb013e1febd0ebbd19aa42dd49ac8e05adfe32'
$PreviousArchiveSha256 = '21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c'
$script:ownedInstall = $false
$script:commands = [System.Collections.Generic.List[object]]::new()
$script:cliStateDirectories = [System.Collections.Generic.List[string]]::new()

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required artifact is missing: $Path" }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected) { throw "$Label SHA-256 mismatch" }
    return $actual
}

function Test-Sha256([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    return (Get-Sha256 $Path) -eq $Expected
}

function ConvertTo-WindowsArgument([string]$Value) {
    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            if ($slashes -gt 0) { [void]$builder.Append('\' * ($slashes * 2)) }
            [void]$builder.Append('\"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append('\' * $slashes) }
        [void]$builder.Append($character)
        $slashes = 0
    }
    if ($slashes -gt 0) { [void]$builder.Append('\' * ($slashes * 2)) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Get-SafeEnvironment([hashtable]$Overrides = @{}) {
    $names = @(
        'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
        'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH',
        'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PNPM_HOME',
        'COREPACK_HOME', 'COREPACK_ROOT', 'NPM_CONFIG_USERCONFIG'
    )
    $environment = @{}
    foreach ($name in $names) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrEmpty($value)) { $environment[$name] = $value }
    }
    foreach ($key in $Overrides.Keys) { $environment[$key] = [string]$Overrides[$key] }
    if (-not $environment.SystemRoot -or -not $environment.PATH -or -not $environment.TEMP -or -not $environment.USERPROFILE) {
        throw 'The Windows runner process is missing required system or profile environment.'
    }
    $environment['JOY_MEDIA_EDGE_URL'] = 'off'
    return $environment
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [string]$WorkingDirectory = $PWD.Path,
        [hashtable]$Environment = (Get-SafeEnvironment),
        [string]$RawArguments
    )

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    if (-not [string]::IsNullOrEmpty($RawArguments)) {
        $start.Arguments = $RawArguments
    } else {
        $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' ')
    }
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear()
    foreach ($key in $Environment.Keys) { $start.EnvironmentVariables[[string]$key] = [string]$Environment[$key] }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Could not start required command: $FilePath" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch { }
        [void]$process.WaitForExit(10000)
        throw "Command exceeded its ${TimeoutSeconds}s limit: $([IO.Path]::GetFileName($FilePath))"
    }
    [void]$process.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.Result
        Stderr = $stderrTask.Result
    }
}

function Get-CommandFailureSummary($Result) {
    $combined = @($Result.Stdout, $Result.Stderr) -join "`n"
    $lines = @($combined -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    if ($lines.Count -gt 16) { $lines = $lines[($lines.Count - 16)..($lines.Count - 1)] }
    return ($lines -join "`n")
}

function Invoke-Pnpm(
    [string]$Name,
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 900,
    [hashtable]$EnvironmentOverrides = @{}
) {
    $pnpmCommand = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $command = 'pnpm.cmd ' + ($Arguments -join ' ')
    $environment = @{ CI = 'true' }
    foreach ($key in $EnvironmentOverrides.Keys) { $environment[$key] = [string]$EnvironmentOverrides[$key] }
    $result = Invoke-CapturedProcess -FilePath $pnpmCommand -RawArguments "/d /c $command" -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $repoRoot -Environment (Get-SafeEnvironment $environment)
    $script:commands.Add([pscustomobject]@{ name = $Name; exitCode = $result.ExitCode })
    if ($result.ExitCode -ne 0) { throw "$Name failed with exit code $($result.ExitCode): $(Get-CommandFailureSummary $result)" }
    return $result
}

function Get-ChecksummedFile([string]$ChecksumsText, [string]$FileName) {
    $escaped = [regex]::Escape($FileName)
    $matches = @([regex]::Matches($ChecksumsText, "(?m)^([0-9a-f]{64})  $escaped\s*$"))
    if ($matches.Count -ne 1) { throw "Release checksum file does not contain exactly one entry for $FileName" }
    return $matches[0].Groups[1].Value
}

function Assert-RegisteredVersion([string]$ExpectedVersion) {
    $key = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia'
    $entry = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
    if ($entry.DisplayVersion -ne $ExpectedVersion) { throw "Installed version registration mismatch for $ExpectedVersion" }
    if ($entry.DisplayName -ne 'JOY Media') { throw 'Installer registration display name is incorrect.' }
    if ([IO.Path]::GetFullPath($entry.InstallLocation).TrimEnd('\') -ine [IO.Path]::GetFullPath($installRoot).TrimEnd('\')) {
        throw 'Installer registration points outside the expected isolated install directory.'
    }
}

function Invoke-VerifiedSetup([string]$Path, [string]$ExpectedSha, [string]$ExpectedVersion) {
    if (-not (Test-Sha256 $Path $ExpectedSha)) { throw "Setup preflight rejected an artifact hash mismatch for expected version $ExpectedVersion" }
    $script:setupLaunchCount++
    $result = Invoke-CapturedProcess -FilePath $Path -Arguments @('/s') -TimeoutSeconds 900 -WorkingDirectory $runnerTemp -Environment (Get-SafeEnvironment)
    if ($result.ExitCode -ne 0) { throw "Setup for $ExpectedVersion failed with exit code $($result.ExitCode)." }
    Assert-RegisteredVersion $ExpectedVersion
    return $result
}

function Get-InstalledFileHash([string]$RelativePath) {
    return Get-Sha256 (Join-Path $installRoot $RelativePath)
}

function Assert-UserIntegrations([string]$Version) {
    Assert-RegisteredVersion $Version
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $installRoot.TrimEnd('\') })) {
        throw 'Installer did not register the isolated install path for the current test user.'
    }
    if (-not (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)) { throw 'Desktop shortcut was not created.' }
    if (-not (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf)) { throw 'Start Menu shortcut was not created.' }
}

function Invoke-AppSmoke([string]$Label) {
    $result = Invoke-CapturedProcess -FilePath (Join-Path $installRoot 'joy-media.exe') -Arguments @('--smoke', "--user-data-dir=$userDataDirectory") -TimeoutSeconds 120 -WorkingDirectory $installRoot -Environment (Get-SafeEnvironment @{ NODE_ENV = 'production' })
    $script:commands.Add([pscustomobject]@{ name = "desktop app smoke $Label"; exitCode = $result.ExitCode })
    if ($result.ExitCode -ne 0 -or $result.Stdout -notmatch '\[joy-desktop\] packaged renderer smoke passed' -or $result.Stderr -match '\[joy-desktop\] packaged renderer smoke failed') {
        throw "Installed desktop smoke failed at $Label. $(Get-CommandFailureSummary $result)"
    }
}

function Invoke-LifecycleFixture([string]$ElectronPath, [string]$Mode) {
    $result = Invoke-CapturedProcess -FilePath $ElectronPath -Arguments @('--run-as-node', $lifecycleFixture, "--user-data-dir=$userDataDirectory", $Mode) -TimeoutSeconds 60 -WorkingDirectory $repoRoot -Environment (Get-SafeEnvironment @{ NODE_ENV = 'production' })
    if ($result.ExitCode -ne 0) { throw "DPAPI user-data fixture $Mode failed: $(Get-CommandFailureSummary $result)" }
    try { return ($result.Stdout.Trim() | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "DPAPI user-data fixture $Mode did not return valid evidence JSON." }
}

function Invoke-InstalledCliAcceptance([string]$LauncherName, [string]$StateSuffix) {
    $launcher = Join-Path $installRoot $LauncherName
    $stateName = "joy-media-installed-cli-$RunId-$Attempt-p$Pass-$StateSuffix"
    $stateDirectory = Join-Path $env:TEMP $stateName
    if ((Split-Path -Parent $stateDirectory).TrimEnd('\') -ine $env:TEMP.TrimEnd('\')) { throw 'Installed CLI test state escaped the OS temp directory.' }
    if (Test-Path -LiteralPath $stateDirectory) { throw "Installed CLI state already exists: $stateName" }
    $script:cliStateDirectories.Add($stateDirectory)
    $evidenceDirectory = Join-Path $stateDirectory 'evidence'
    $result = Invoke-CapturedProcess -FilePath $nodePath -Arguments @($installedCliAcceptance, $launcher, $stateDirectory, $evidenceDirectory) -TimeoutSeconds 900 -WorkingDirectory $repoRoot -Environment (Get-SafeEnvironment @{ NODE_ENV = 'production' })
    $script:commands.Add([pscustomobject]@{ name = "installed CLI acceptance $LauncherName"; exitCode = $result.ExitCode })
    if ($result.ExitCode -ne 0) { throw "Installed CLI acceptance for $LauncherName failed: $(Get-CommandFailureSummary $result)" }
    $evidencePath = Join-Path $evidenceDirectory 'installed-cli-acceptance.json'
    try { $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "Installed CLI acceptance for $LauncherName did not write evidence." }
    if ($evidence.sourceHead -ne $CandidateSha -or $evidence.result -ne 'passed') { throw "Installed CLI acceptance for $LauncherName has mismatched source provenance." }
    if ($evidence.videoCodec -ne 'h264' -or $evidence.audioCodec -ne 'aac' -or [double]$evidence.durationSeconds -lt 2.9) { throw "Installed CLI acceptance for $LauncherName did not produce decoded H.264/AAC media." }
    if ($evidence.desktopExecutableSha256 -ne $candidateDesktopExeSha -or $evidence.cliBundleSha256 -ne $candidateCliBundleSha -or $evidence.workerExecutableSha256 -ne $candidateWorkerSha) {
        throw "Installed CLI acceptance for $LauncherName used package files that do not match the frozen candidate."
    }
    return [ordered]@{
        status = 'passed'
        launcher = $LauncherName
        launcherSha256 = Get-Sha256 $launcher
        desktopExecutableSha256 = $evidence.desktopExecutableSha256
        cliBundleSha256 = $evidence.cliBundleSha256
        workerExecutableSha256 = $evidence.workerExecutableSha256
        renderedMediaSha256 = $evidence.mediaSha256
        videoCodec = $evidence.videoCodec
        audioCodec = $evidence.audioCodec
        durationSeconds = [double]$evidence.durationSeconds
    }
}

function Assert-NoOwnedProcesses {
    $owned = @()
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if (-not $process.CommandLine) { continue }
        if ($process.CommandLine.Contains($workRoot, [StringComparison]::OrdinalIgnoreCase) -or $process.CommandLine.Contains($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
            if ($process.Name -match '^(joy-media|joy-worker|ffmpeg|electron)\.exe$') { $owned += $process }
        }
    }
    if ($owned.Count -gt 0) { throw 'A JOY Media, Worker, Electron, or FFmpeg process still references this lifecycle run.' }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = $nodeCommand.Source
$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($null -eq $pnpmCommand) { $pnpmCommand = Get-Command pnpm -ErrorAction Stop }
$lifecycleFixture = Join-Path $repoRoot 'tests\desktop\lifecycle-user-data.mjs'
$installedCliAcceptance = Join-Path $repoRoot 'tests\desktop\installed-cli-acceptance.mjs'
$desktopManifestPath = Join-Path $repoRoot 'apps\desktop\package.json'
$cliManifestPath = Join-Path $repoRoot 'apps\cli\package.json'
$releaseManifestPath = Join-Path (Split-Path -Parent $CandidateSetupPath) 'joy-media-release-manifest.json'
$checksumsPath = Join-Path (Split-Path -Parent $CandidateSetupPath) 'SHA256SUMS.txt'
$candidateManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
$desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw | ConvertFrom-Json
$cliManifest = Get-Content -LiteralPath $cliManifestPath -Raw | ConvertFrom-Json
$candidateVersion = [string]$desktopManifest.version
$sourceHead = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceHead -ne $CandidateSha) { throw 'Windows lifecycle checkout does not match the requested candidate SHA.' }
if ((& git -C $repoRoot status --porcelain).Trim()) { throw 'Windows lifecycle checkout is not clean before generated artifacts.' }
if ($desktopManifest.version -ne $cliManifest.version -or $candidateManifest.version -ne $candidateVersion -or $candidateManifest.targetCommit -ne $CandidateSha) {
    throw 'Desktop, CLI, release manifest, and frozen candidate identities do not match.'
}

$containerId = $env:JOY_MEDIA_WINDOWS_CONTAINER_ID
$imageDigest = $env:JOY_MEDIA_WINDOWS_IMAGE_DIGEST
if ($containerId -notmatch '^[0-9a-f]{12,64}$' -or $imageDigest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'A verified Docker Windows runner container id and image digest are required.'
}
if ($env:USERPROFILE -match '(?i)HadiMoti') { throw 'Refusing to install into the owner Windows profile.' }
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) { throw 'RUNNER_TEMP must identify the isolated self-hosted runner temp directory.' }
$runnerTemp = (Resolve-Path $env:RUNNER_TEMP).Path
$outputAbsolute = [IO.Path]::GetFullPath($OutputPath)
if (-not $outputAbsolute.StartsWith($runnerTemp.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Lifecycle evidence output must remain inside RUNNER_TEMP.' }
if (Test-Path -LiteralPath $outputAbsolute) { throw 'Lifecycle evidence output already exists.' }

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$installRoot = Join-Path $localAppData 'Programs\JOY Media'
if ([IO.Path]::GetFullPath($localAppData).StartsWith([IO.Path]::GetFullPath($env:SystemRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'The runner profile resolves inside the Windows system directory.' }
if (Test-Path -LiteralPath $installRoot) { throw 'Refusing to overwrite a pre-existing JOY Media installation in the runner profile.' }
$workRoot = Join-Path $runnerTemp "joy-media-installed-lifecycle-$RunId-$Attempt-p$Pass"
if (Test-Path -LiteralPath $workRoot) { throw 'Lifecycle temp root already exists.' }
$userDataDirectory = Join-Path $workRoot 'profile\Roaming\JOY Media Lifecycle Fixture'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'JOY Media.lnk'
$startMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\JOY Media.lnk'
$startedAt = [DateTime]::UtcNow.ToString('o')
$candidateArchive = Get-Sha256 $CandidateArchivePath
$candidateSetup = Get-Sha256 $CandidateSetupPath
$previousSetup = Assert-Sha256 $PreviousSetupPath $PreviousSetupSha256 'Pinned v1.0.1 setup'
$previousArchive = Assert-Sha256 $PreviousArchivePath $PreviousArchiveSha256 'Pinned v1.0.1 portable archive'
$previousChecksums = Assert-Sha256 $PreviousChecksumsPath $PreviousChecksumsSha256 'Pinned v1.0.1 SHA256SUMS'
$candidateArchiveArtifact = @($candidateManifest.artifacts | Where-Object { $_.type -eq 'portable-archive' })
if ($candidateArchiveArtifact.Count -ne 1 -or [IO.Path]::GetFullPath($CandidateArchivePath) -ine [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $CandidateSetupPath) $candidateArchiveArtifact[0].fileName))) {
    throw 'Candidate portable archive does not match the release manifest.'
}
Assert-Sha256 $CandidateArchivePath ([string]$candidateArchiveArtifact[0].sha256) 'Candidate portable archive' | Out-Null
$candidateDesktopExeRecord = @($candidateManifest.artifacts | Where-Object { $_.fileName -eq 'joy-media.exe' })
$candidateCliBundleRecord = @($candidateManifest.artifacts | Where-Object { $_.fileName -eq 'joy-media-bundle.mjs' })
$candidateWorkerRecord = @($candidateManifest.artifacts | Where-Object { $_.fileName -eq 'joy-worker.exe' })
if ($candidateDesktopExeRecord.Count -ne 1 -or $candidateCliBundleRecord.Count -ne 1 -or $candidateWorkerRecord.Count -ne 1) { throw 'Candidate release manifest is missing an app, CLI, or Worker artifact record.' }
$candidateDesktopExeSha = Assert-Sha256 (Join-Path $CandidateStandalonePath 'joy-media.exe') ([string]$candidateDesktopExeRecord[0].sha256) 'Candidate desktop executable'
$candidateCliBundleSha = Assert-Sha256 (Join-Path $CandidateStandalonePath 'resources\app\cli\joy-media-bundle.mjs') ([string]$candidateCliBundleRecord[0].sha256) 'Candidate CLI bundle'
$candidateWorkerSha = Assert-Sha256 (Join-Path $CandidateStandalonePath 'resources\app\worker\joy-worker.exe') ([string]$candidateWorkerRecord[0].sha256) 'Candidate Worker executable'
$candidateChecksumsText = Get-Content -LiteralPath $checksumsPath -Raw
$candidateArchiveName = "joy-media-windows-x64-v$candidateVersion.zip"
if ((Get-ChecksummedFile $candidateChecksumsText $candidateArchiveName) -ne $candidateArchive) { throw 'Candidate archive checksum sidecar does not match.' }
if ((Get-ChecksummedFile $candidateChecksumsText 'joy-media.exe') -ne $candidateDesktopExeSha -or (Get-ChecksummedFile $candidateChecksumsText 'joy-media-bundle.mjs') -ne $candidateCliBundleSha -or (Get-ChecksummedFile $candidateChecksumsText 'joy-worker.exe') -ne $candidateWorkerSha) {
    throw 'Candidate SHA256SUMS.txt does not match the exact app, CLI, Worker, and archive files.'
}
if ($candidateSetup.Length -ne 64) { throw 'Candidate setup hash is malformed.' }
$previousChecksumsText = Get-Content -LiteralPath $PreviousChecksumsPath -Raw
if ((Get-ChecksummedFile $previousChecksumsText 'joy-media-windows-x64-v1.0.1.zip') -ne $previousArchive) { throw 'Pinned v1.0.1 portable archive hash does not match the downloaded archive.' }
$previousDesktopExeSha = Get-ChecksummedFile $previousChecksumsText 'joy-media.exe'
$previousCliBundleSha = Get-ChecksummedFile $previousChecksumsText 'joy-media-bundle.mjs'
$nodeVersionResult = Invoke-CapturedProcess -FilePath $nodePath -Arguments @('--version') -TimeoutSeconds 30 -WorkingDirectory $repoRoot -Environment (Get-SafeEnvironment)
if ($nodeVersionResult.ExitCode -ne 0) { throw 'Could not establish the Windows Node.js toolchain version.' }
$pnpmVersionResult = Invoke-Pnpm 'pnpm toolchain version' @('--version') 60
$electronPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'apps\desktop\node_modules\electron\package.json') -Raw | ConvertFrom-Json
$ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction Stop
$ffprobeCommand = Get-Command ffprobe.exe -ErrorAction Stop
$ffmpegVersionResult = Invoke-CapturedProcess -FilePath $ffmpegCommand.Source -Arguments @('-version') -TimeoutSeconds 30 -WorkingDirectory $repoRoot -Environment (Get-SafeEnvironment)
$ffprobeVersionResult = Invoke-CapturedProcess -FilePath $ffprobeCommand.Source -Arguments @('-version') -TimeoutSeconds 30 -WorkingDirectory $repoRoot -Environment (Get-SafeEnvironment)
if ($ffmpegVersionResult.ExitCode -ne 0 -or $ffprobeVersionResult.ExitCode -ne 0) { throw 'FFmpeg and FFprobe must both run on the Windows lifecycle worker.' }
$windowsToolchain = [ordered]@{
    node = ($nodeVersionResult.Stdout.Trim() -split "`r?`n")[0]
    pnpm = ($pnpmVersionResult.Stdout.Trim() -split "`r?`n")[0]
    electron = [string]$electronPackage.version
    ffmpeg = ($ffmpegVersionResult.Stdout -split "`r?`n")[0]
    ffprobe = ($ffprobeVersionResult.Stdout -split "`r?`n")[0]
    windows = [Environment]::OSVersion.VersionString
}

$script:setupLaunchCount = 0
try {
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $desktopShortcut) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $startMenuShortcut) -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Force | Out-Null
$testTamperedArtifact = Join-Path $workRoot 'tampered-setup.exe'
[IO.File]::WriteAllText($testTamperedArtifact, 'tampered installer negative control')
$negativeControlRejected = $false
try {
    Invoke-VerifiedSetup $testTamperedArtifact $candidateSetup $candidateVersion | Out-Null
} catch {
    if ($_.Exception.Message -notmatch '^Setup preflight rejected an artifact hash mismatch') { throw }
    $negativeControlRejected = $true
}
if (-not $negativeControlRejected) { throw 'Installer hash negative control was not rejected by the setup preflight.' }
if ($script:setupLaunchCount -ne 0) { throw 'Installer hash negative control launched setup before verification.' }
Remove-Item -LiteralPath $testTamperedArtifact -Force

$oldUserPathValue = [Environment]::GetEnvironmentVariable('Path', 'User')
$oldShortcutState = @{
    desktop = Test-Path -LiteralPath $desktopShortcut
    startMenu = Test-Path -LiteralPath $startMenuShortcut
}
if ($oldShortcutState.desktop -or $oldShortcutState.startMenu) { throw 'Test profile already contains a JOY Media shortcut.' }
if ($oldUserPathValue -and ($oldUserPathValue -split ';' | Where-Object { $_.TrimEnd('\') -ieq $installRoot.TrimEnd('\') })) {
    throw 'Test profile already has the JOY Media install path registered.'
}

    $script:ownedInstall = $true
    Invoke-VerifiedSetup $PreviousSetupPath $PreviousSetupSha256 $PreviousVersion | Out-Null
    Assert-UserIntegrations $PreviousVersion
    $previousExeSha = Assert-Sha256 (Join-Path $installRoot 'joy-media.exe') $previousDesktopExeSha 'Installed v1.0.1 app executable'
    $previousInstalledCliSha = Assert-Sha256 (Join-Path $installRoot 'resources\app\cli\joy-media-bundle.mjs') $previousCliBundleSha 'Installed v1.0.1 CLI bundle'
    Invoke-AppSmoke 'v1.0.1 initial install'
    $seedProof = Invoke-LifecycleFixture (Join-Path $installRoot 'joy-media.exe') 'seed'
    if ($seedProof.result -ne 'seeded' -or $seedProof.encryptionAvailable -ne $true) { throw 'v1.0.1 could not seed isolated settings, library, and DPAPI fixture data.' }
    Invoke-Pnpm 'CLI render-real source and bundle acceptance' @('exec', 'vitest', 'run', 'apps/cli/src/humanized/render-real.e2e.test.ts', '--no-file-parallelism') | Out-Null
    Invoke-Pnpm 'CLI unsupported-feature acceptance' @('exec', 'vitest', 'run', 'apps/cli/src/humanized/render-parity.e2e.test.ts', '--no-file-parallelism') | Out-Null
    Invoke-Pnpm 'CLI render failure-recovery acceptance' @('exec', 'vitest', 'run', 'apps/cli/src/humanized/render-recovery.e2e.test.ts', '--no-file-parallelism') | Out-Null
    Invoke-VerifiedSetup $CandidateSetupPath $candidateSetup $candidateVersion | Out-Null
    Assert-UserIntegrations $candidateVersion
    if ((Get-InstalledFileHash 'joy-media.exe') -ne $candidateDesktopExeSha -or (Get-InstalledFileHash 'resources\app\cli\joy-media-bundle.mjs') -ne $candidateCliBundleSha -or (Get-InstalledFileHash 'resources\app\worker\joy-worker.exe') -ne $candidateWorkerSha) {
        throw 'Candidate upgrade did not install the exact frozen app, CLI, and Worker files.'
    }
    Invoke-AppSmoke 'v1.0.2 upgrade'
    Invoke-Pnpm 'installed candidate editor restart-save-export acceptance' @('exec', 'playwright', 'test', '--config', 'playwright.desktop.config.ts', 'tests/desktop/editor-acceptance.spec.ts', '--retries=0') 900 @{
        JOY_MEDIA_TEST_EXECUTABLE = Join-Path $installRoot 'joy-media.exe'
        JOY_MEDIA_TEST_WORKING_DIRECTORY = $installRoot
        JOY_MEDIA_TEST_API_BASE_URL = 'http://127.0.0.1:4174'
    } | Out-Null
    $candidateSeedVerification = Invoke-LifecycleFixture (Join-Path $installRoot 'joy-media.exe') 'verify'
    if ($candidateSeedVerification.result -ne 'verified' -or $candidateSeedVerification.ciphertextSha256 -ne $seedProof.ciphertextSha256 -or $candidateSeedVerification.directCiphertextSha256 -ne $seedProof.directCiphertextSha256) {
        throw 'Settings, asset-library catalog, or DPAPI ciphertext did not survive the candidate update.'
    }
    $cliJoyEvidence = Invoke-InstalledCliAcceptance 'joy.cmd' 'joy'
    $cliJoyMediaEvidence = Invoke-InstalledCliAcceptance 'joy-media.cmd' 'joy-media'

    $rendererIndex = Join-Path $installRoot 'resources\app\renderer\index.html'
    if (-not (Test-Path -LiteralPath $rendererIndex -PathType Leaf)) { throw 'Installed candidate renderer is missing before repair test.' }
    $expectedRendererSha = Get-Sha256 (Join-Path $CandidateStandalonePath 'resources\app\renderer\index.html')
    Remove-Item -LiteralPath $rendererIndex -Force
    if (Test-Path -LiteralPath $rendererIndex) { throw 'Repair test could not create the missing-file condition.' }
    Invoke-VerifiedSetup $CandidateSetupPath $candidateSetup $candidateVersion | Out-Null
    if ((Get-Sha256 $rendererIndex) -ne $expectedRendererSha) { throw 'Candidate repair did not restore the exact missing renderer file.' }
    Assert-RegisteredVersion $candidateVersion
    $repairVerification = Invoke-LifecycleFixture (Join-Path $installRoot 'joy-media.exe') 'verify'
    if ($repairVerification.result -ne 'verified' -or $repairVerification.ciphertextSha256 -ne $seedProof.ciphertextSha256) { throw 'Repair changed or lost user data.' }
    $script:commands.Add([pscustomobject]@{ name = 'installer repair restores removed renderer and preserves user data'; exitCode = 0 })
    Invoke-AppSmoke 'v1.0.2 repair'

    Invoke-VerifiedSetup $PreviousSetupPath $PreviousSetupSha256 $PreviousVersion | Out-Null
    Assert-UserIntegrations $PreviousVersion
    if ((Get-InstalledFileHash 'joy-media.exe') -ne $previousDesktopExeSha -or (Get-InstalledFileHash 'resources\app\cli\joy-media-bundle.mjs') -ne $previousCliBundleSha) {
        throw 'Rollback did not restore the exact v1.0.1 app and CLI files.'
    }
    Invoke-AppSmoke 'v1.0.1 rollback'
    $rollbackVerification = Invoke-LifecycleFixture (Join-Path $installRoot 'joy-media.exe') 'verify'
    if ($rollbackVerification.result -ne 'verified' -or $rollbackVerification.ciphertextSha256 -ne $seedProof.ciphertextSha256 -or $rollbackVerification.directCiphertextSha256 -ne $seedProof.directCiphertextSha256) {
        throw 'Settings, Persian asset-library catalog, or DPAPI ciphertext did not survive rollback.'
    }

    $uninstaller = Join-Path $installRoot 'uninstall.cmd'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Installed uninstaller is missing.' }
    $uninstallCommand = '"' + $uninstaller + '"'
    $uninstallResult = Invoke-CapturedProcess -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments @('/d', '/s', '/c', $uninstallCommand) -TimeoutSeconds 90 -WorkingDirectory $runnerTemp -Environment (Get-SafeEnvironment)
    if ($uninstallResult.ExitCode -ne 0) { throw 'The installed uninstaller returned a non-zero exit code.' }
    $removeDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ((Test-Path -LiteralPath $installRoot) -and [DateTime]::UtcNow -lt $removeDeadline) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $installRoot) { throw 'Uninstaller left the owned install directory behind.' }
    $uninstallKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia'
    if (Test-Path -LiteralPath $uninstallKey) { throw 'Uninstaller left the product registry key behind.' }
    if (Test-Path -LiteralPath $desktopShortcut) { throw 'Uninstaller left the Desktop shortcut behind.' }
    if (Test-Path -LiteralPath $startMenuShortcut) { throw 'Uninstaller left the Start Menu shortcut behind.' }
    $remainingUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($remainingUserPath -and ($remainingUserPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $installRoot.TrimEnd('\') })) { throw 'Uninstaller left its path registration behind.' }
    $script:ownedInstall = $false
    if (-not (Test-Path -LiteralPath $userDataDirectory -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $userDataDirectory 'safe-storage-lifecycle-fixture.bin') -PathType Leaf)) {
        throw 'Uninstall removed user data that must remain available for recovery.'
    }
    $devElectron = Join-Path $repoRoot 'apps\desktop\node_modules\electron\dist\electron.exe'
    $uninstalledDataVerification = Invoke-LifecycleFixture $devElectron 'verify'
    if ($uninstalledDataVerification.result -ne 'verified' -or $uninstalledDataVerification.ciphertextSha256 -ne $seedProof.ciphertextSha256) {
        throw 'User data could not be reopened after application uninstall.'
    }
    Assert-NoOwnedProcesses

    foreach ($stateDirectory in $script:cliStateDirectories) {
        if (Test-Path -LiteralPath $stateDirectory) { Remove-Item -LiteralPath $stateDirectory -Recurse -Force -ErrorAction Stop }
        if (Test-Path -LiteralPath $stateDirectory) { throw 'Installed CLI acceptance left a temp profile behind.' }
    }
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $workRoot) { throw 'Desktop lifecycle evidence temp root was not removed.' }

    $finishedAt = [DateTime]::UtcNow.ToString('o')
    $evidence = [ordered]@{
        schemaVersion = 1
        status = 'verified'
        candidateSha = $CandidateSha
        workflowRunId = $RunId
        attempt = [int]$Attempt
        pass = [int]$Pass
        sourceProvenance = [ordered]@{ commitSha = $sourceHead; worktreeClean = $true }
        containerIdentity = [ordered]@{ containerId = $containerId; imageDigest = $imageDigest }
        versions = [ordered]@{ previous = $PreviousVersion; candidate = $candidateVersion }
        artifacts = [ordered]@{
            candidateSetupSha256 = $candidateSetup
            candidatePortableArchiveSha256 = $candidateArchive
            candidateDesktopExecutableSha256 = $candidateDesktopExeSha
            candidateCliBundleSha256 = $candidateCliBundleSha
            candidateWorkerExecutableSha256 = $candidateWorkerSha
            previousSetupSha256 = $previousSetup
            previousArchiveSha256 = $previousArchive
            previousChecksumsSha256 = $previousChecksums
            previousDesktopExecutableSha256 = $previousDesktopExeSha
            previousCliBundleSha256 = $previousCliBundleSha
        }
        transitions = [ordered]@{
            installPrevious = 'passed'
            upgradeCandidate = 'passed'
            repairCandidate = 'passed'
            rollbackPrevious = 'passed'
            uninstall = 'passed'
            userDataPreserved = 'passed'
        }
        cliAcceptance = [ordered]@{ joyCmd = $cliJoyEvidence; joyMediaCmd = $cliJoyMediaEvidence }
        editorAcceptance = [ordered]@{ status = 'passed'; firstAttemptPassed = $true; retries = 0 }
        toolchain = $windowsToolchain
        scenarios = @(
            [ordered]@{ id = 'cli.render.playable'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
            [ordered]@{ id = 'cli.render.unsupported-features'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
            [ordered]@{ id = 'cli.render.failure-recovery'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
            [ordered]@{ id = 'cli.render.windows-entrypoints'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
            [ordered]@{ id = 'project.persistence.fresh-process'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
            [ordered]@{ id = 'desktop.app.restart-save-export'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
            [ordered]@{ id = 'desktop.windows.installed-lifecycle'; status = 'passed'; firstAttemptPassed = $true; retries = 0 }
        )
        commands = @($script:commands)
        startedAt = $startedAt
        finishedAt = $finishedAt
    }
    $evidenceJson = $evidence | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($outputAbsolute, $evidenceJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    if ((Get-Sha256 $outputAbsolute).Length -ne 64) { throw 'Lifecycle evidence file failed its final digest check.' }
    Write-Output "Verified v$PreviousVersion install -> v$candidateVersion update/repair -> rollback -> uninstall (pass $Pass)."
}
finally {
    foreach ($stateDirectory in $script:cliStateDirectories) {
        if (Test-Path -LiteralPath $stateDirectory) { Remove-Item -LiteralPath $stateDirectory -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($script:ownedInstall -and (Test-Path -LiteralPath $installRoot)) {
        try {
            $uninstaller = Join-Path $installRoot 'uninstall.cmd'
            if (Test-Path -LiteralPath $uninstaller) {
                $command = '"' + $uninstaller + '"'
                Invoke-CapturedProcess -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments @('/d', '/s', '/c', $command) -TimeoutSeconds 60 -WorkingDirectory $runnerTemp -Environment (Get-SafeEnvironment) | Out-Null
            }
        } catch { }
        $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while ((Test-Path -LiteralPath $installRoot) -and [DateTime]::UtcNow -lt $cleanupDeadline) { Start-Sleep -Milliseconds 500 }
        if (Test-Path -LiteralPath $installRoot -and (Test-Path -LiteralPath (Join-Path $installRoot 'joy-media.exe'))) {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($script:ownedInstall) {
        $uninstallKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia'
        if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue }
        foreach ($shortcut in @($desktopShortcut, $startMenuShortcut)) {
            if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
        }
        $currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $remainingPathParts = @($currentUserPath -split ';' | Where-Object {
            $_.TrimEnd('\') -ine $installRoot.TrimEnd('\')
        })
        $remainingUserPath = $remainingPathParts -join ';'
        if ($remainingUserPath -ne $currentUserPath) {
            [Environment]::SetEnvironmentVariable('Path', $remainingUserPath, 'User')
        }
    }
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
