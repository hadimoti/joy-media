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
$stateDirectory = Split-Path -Parent $StatePath
New-Item -ItemType Directory -Force -Path (Join-Path $stateDirectory 'logs') | Out-Null

$powershellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($powershellPath)) {
    $powershellPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
}
if ([string]::IsNullOrWhiteSpace($powershellPath)) {
    throw 'Windows PowerShell was not found.'
}

$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -ApiUrl "{1}" -StatePath "{2}"' -f $runnerPath, $ApiUrl, $StatePath
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $repoRoot
$userId = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.MultipleInstances = 'IgnoreNew'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Headless JOY Media local Worker; starts at Windows logon and reconnects to joyst.ir.' | Out-Null
} else {
    Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed hidden '$TaskName' for $userId."
Write-Output "Worker source: $repoRoot"
Write-Output "State file: $StatePath"
