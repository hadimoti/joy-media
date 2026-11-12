# Runs one scripted Windows Sandbox lifecycle run for a release candidate and copies its receipt out.
#
#   run-sandbox.ps1 -Kind lifecycle -SetupExe <joy-media-setup.exe> -OutDir <new folder> -Receipt <path>
#   run-sandbox.ps1 -Kind upgrade   -SetupExe <joy-media-setup.exe> -V102Zip <joy-media-windows-x64-v1.0.2.zip> `
#                   -OutDir <new folder> -Receipt <path>
#
# The Sandbox has networking off and sees two folders: in (read-only) and out. The script refuses to start when a
# Sandbox is already running, because Windows allows only one. The Sandbox is NOT closed here: close its window
# when the receipt is written (its contents are discarded). Nothing touches the host install or profile.
param(
    [Parameter(Mandatory = $true)][ValidateSet('lifecycle', 'upgrade')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$SetupExe,
    [string]$V102Zip = '',
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
if ($Kind -eq 'upgrade' -and -not (Test-Path -LiteralPath $V102Zip -PathType Leaf)) { throw 'upgrade needs -V102Zip' }

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
    Copy-Item -LiteralPath $V102Zip -Destination (Join-Path $in 'v102.zip')
    Set-Content -LiteralPath (Join-Path $in 'expected-new.sha256') -Value $setupHash -NoNewline
    $zipHash = (Get-FileHash -LiteralPath $V102Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $in 'expected-v102.sha256') -Value $zipHash -NoNewline
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
