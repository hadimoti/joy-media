# Windows Sandbox installed-lifecycle run for the candidate setup exe: install, open, close, uninstall.
# Inputs in C:in: joy-media-setup.exe and expected.sha256. Output in C:out: lifecycle.json (schema joy-media.sandbox-lifecycle/1).
# Every step is logged as it happens, every wait has a timeout, and nothing here changes a security setting.
$ErrorActionPreference = 'Stop'
$out = 'C:\out'
$logPath = Join-Path $out 'progress.log'
$steps = New-Object System.Collections.ArrayList
$record = [ordered]@{ schema = 'joy-media.sandbox-lifecycle/1'; startedAt = (Get-Date).ToUniversalTime().ToString('o'); steps = $steps }

function Write-Log([string]$Text) { Add-Content -Path $logPath -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $Text) -Encoding utf8 }
function Save-Record { $record | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $out 'lifecycle.json') -Encoding utf8 }
function Add-Step([string]$Id, [bool]$Ok, [string]$Detail) {
  $result = if ($Ok) { 'pass' } else { 'fail' }
  [void]$steps.Add([ordered]@{ id = $Id; result = $result; detail = $Detail })
  Write-Log "step $Id $result ($Detail)"
  Save-Record
}
function Snapshot([string]$Name) {
  $root = Join-Path $env:LOCALAPPDATA 'Programs\JOY Media'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $joyKey = $null
  try { $joyKey = (Get-ItemProperty 'HKCU:\Software\Classes\joy\shell\open\command' -ErrorAction Stop).'(default)' } catch { }
  $uninstKey = Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia'
  $files = @()
  if (Test-Path $root) { $files = @(Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue) }
  $snap = [ordered]@{
    name = $Name
    installFolderExists = (Test-Path $root)
    installFileCount = $files.Count
    pathHasJoy = [bool]($userPath -and ($userPath -split ';' | Where-Object { $_ -like '*JOY Media*' }))
    joyKey = $joyKey
    uninstallKey = $uninstKey
    desktopShortcut = (Test-Path (Join-Path $env:USERPROFILE 'Desktop\JOY Media.lnk'))
    startMenuShortcut = (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\JOY Media.lnk'))
  }
  $record[$Name] = $snap
  Write-Log ("snapshot $Name " + ($snap | ConvertTo-Json -Compress))
  Save-Record
  if ($Name -eq 'afterUninstall' -and $files.Count -gt 0) {
    $files | Select-Object -First 40 -ExpandProperty FullName | Set-Content (Join-Path $out 'leftover-files.txt') -Encoding utf8
  }
}
function Save-Events {
  foreach ($name in @('Microsoft-Windows-CodeIntegrity/Operational', 'Microsoft-Windows-AppLocker/EXE and DLL')) {
    $file = Join-Path $out (($name -replace '[^A-Za-z0-9]', '-') + '.txt')
    try {
      $events = Get-WinEvent -LogName $name -MaxEvents 25 -ErrorAction Stop
      $lines = foreach ($e in $events) { '{0} {1} {2}' -f $e.TimeCreated.ToString('HH:mm:ss'), $e.Id, (($e.Message -split "`n")[0]) }
      Set-Content -Path $file -Value $lines -Encoding utf8
    } catch { Set-Content -Path $file -Value ('could not read: ' + $_.Exception.Message) -Encoding utf8 }
  }
}

Write-Log 'script started'
Save-Record
try {
  if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw "Refusing to run: not inside Windows Sandbox (user $env:USERNAME)." }
  if ($env:USERPROFILE -match '(?i)HadiMoti') { throw 'Refusing to run: the host profile is visible.' }
  $record.identity = [ordered]@{ user = $env:USERNAME; computer = $env:COMPUTERNAME }
  Add-Step 'sandbox-identity' $true "$env:USERNAME on $env:COMPUTERNAME"
  Snapshot 'beforeInstall'

  $work = 'C:\work'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $setup = Join-Path $work 'joy-media-setup.exe'
  Copy-Item -Force 'C:\in\joy-media-setup.exe' $setup
  $expected = (Get-Content 'C:\in\expected.sha256' -Raw).Trim().ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLower()
  Add-Step 'setup-digest' ($actual -eq $expected) $actual
  if ($actual -ne $expected) { throw 'setup digest does not match the candidate' }
  $sig = (Get-AuthenticodeSignature $setup).Status.ToString()
  Add-Step 'setup-signature-status' $true $sig

  $control = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'exit 0' -PassThru
  if (-not $control.WaitForExit(30000)) { try { $control.Kill() } catch { } }
  Add-Step 'control-signed-program' ($control.HasExited -and $control.ExitCode -eq 0) "exit $($control.ExitCode)"

  Write-Log 'starting silent install'
  $install = Start-Process -FilePath $setup -ArgumentList '/s' -PassThru
  if (-not $install.WaitForExit(600000)) { try { $install.Kill() } catch { }; Add-Step 'install-silent' $false 'timed out after 600 s'; throw 'install timed out' }
  Add-Step 'install-silent' ($install.ExitCode -eq 0) "exit $($install.ExitCode)"

  $root = Join-Path $env:LOCALAPPDATA 'Programs\JOY Media'
  $exe = Join-Path $root 'joy-media.exe'
  Add-Step 'installed' (Test-Path $exe) $root
  Snapshot 'afterInstall'
  try { Add-Step 'exe-version' $true ((Get-Item $exe).VersionInfo.ProductVersion) } catch { Add-Step 'exe-version' $false $_.Exception.Message }

  $app = Start-Process -FilePath $exe -PassThru
  $titled = $false
  for ($i = 0; $i -lt 60 -and -not $titled; $i++) { Start-Sleep -Seconds 1; $app.Refresh(); if ($app.MainWindowHandle -ne 0 -and $app.MainWindowTitle) { $titled = $true } }
  Add-Step 'open-window' $titled "title: $($app.MainWindowTitle)"
  Start-Sleep -Seconds 5
  Snapshot 'whileRunning'
  if (-not $app.HasExited) {
    [void]$app.CloseMainWindow()
    if (-not $app.WaitForExit(15000)) { try { $app.Kill() } catch { }; Add-Step 'close-app' $false 'had to kill the app' } else { Add-Step 'close-app' $true "exit $($app.ExitCode)" }
  }
  Start-Sleep -Seconds 3
  $left = @(Get-Process -Name 'joy-media' -ErrorAction SilentlyContinue)
  Add-Step 'no-process-after-close' ($left.Count -eq 0) "processes left: $($left.Count)"

  $uninstall = Join-Path $root 'uninstall.cmd'
  if (Test-Path $uninstall) {
    $un = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$uninstall`"" -PassThru
    if (-not $un.WaitForExit(300000)) { try { $un.Kill() } catch { } }
    Add-Step 'uninstall' ($un.HasExited -and $un.ExitCode -eq 0) "exit $($un.ExitCode)"
  } else { Add-Step 'uninstall' $false 'uninstall.cmd is missing' }

  # The uninstaller removes the folder in the background (2 s delay, up to 30 s). Wait up to 60 s.
  $gone = $false
  $t0 = Get-Date
  for ($i = 0; $i -lt 60 -and -not $gone; $i++) { Start-Sleep -Seconds 1; if (-not (Test-Path $root)) { $gone = $true } }
  Add-Step 'folder-removed' $gone ("{0} after {1:N0} s" -f $root, ((Get-Date) - $t0).TotalSeconds)
  Snapshot 'afterUninstall'
} catch {
  Add-Step 'error' $false $_.Exception.Message
} finally {
  Save-Events
  $record.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-Record
  Write-Log 'script finished'
}
