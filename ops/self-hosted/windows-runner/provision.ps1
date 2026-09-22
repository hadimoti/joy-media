[CmdletBinding()]
param(
    [string]$Image = 'joy-media-worker-windows:2.337.0',
    [ValidateSet('joy-media-worker-docker')]
    [string]$RunnerName = 'joy-media-worker-docker',
    [string]$Volume = '',
    [ValidateRange(0,1500)][int]$MtuBytes = 1240
)

$ErrorActionPreference = 'Stop'
$runnerLabels = 'self-hosted,windows,x64,joy-media-worker-docker'

function ConvertTo-EncodedCommand([string]$Script) {
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
}

if ($MtuBytes -gt 0 -and $MtuBytes -lt 576) {
    throw 'MtuBytes must be 0 or at least 576.'
}
if ($Volume -and $Volume -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') {
    throw 'Volume must be a Docker named volume; host bind mounts are not allowed.'
}

Get-Command gh -ErrorAction Stop | Out-Null
Get-Command docker -ErrorAction Stop | Out-Null

$dockerOsType = (@(& docker info --format '{{.OSType}}') -join '').Trim()
$dockerInfoExitCode = $LASTEXITCODE
if ($dockerInfoExitCode -ne 0) {
    throw "docker info failed with exit code $dockerInfoExitCode."
}
if ($dockerOsType -ne 'windows') {
    throw "Docker must use the Windows engine; detected '$dockerOsType'."
}

$existingContainerIds = @(
    & docker ps -a --filter ("name=^/{0}$" -f $RunnerName) --format '{{.ID}}'
)
$existingContainerExitCode = $LASTEXITCODE
if ($existingContainerExitCode -ne 0) {
    throw "Unable to check whether container '$RunnerName' already exists."
}
if ($existingContainerIds.Count -gt 0) {
    throw "Container '$RunnerName' already exists. Remove it explicitly before provisioning."
}

$imageIdLines = @(& docker image inspect --format '{{.Id}}' $Image)
$imageInspectExitCode = $LASTEXITCODE
if ($imageInspectExitCode -ne 0 -or $imageIdLines.Count -ne 1) {
    throw "Unable to resolve exactly one immutable image ID for '$Image'."
}
$imageId = $imageIdLines[0].Trim()
if ($imageId -notmatch '^sha256:[0-9a-f]{64}$') {
    throw "Image '$Image' did not resolve to an immutable sha256 image ID."
}

$dockerRunArgs = @(
    'run'
    '--detach'
    '--name'
    $RunnerName
    '--restart'
    'unless-stopped'
    '--env'
    "JOY_MEDIA_WINDOWS_IMAGE_DIGEST=$imageId"
    '--env'
    'JOY_MEDIA_WINDOWS_WAIT_FOR_REGISTRATION=1'
)
if ($Volume) {
    $dockerRunArgs += @('--volume', "$($Volume):C:\actions-runner")
}

if ($MtuBytes -gt 0) {
    $startupWrapper = @"
`$ErrorActionPreference = 'Stop'
`$subinterfaces = @(& netsh interface ipv4 show subinterfaces)
`$netshExitCode = `$LASTEXITCODE
if (`$netshExitCode -ne 0) {
    Write-Output 'MTU wrapper: netsh could not list subinterfaces; runner not started.'
    exit `$netshExitCode
}
`$setCount = 0
foreach (`$line in `$subinterfaces) {
    if (`$line -match '^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?<name>.+?)\s*$') {
        `$interfaceName = `$Matches.name.Trim()
        if (`$interfaceName -and `$interfaceName -notmatch '(?i)loopback') {
            & netsh interface ipv4 set subinterface "`$interfaceName" mtu=$MtuBytes store=active
            `$setExitCode = `$LASTEXITCODE
            if (`$setExitCode -ne 0) {
                Write-Output "MTU wrapper: could not set MTU on '`$interfaceName'; runner not started."
                exit `$setExitCode
            }
            `$setCount++
        }
    }
}
if (`$setCount -eq 0) {
    Write-Output 'MTU wrapper: no non-loopback subinterface found; runner not started.'
    exit 1
}
& C:\joy-media-windows-runner.ps1
exit `$LASTEXITCODE
"@
    # -EncodedCommand avoids re-quoting the multi-line script through docker.exe
    # and the Windows container command line.
    $dockerRunArgs += @('--entrypoint', 'powershell', $Image, '-NoProfile', '-EncodedCommand', (ConvertTo-EncodedCommand $startupWrapper))
} else {
    $dockerRunArgs += $Image
}

$containerId = (@(& docker @dockerRunArgs) -join '').Trim()
$dockerRunExitCode = $LASTEXITCODE
if ($dockerRunExitCode -ne 0 -or $containerId -notmatch '^[0-9a-f]{12,64}$') {
    throw "docker run failed with exit code $dockerRunExitCode."
}

$configReady = $false
# Windows PowerShell 5.1 promotes redirected native stderr to a terminating
# error under Stop; transient docker exec failures while the container starts
# must retry until the timeout, not abort.
$ErrorActionPreference = 'Continue'
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $RunnerName powershell -NoProfile -Command "if (Test-Path -LiteralPath 'C:\actions-runner\config.cmd' -PathType Leaf) { exit 0 } else { exit 1 }" 2>$null
    $configCheckExitCode = $LASTEXITCODE
    if ($configCheckExitCode -eq 0) {
        $configReady = $true
        break
    }
    if ($attempt -lt 59) {
        Start-Sleep -Seconds 1
    }
}
$ErrorActionPreference = 'Stop'
if (-not $configReady) {
    throw 'Timed out waiting for C:\actions-runner\config.cmd inside the container.'
}

if ($MtuBytes -gt 0) {
    $mtuVerification = @"
`$subinterfaces = @(& netsh interface ipv4 show subinterfaces)
if (`$LASTEXITCODE -ne 0) {
    exit 2
}
# Every non-loopback subinterface must be clamped; one unclamped vNIC is
# enough to blackhole TLS.
`$checked = 0
foreach (`$line in `$subinterfaces) {
    if (`$line -match '^\s*(?<mtu>\d+)\s+\d+\s+\d+\s+\d+\s+(?<name>.+?)\s*$' -and `$Matches.name.Trim() -notmatch '(?i)loopback') {
        if ([long]`$Matches.mtu -gt $MtuBytes) {
            exit 1
        }
        `$checked++
    }
}
if (`$checked -eq 0) {
    exit 1
}
exit 0
"@
    $encodedMtuVerification = ConvertTo-EncodedCommand $mtuVerification
    # The startup wrapper runs asynchronously after docker run returns.
    $ErrorActionPreference = 'Continue'
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        & docker exec $RunnerName powershell -NoProfile -EncodedCommand $encodedMtuVerification 2>$null
        $mtuVerificationExitCode = $LASTEXITCODE
        if ($mtuVerificationExitCode -eq 0 -or $mtuVerificationExitCode -eq 2) { break }
        Start-Sleep -Seconds 1
    }
    $ErrorActionPreference = 'Stop'
    if ($mtuVerificationExitCode -ne 0) {
        throw "Container MTU verification failed with exit code $mtuVerificationExitCode."
    }
}

$registrationToken = $null
try {
    $registrationToken = @(& gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token --jq .token)
    $ghExitCode = $LASTEXITCODE
    if ($ghExitCode -ne 0) {
        throw "GitHub registration-token request failed with exit code $ghExitCode."
    }
    $registrationToken = ($registrationToken -join '').Trim()
    if ([string]::IsNullOrWhiteSpace($registrationToken)) {
        throw 'GitHub returned an empty registration token.'
    }

    $configure = @'
$token = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Registration token was empty.'
}
& C:\actions-runner\config.cmd --unattended --url https://github.com/hadimoti/joy-media --token $token --name joy-media-worker-docker --labels self-hosted,windows,x64,joy-media-worker-docker --work _work --replace
exit $LASTEXITCODE
'@
    $registrationToken | & docker exec -i $RunnerName powershell -NoProfile -EncodedCommand (ConvertTo-EncodedCommand $configure)
    $configureExitCode = $LASTEXITCODE
} finally {
    $registrationToken = $null
}
if ($configureExitCode -ne 0) {
    throw "Runner configuration failed with exit code $configureExitCode."
}

Write-Output "Container ID: $containerId"
Write-Output "Image ID: $imageId"
Write-Output "Volume: $Volume"
Write-Output "MTU: $MtuBytes"
