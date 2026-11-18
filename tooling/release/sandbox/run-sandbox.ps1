# Runs one scripted Windows Sandbox lifecycle run for a release candidate and copies its receipt out.
#
#   run-sandbox.ps1 -Kind lifecycle -SetupExe <joy-media-setup.exe> -OutDir <new folder> -Receipt <path>
#   run-sandbox.ps1 -Kind upgrade   -SetupExe <joy-media-setup.exe> -ToVersion <candidate x.y.z> `
#                   -V102Zip <joy-media-windows-x64-v1.0.2.zip> -OutDir <new folder> -Receipt <path>
#   run-sandbox.ps1 -Kind upgrade   -SetupExe <joy-media-setup.exe> -ToVersion <candidate x.y.z> `
#                   -FromSetupExe <joy-media-setup-from.exe> -FromVersion 1.1.0 -FromSha256 <hash> `
#                   -OutDir <new folder> -Receipt <path>
#
# -FromVersion is 1.0.2 or 1.1.0. The zip is the released v1.0.2 zip (-V102Zip, which implies 1.0.2); a
# setup exe needs -FromVersion and -FromSha256, and the exe's own digest must match -FromSha256.
# -ToVersion is the candidate's version. It is a parameter so that no version is written into the script.
#
# The Sandbox has networking off and sees two folders: in (read-only) and out. The script refuses to start when a
# Sandbox is already running, because Windows allows only one. The Sandbox is NOT closed here: close its window
# when the receipt is written (its contents are discarded). Nothing touches the host install or profile.
param(
    [Parameter(Mandatory = $true)][ValidateSet('lifecycle', 'upgrade')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$SetupExe,
    [string]$V102Zip = '',
    [string]$FromSetupExe = '',
    [string]$FromVersion = '',
    [string]$FromSha256 = '',
    [string]$ToVersion = '',
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$Receipt,
    [int]$TimeoutSeconds = 900,
    [switch]$OfflineSmoke,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function New-SandboxConfigurationText([string]$HostIn, [string]$HostOut, [switch]$RunOfflineSmoke) {
    $hostInXml = [System.Security.SecurityElement]::Escape($HostIn)
    $hostOutXml = [System.Security.SecurityElement]::Escape($HostOut)
    $offlineArgument = if ($RunOfflineSmoke) { ' -RunOfflineSmoke' } else { '' }
    return @"
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder><HostFolder>$hostInXml</HostFolder><SandboxFolder>C:\in</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$hostOutXml</HostFolder><SandboxFolder>C:\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\in\lifecycle.ps1$offlineArgument</Command></LogonCommand>
</Configuration>
"@
}

if ($DryRun) {
    if ($Kind -ne 'lifecycle') { throw '-DryRun currently validates the lifecycle and offline-smoke receipt writers only.' }
    if ($OfflineSmoke -and $Kind -ne 'lifecycle') { throw '-OfflineSmoke can be used only with -Kind lifecycle.' }
    Write-Output 'DRY RUN: would install the candidate in Windows Sandbox.'
    Write-Output 'DRY RUN: would run joy/joy-media version and CLI smoke checks.'
    if ($OfflineSmoke) {
        Write-Output 'DRY RUN: optional offline smoke runs after install and checks launch, import, export, doctor and render.'
    } else {
        Write-Output 'DRY RUN: optional offline smoke step not requested.'
    }
    Write-Output ('DRY RUN: planned lifecycle receipt: ' + $Receipt)
    if ($OfflineSmoke) {
        Write-Output ('DRY RUN: planned offline receipt: ' + (Join-Path (Split-Path -Parent $Receipt) 'offline-smoke.json'))
    }
    $dryIn = Join-Path $OutDir 'in'
    $dryOutFolder = Join-Path $OutDir 'out'
    $dryWsb = New-SandboxConfigurationText -HostIn $dryIn -HostOut $dryOutFolder -RunOfflineSmoke:$OfflineSmoke
    [void][xml]$dryWsb
    Write-Output 'DRY RUN WSB BEGIN'
    Write-Output $dryWsb
    Write-Output 'DRY RUN WSB END'

    $dryRoot = Join-Path $env:TEMP ('joy-media-sandbox-dry-run-' + [Guid]::NewGuid().ToString('N'))
    try {
        $dryOut = Join-Path $dryRoot 'out'
        New-Item -ItemType Directory -Force -Path $dryOut | Out-Null
        $lifecycleScript = Join-Path $PSScriptRoot 'lifecycle.ps1'
        $global:LASTEXITCODE = 0
        if ($OfflineSmoke) {
            & $lifecycleScript -DryRun -RunOfflineSmoke -OutputDirectory $dryOut
        } else {
            & $lifecycleScript -DryRun -OutputDirectory $dryOut
        }
        if ($LASTEXITCODE -ne 0) { throw "lifecycle.ps1 -DryRun failed with exit $LASTEXITCODE." }

        if ($OfflineSmoke) {
            $dryEvidence = Get-Content -LiteralPath (Join-Path $dryOut 'offline-smoke-evidence.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $fakeSha = 'a' * 64
            $fakeCommit = 'c' * 40
            $context = [ordered]@{
                candidateSha = $fakeCommit
                workflowSha = $fakeCommit
                runId = 'sandbox-dry-run'
                attempt = 1
                artifactName = 'joy-media-setup.exe'
                artifactSha256 = $fakeSha
                builtAt = [string]$dryEvidence.startedAt
            }
            $contextPath = Join-Path $dryOut 'offline-smoke-context.json'
            [IO.File]::WriteAllText(
                $contextPath,
                (($context | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
                [Text.UTF8Encoding]::new($false)
            )
            $offlineReceipt = Join-Path $dryOut 'offline-smoke.json'
            $writer = Join-Path $PSScriptRoot '..\src\write-offline-smoke-receipt.ts'
            $lifecycleReceipt = Join-Path $dryOut 'lifecycle.json'
            $writerArguments = @(
                '--context', $contextPath,
                '--evidence', (Join-Path $dryOut 'offline-smoke-evidence.json'),
                '--network-log', (Join-Path $dryOut 'network-evidence.log'),
                '--lifecycle', $lifecycleReceipt,
                '--output', $offlineReceipt
            )
            & node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types $writer @writerArguments
            if ($LASTEXITCODE -ne 0) { throw "Receipt writer validation failed with exit $LASTEXITCODE." }
            Write-Output 'dry-run receipts accepted'
        } else {
            Write-Output 'dry-run lifecycle fixture accepted; offline smoke was not requested'
        }
        Write-Output 'Windows Sandbox was not started'
    } finally {
        $tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        $fullDryRoot = [IO.Path]::GetFullPath($dryRoot)
        if (
            $fullDryRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $fullDryRoot) -like 'joy-media-sandbox-dry-run-*'
        ) {
            Remove-Item -LiteralPath $fullDryRoot -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            throw "Refusing to remove dry-run folder outside TEMP: $fullDryRoot"
        }
    }
    return
}

if ($OfflineSmoke -and $Kind -ne 'lifecycle') { throw '-OfflineSmoke can be used only with -Kind lifecycle.' }

if (Get-Process -Name 'WindowsSandboxRemoteSession', 'vmmemWindowsSandbox' -ErrorAction SilentlyContinue) {
    throw 'A Windows Sandbox is already running. Close it first (only one is allowed).'
}
if (-not (Test-Path -LiteralPath $SetupExe -PathType Leaf)) { throw "Setup exe not found: $SetupExe" }
if (Test-Path -LiteralPath $OutDir) { throw "OutDir must be a new folder (nothing is deleted): $OutDir" }

# Which older release the upgrade starts from, and how it is installed.
$upgradeFrom = $null
$fromMode = $null
if ($Kind -eq 'upgrade') {
    if ($V102Zip -ne '' -and $FromSetupExe -ne '') { throw 'Use either -V102Zip or -FromSetupExe, not both.' }
    if ($V102Zip -ne '') {
        if (-not (Test-Path -LiteralPath $V102Zip -PathType Leaf)) { throw "V102Zip not found: $V102Zip" }
        if ($FromVersion -ne '' -and $FromVersion -ne '1.0.2') { throw '-V102Zip is v1.0.2; use -FromSetupExe for another start version.' }
        $upgradeFrom = '1.0.2'
        $fromMode = 'zip'
    } elseif ($FromSetupExe -ne '') {
        if (-not (Test-Path -LiteralPath $FromSetupExe -PathType Leaf)) { throw "FromSetupExe not found: $FromSetupExe" }
        if ($FromVersion -notin @('1.0.2', '1.1.0')) { throw '-FromSetupExe needs -FromVersion 1.0.2 or 1.1.0.' }
        if ($FromSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw '-FromSetupExe needs -FromSha256 (64 hex characters).' }
        $fromHash = (Get-FileHash -LiteralPath $FromSetupExe -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($fromHash -ne $FromSha256.ToLowerInvariant()) { throw "FromSetupExe does not match -FromSha256 (its digest is $fromHash)." }
        $upgradeFrom = $FromVersion
        $fromMode = 'setup'
    } else {
        throw 'upgrade needs -V102Zip, or -FromSetupExe with -FromVersion and -FromSha256.'
    }
    if ($ToVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'upgrade needs -ToVersion x.y.z (the candidate version).' }
    if ($ToVersion -eq $upgradeFrom) { throw "-ToVersion must differ from the start version $upgradeFrom." }
}

$in = Join-Path $OutDir 'in'
$out = Join-Path $OutDir 'out'
New-Item -ItemType Directory -Force -Path $in, $out | Out-Null
Copy-Item -LiteralPath $SetupExe -Destination (Join-Path $in 'joy-media-setup.exe')
$setupHash = (Get-FileHash -LiteralPath $SetupExe -Algorithm SHA256).Hash.ToLowerInvariant()
$script = if ($Kind -eq 'lifecycle') { 'lifecycle.ps1' } else { 'upgrade.ps1' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $in 'lifecycle.ps1')
if ($Kind -eq 'lifecycle') {
    Set-Content -LiteralPath (Join-Path $in 'expected.sha256') -Value $setupHash -NoNewline
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cli-smoke.ps1') -Destination (Join-Path $in 'cli-smoke.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'offline-smoke.ps1') -Destination (Join-Path $in 'offline-smoke.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'offline-smoke-project.json') -Destination (Join-Path $in 'offline-smoke-project.json')

    $releaseDir = Split-Path -Parent $SetupExe
    $manifestPath = Join-Path $releaseDir 'joy-media-release-manifest.json'
    $sumsPath = Join-Path $releaseDir 'SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Release manifest not found: $manifestPath" }
    if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) { throw "SHA256SUMS.txt not found: $sumsPath" }
    $releaseManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($releaseManifest.targetCommit -notmatch '^[0-9a-f]{40}$') { throw 'Release manifest targetCommit is not a full Git SHA.' }
    if ([string]::IsNullOrWhiteSpace([string]$releaseManifest.builtAt)) { throw 'Release manifest builtAt is missing.' }
    $setupSum = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match ('^' + [regex]::Escape($setupHash) + '\s+joy-media-setup\.exe$') }
    if (-not $setupSum) { throw 'SHA256SUMS.txt does not bind joy-media-setup.exe to the selected setup exe.' }
    $context = [ordered]@{
        candidateSha = [string]$releaseManifest.targetCommit
        workflowSha = [string]$releaseManifest.targetCommit
        runId = 'local-sandbox-' + [Guid]::NewGuid().ToString('N')
        attempt = 1
        artifactName = 'joy-media-setup.exe'
        artifactSha256 = $setupHash
        builtAt = [string]$releaseManifest.builtAt
    }
    $contextPath = Join-Path $out 'offline-smoke-context.json'
    [IO.File]::WriteAllText(
        $contextPath,
        (($context | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
} else {
    Set-Content -LiteralPath (Join-Path $in 'expected-new.sha256') -Value $setupHash -NoNewline
    $plan = [ordered]@{ fromVersion = $upgradeFrom; fromMode = $fromMode; toVersion = $ToVersion }
    Set-Content -LiteralPath (Join-Path $in 'upgrade-plan.json') -Value ($plan | ConvertTo-Json) -Encoding UTF8
    if ($fromMode -eq 'zip') {
        Copy-Item -LiteralPath $V102Zip -Destination (Join-Path $in 'v102.zip')
        $zipHash = (Get-FileHash -LiteralPath $V102Zip -Algorithm SHA256).Hash.ToLowerInvariant()
        Set-Content -LiteralPath (Join-Path $in 'expected-v102.sha256') -Value $zipHash -NoNewline
    } else {
        Copy-Item -LiteralPath $FromSetupExe -Destination (Join-Path $in 'from-setup.exe')
        Set-Content -LiteralPath (Join-Path $in 'expected-from.sha256') -Value $FromSha256.ToLowerInvariant() -NoNewline
    }
}

$wsb = New-SandboxConfigurationText -HostIn $in -HostOut $out -RunOfflineSmoke:$OfflineSmoke
$wsbPath = Join-Path $OutDir 'run.wsb'
Set-Content -LiteralPath $wsbPath -Value $wsb -Encoding UTF8
Start-Process -FilePath "$env:SystemRoot\System32\WindowsSandbox.exe" -ArgumentList "`"$wsbPath`""

$log = Join-Path $out 'progress.log'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if ((Test-Path -LiteralPath $log) -and ((Get-Content -LiteralPath $log -Raw) -match 'script finished')) { break }
}
if (-not ((Test-Path -LiteralPath $log) -and ((Get-Content -LiteralPath $log -Raw) -match 'script finished'))) {
    throw "The Sandbox run did not finish within $TimeoutSeconds s. Evidence is in $out."
}
$name = if ($Kind -eq 'lifecycle') { 'lifecycle.json' } else { 'upgrade.json' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Receipt) | Out-Null
Copy-Item -LiteralPath (Join-Path $out $name) -Destination $Receipt
Write-Output "Receipt written: $Receipt (setup sha256 $setupHash). Close the Sandbox window now."
if ($Kind -eq 'lifecycle' -and $OfflineSmoke) {
    $offlineReceipt = Join-Path (Split-Path -Parent $Receipt) 'offline-smoke.json'
    $writer = Join-Path $PSScriptRoot '..\src\write-offline-smoke-receipt.ts'
    $writerArguments = @(
        '--context', (Join-Path $out 'offline-smoke-context.json'),
        '--evidence', (Join-Path $out 'offline-smoke-evidence.json'),
        '--network-log', (Join-Path $out 'network-evidence.log'),
        '--lifecycle', (Join-Path $out 'lifecycle.json'),
        '--output', $offlineReceipt
    )
    & node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types $writer @writerArguments
    if ($LASTEXITCODE -ne 0) { throw "Offline-smoke receipt writer failed with exit $LASTEXITCODE." }
    $evidence = Get-Content -LiteralPath (Join-Path $out 'offline-smoke-evidence.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $checker = Join-Path $PSScriptRoot '..\src\check-offline-smoke.ts'
    $checkerArguments = @(
        '--candidate', $context.candidateSha,
        '--receipt', $offlineReceipt,
        '--sums', $sumsPath,
        '--artifact', $context.artifactName,
        '--window-start', $evidence.startedAt,
        '--window-end', $evidence.finishedAt
    )
    & node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types $checker @checkerArguments
    if ($LASTEXITCODE -ne 0) { throw "Offline-smoke receipt checker failed with exit $LASTEXITCODE." }
    Write-Output "Offline-smoke receipt written: $offlineReceipt"
}
