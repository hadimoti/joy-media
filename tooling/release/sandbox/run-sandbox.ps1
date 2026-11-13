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
    [int]$TimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'

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

$wsb = @"
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder><HostFolder>$in</HostFolder><SandboxFolder>C:\in</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$out</HostFolder><SandboxFolder>C:\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\in\lifecycle.ps1</Command></LogonCommand>
</Configuration>
"@
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
