# Windows Sandbox upgrade run: install an older release (v1.0.2 from the released zip, or v1.1.0 or 1.0.2 from its setup exe) and run it once, then install the candidate setup over it, run it, uninstall.
# Inputs in C:\in: upgrade-plan.json (fromVersion, fromMode, toVersion), joy-media-setup.exe, expected-new.sha256, and either
#   zip mode:   v102.zip + expected-v102.sha256
#   setup mode: from-setup.exe + expected-from.sha256
# Output in C:\out: upgrade.json (schema joy-media.sandbox-upgrade/1).
# Every step is logged, every wait has a timeout, and nothing here changes a security setting.
$ErrorActionPreference = 'Stop'
$out = 'C:\out'
$logPath = Join-Path $out 'progress.log'
$steps = New-Object System.Collections.ArrayList
$record = [ordered]@{ schema = 'joy-media.sandbox-upgrade/1'; startedAt = (Get-Date).ToUniversalTime().ToString('o'); steps = $steps }
function Write-Log([string]$Text) { Add-Content -Path $logPath -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $Text) -Encoding utf8 }
function Save-Record { $record | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $out 'upgrade.json') -Encoding utf8 }
function Add-Step([string]$Id, [bool]$Ok, [string]$Detail) {
  $result = if ($Ok) { 'pass' } else { 'fail' }
  [void]$steps.Add([ordered]@{ id = $Id; result = $result; detail = $Detail })
  Write-Log "step $Id $result ($Detail)"
  Save-Record
}
$root = Join-Path $env:LOCALAPPDATA 'Programs\JOY Media'
$data = Join-Path $env:APPDATA '@joy-media'
function Listing([string]$Path) {
  if (-not (Test-Path $Path)) { return @() }
  @(Get-ChildItem $Path -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($Path.Length).TrimStart('\') + '|' + $_.Length })
}
function Snap([string]$Name) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $ver = $null
  try { $ver = (Get-Content (Join-Path $root 'resources\app\package.json') -Raw | ConvertFrom-Json).version } catch { }
  $uninst = $null
  try { $uninst = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia' -ErrorAction Stop).DisplayVersion } catch { }
  $joyKey = $null
  try { $joyKey = (Get-ItemProperty 'HKCU:\Software\Classes\joy\shell\open\command' -ErrorAction Stop).'(default)' } catch { }
  $dl = Listing $data
  $snap = [ordered]@{
    name = $Name; installFolderExists = (Test-Path $root); installFileCount = (Listing $root).Count
    appPackageVersion = $ver; uninstallDisplayVersion = $uninst
    pathEntries = @($userPath -split ';' | Where-Object { $_ -like '*JOY Media*' }).Count
    joyKey = $joyKey; dataFolderExists = (Test-Path $data); dataFileCount = $dl.Count
  }
  $record[$Name] = $snap
  Write-Log ("snapshot $Name " + ($snap | ConvertTo-Json -Compress))
  Listing $root | Set-Content (Join-Path $out "install-listing-$Name.txt") -Encoding utf8
  $dl | Set-Content (Join-Path $out "data-listing-$Name.txt") -Encoding utf8
  Save-Record
}
function Save-Events {
  foreach ($name in @('Microsoft-Windows-CodeIntegrity/Operational', 'Application')) {
    $file = Join-Path $out (($name -replace '[^A-Za-z0-9]', '-') + '.txt')
    try {
      $events = Get-WinEvent -LogName $name -MaxEvents 40 -ErrorAction Stop | Where-Object { $name -ne 'Application' -or $_.LevelDisplayName -in @('Error', 'Warning') }
      $lines = foreach ($e in $events) { '{0} {1} {2} {3}' -f $e.TimeCreated.ToString('HH:mm:ss'), $e.Id, $e.ProviderName, (($e.Message -split "`n")[0]) }
      Set-Content -Path $file -Value $lines -Encoding utf8
    } catch { Set-Content -Path $file -Value ('could not read: ' + $_.Exception.Message) -Encoding utf8 }
  }
}
function Run-App([string]$Tag, [int]$HoldSeconds) {
  $exe = Join-Path $root 'joy-media.exe'
  $app = Start-Process -FilePath $exe -PassThru
  $titled = $false
  for ($i = 0; $i -lt 90 -and -not $titled; $i++) { Start-Sleep -Seconds 1; $app.Refresh(); if ($app.MainWindowHandle -ne 0 -and $app.MainWindowTitle) { $titled = $true } }
  Add-Step "$Tag-open-window" $titled "title: $($app.MainWindowTitle)"
  Start-Sleep -Seconds $HoldSeconds
  $alive = -not $app.HasExited
  Add-Step "$Tag-still-running" $alive "after $HoldSeconds s"
  if ($alive) {
    [void]$app.CloseMainWindow()
    if (-not $app.WaitForExit(20000)) { try { $app.Kill() } catch { }; Add-Step "$Tag-close" $false 'had to kill' } else { Add-Step "$Tag-close" $true "exit $($app.ExitCode)" }
  }
  Start-Sleep -Seconds 3
  $left = @(Get-Process -Name 'joy-media' -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }
  Add-Step "$Tag-no-process-left" ($left.Count -eq 0) "processes left: $($left.Count)"
}

Write-Log 'script started'
Save-Record
try {
  if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw "Refusing to run: not inside Windows Sandbox (user $env:USERNAME)." }
  if ($env:USERPROFILE -match '(?i)HadiMoti') { throw 'Refusing to run: the host profile is visible.' }
  $record.identity = [ordered]@{ user = $env:USERNAME; computer = $env:COMPUTERNAME }
  Add-Step 'sandbox-identity' $true "$env:USERNAME on $env:COMPUTERNAME"

  # The versions come from the plan file that run-sandbox.ps1 wrote; they are never assumed here.
  $plan = Get-Content 'C:\in\upgrade-plan.json' -Raw | ConvertFrom-Json
  $fromVersion = [string]$plan.fromVersion
  $fromMode = [string]$plan.fromMode
  $toVersion = [string]$plan.toVersion
  if ($fromVersion -notin @('1.0.2', '1.1.0')) { throw "Refusing to run: unsupported start version $fromVersion." }
  if ($fromMode -notin @('zip', 'setup')) { throw "Refusing to run: unknown install mode $fromMode." }
  if ($fromMode -eq 'zip' -and $fromVersion -ne '1.0.2') { throw 'Refusing to run: only v1.0.2 comes from a zip.' }
  if ($toVersion -notmatch '^\d+\.\d+\.\d+$' -or $toVersion -eq $fromVersion) { throw "Refusing to run: bad after version $toVersion." }
  $fromTag = 'v' + ($fromVersion -replace '\.', '')
  $toTag = 'v' + ($toVersion -replace '\.', '')
  $record.fromVersion = $fromVersion
  $record.fromMode = $fromMode
  $record.toVersion = $toVersion
  Save-Record

  Snap 'S0-clean'

  # Digests of the inputs.
  if ($fromMode -eq 'zip') {
    $zipH = (Get-FileHash -Algorithm SHA256 'C:\in\v102.zip').Hash.ToLower()
    Add-Step "$fromTag-zip-digest" ($zipH -eq (Get-Content 'C:\in\expected-v102.sha256' -Raw).Trim()) $zipH
  } else {
    $fromH = (Get-FileHash -Algorithm SHA256 'C:\in\from-setup.exe').Hash.ToLower()
    Add-Step "$fromTag-setup-digest" ($fromH -eq (Get-Content 'C:\in\expected-from.sha256' -Raw).Trim()) $fromH
  }
  $newH = (Get-FileHash -Algorithm SHA256 'C:\in\joy-media-setup.exe').Hash.ToLower()
  Add-Step 'new-setup-digest' ($newH -eq (Get-Content 'C:\in\expected-new.sha256' -Raw).Trim()) $newH

  # Phase A: the older release installed and first run.
  if ($fromMode -eq 'zip') {
    New-Item -ItemType Directory -Force 'C:\work' | Out-Null
    Expand-Archive -Path 'C:\in\v102.zip' -DestinationPath 'C:\work\v102' -Force
    $setupPs1 = 'C:\work\v102\joy-media-win32-x64\Setup-JoyMedia.ps1'
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setupPs1, '-Silent' -PassThru -Wait
  } else {
    $p = Start-Process -FilePath 'C:\in\from-setup.exe' -ArgumentList '/s' -PassThru
    if (-not $p.WaitForExit(600000)) { try { $p.Kill() } catch { }; Add-Step "$fromTag-install" $false 'timed out after 600 s'; throw 'from-version install timed out' }
  }
  Add-Step "$fromTag-install" ($p.ExitCode -eq 0 -and (Test-Path (Join-Path $root 'joy-media.exe'))) "exit $($p.ExitCode)"
  Snap "S1-$fromTag-installed"
  Run-App $fromTag 20
  Snap "S2-$fromTag-after-run"

  # Plant a marker in the app data folder to see whether an upgrade keeps it.
  New-Item -ItemType Directory -Force $data | Out-Null
  Set-Content (Join-Path $data 'upgrade-marker.txt') "marker created before the upgrade from $fromVersion" -Encoding utf8
  $beforeData = Listing $data

  # Phase B: candidate setup over the top.
  $p2 = Start-Process -FilePath 'C:\in\joy-media-setup.exe' -ArgumentList '/s' -PassThru
  if (-not $p2.WaitForExit(600000)) { try { $p2.Kill() } catch { }; Add-Step 'new-install-over' $false 'timed out after 600 s'; throw 'upgrade install timed out' }
  Add-Step 'new-install-over' ($p2.ExitCode -eq 0) "exit $($p2.ExitCode)"
  Snap 'S3-upgraded'
  $fromFiles = Get-Content (Join-Path $out "install-listing-S2-$fromTag-after-run.txt")
  $newFiles = Get-Content (Join-Path $out 'install-listing-S3-upgraded.txt')
  $namesFrom = $fromFiles | ForEach-Object { ($_ -split '\|')[0] }
  $namesNew = $newFiles | ForEach-Object { ($_ -split '\|')[0] }
  $stale = @($namesFrom | Where-Object { $_ -notin $namesNew })
  Add-Step "stale-files-from-$fromTag" $true "files in v$fromVersion but not in the upgraded folder: $($stale.Count)"
  $stale | Select-Object -First 60 | Set-Content (Join-Path $out 'stale-files.txt') -Encoding utf8
  $marker = Test-Path (Join-Path $data 'upgrade-marker.txt')
  Add-Step 'data-marker-kept' $marker 'upgrade-marker.txt'
  $afterData = Listing $data
  $lost = @($beforeData | Where-Object { $_ -notin $afterData })
  Add-Step 'data-files-lost' ($lost.Count -eq 0) "files from before the upgrade missing afterwards: $($lost.Count)"

  # Phase C: candidate app on the existing data.
  Run-App $toTag 45
  Snap "S4-$toTag-after-run"

  # Phase D: uninstall, then check data.
  $uninstall = Join-Path $root 'uninstall.cmd'
  if (Test-Path $uninstall) {
    $un = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$uninstall`"" -PassThru
    if (-not $un.WaitForExit(300000)) { try { $un.Kill() } catch { } }
    Add-Step 'uninstall' ($un.HasExited -and $un.ExitCode -eq 0) "exit $($un.ExitCode)"
  } else { Add-Step 'uninstall' $false 'uninstall.cmd is missing' }
  $gone = $false
  for ($i = 0; $i -lt 60 -and -not $gone; $i++) { Start-Sleep -Seconds 1; if (-not (Test-Path $root)) { $gone = $true } }
  Add-Step 'folder-removed' $gone $root
  Snap 'S5-uninstalled'
} catch {
  Add-Step 'error' $false $_.Exception.Message
} finally {
  Save-Events
  $record.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-Record
  Write-Log 'script finished'
}
