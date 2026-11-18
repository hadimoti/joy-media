# Offline smoke for the installed JOY Media app. Run only inside Windows Sandbox with networking disabled.
param(
  [switch]$DryRun,
  [string]$OutputDirectory = 'C:\out'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$evidencePath = Join-Path $OutputDirectory 'offline-smoke-evidence.json'
$networkLogPath = Join-Path $OutputDirectory 'network-evidence.log'
$steps = New-Object System.Collections.ArrayList
$startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")

function Add-Step([string]$Id, [bool]$Passed, [string]$Detail) {
  $result = if ($Passed) { 'pass' } else { 'fail' }
  [void]$steps.Add([ordered]@{ id = $Id; result = $result; detail = $Detail })
}

function Write-Evidence($Network) {
  foreach ($id in @('launch', 'import', 'export', 'doctor', 'render')) {
    if (@($steps.ToArray() | Where-Object { $_.id -eq $id }).Count -eq 0) {
      Add-Step $id $false 'Step did not complete.'
    }
  }
  $evidence = [ordered]@{
    schema = 'joy-media.offline-smoke-evidence/1'
    startedAt = $startedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    steps = @($steps.ToArray())
    network = $Network
  }
  [IO.File]::WriteAllText(
    $evidencePath,
    (($evidence | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
  Write-Output ('Offline smoke steps: ' + (@($steps.ToArray() | ForEach-Object { $_.id }) -join ', '))
}

if ($DryRun) {
  foreach ($id in @('launch', 'import', 'export', 'doctor', 'render')) {
    Add-Step $id $true 'Dry-run fixture only; command not run.'
  }
  $network = [ordered]@{
    networkingDisabled = $true
    adapterPresent = $false
    adapterCount = 0
    reason = 'Dry-run fixture only; the generated run.wsb sets Networking=Disable.'
    adapterNames = @()
  }
  Set-Content -LiteralPath $networkLogPath -Value @(
    'DRY RUN only; no adapter enumeration was performed.'
    'Generated run.wsb contains <Networking>Disable</Networking>.'
    'Egress counts are zero by construction only for this dry-run fixture.'
  ) -Encoding utf8
  Write-Evidence $network
  return
}

$app = $null
$network = [ordered]@{
  networkingDisabled = $true
  adapterPresent = $true
  adapterCount = -1
  reason = 'Get-NetAdapter did not complete.'
  adapterNames = @()
}

try {
  if ($env:USERNAME -ne 'WDAGUtilityAccount') {
    throw "Refusing to run: not inside Windows Sandbox (user $env:USERNAME)."
  }
  if ($env:USERPROFILE -match '(?i)HadiMoti') { throw 'Refusing to run: the host profile is visible.' }

  $adapterOutput = ''
  try {
    $adapters = @(Get-NetAdapter -ErrorAction Stop)
    $network.adapterCount = $adapters.Count
    $network.adapterPresent = $adapters.Count -gt 0
    $adapterOutput = if ($adapters.Count -eq 0) {
      'Get-NetAdapter returned no adapters.'
    } else {
      "Get-NetAdapter returned $($adapters.Count) adapter(s)."
    }
    $network.reason = if ($adapters.Count -eq 0) {
      'run.wsb sets Networking=Disable; Get-NetAdapter returned no adapters.'
    } else {
      'Get-NetAdapter reported one or more Sandbox network adapters.'
    }
  } catch {
    $adapterOutput = 'Get-NetAdapter failed: ' + $_.Exception.Message
    $network.adapterPresent = $true
    $network.adapterCount = -1
    $network.reason = $adapterOutput
  }
  Set-Content -LiteralPath $networkLogPath -Value @(
    'Generated run.wsb contains <Networking>Disable</Networking>.'
    'Command: Get-NetAdapter'
    $adapterOutput
    ('Reason=' + $network.reason)
    'Egress counts are zero by construction only when networking is disabled and Get-NetAdapter returns no adapters.'
  ) -Encoding utf8

  $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\JOY Media\joy-media.exe'
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
    Add-Step 'launch' $false "Installed app not found: $installedExe"
  } else {
    try {
      $app = Start-Process -FilePath $installedExe -PassThru
      $windowOpened = $false
      for ($i = 0; $i -lt 60 -and -not $windowOpened; $i++) {
        Start-Sleep -Seconds 1
        $app.Refresh()
        $windowOpened = $app.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($app.MainWindowTitle)
      }
      Add-Step 'launch' ($windowOpened -and -not $app.HasExited) "pid=$($app.Id); title=$($app.MainWindowTitle)"
    } catch {
      Add-Step 'launch' $false $_.Exception.Message
    }
  }

  if ($null -ne $app -and -not $app.HasExited) {
    [void]$app.CloseMainWindow()
    if (-not $app.WaitForExit(15000)) {
      try { $app.Kill() } catch { }
    }
  }

  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
  $env:JOY_MEDIA_EDGE_URL = 'off'

  $work = 'C:\work\offline-smoke'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $fixture = 'C:\in\offline-smoke-project.json'
  $database = Join-Path $work 'offline-smoke.sqlite'
  $importOutput = & joy-media project import $fixture --sqlite-path $database --json 2>&1
  $importExit = $LASTEXITCODE
  $importText = (@($importOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
  $importJson = $null
  try { $importJson = $importText | ConvertFrom-Json -ErrorAction Stop } catch { }
  $projectId = if ($null -ne $importJson -and $importJson.id -is [string]) { [string]$importJson.id } else { '' }
  $importOk = $importExit -eq 0 -and $projectId -eq 'sandbox-offline-smoke'
  Add-Step 'import' $importOk $(if ($importOk) { "Imported bundled fixture as $projectId." } else { "Import failed with exit $importExit." })

  $exportPath = Join-Path $work 'offline-smoke-export.json'
  $exportExit = -1
  if ($importOk) {
    $exportOutput = & joy-media project export $projectId --output $exportPath --sqlite-path $database --json 2>&1
    $exportExit = $LASTEXITCODE
    $exportText = (@($exportOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
    $exportJson = $null
    try { $exportJson = $exportText | ConvertFrom-Json -ErrorAction Stop } catch { }
    $exportOk = $exportExit -eq 0 -and $null -ne $exportJson -and $exportJson.id -eq $projectId -and
      (Test-Path -LiteralPath $exportPath -PathType Leaf)
  } else {
    $exportOk = $false
    $exportText = 'Export skipped because project import failed.'
  }
  Add-Step 'export' $exportOk $(if ($exportOk) { "Exported $projectId to the Sandbox work folder." } else { "Export failed with exit $exportExit." })

  $doctorOutput = & joy-media doctor --json 2>&1
  $doctorExit = $LASTEXITCODE
  $doctorText = (@($doctorOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
  $doctorJson = $null
  try { $doctorJson = $doctorText | ConvertFrom-Json -ErrorAction Stop } catch { }
  $doctorOk = $doctorExit -eq 0 -and $null -ne $doctorJson -and $doctorJson.ok -eq $true
  Add-Step 'doctor' $doctorOk $(if ($doctorOk) { 'doctor returned ok=true.' } else { "doctor failed with exit $doctorExit or returned ok=false." })

  if ($exportOk) {
    $renderDir = Join-Path $work 'render'
    $renderOutput = & joy-media render --project $exportPath --out $renderDir --json 2>&1
    $renderExit = $LASTEXITCODE
    $renderText = (@($renderOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
    $manifestWritten = $false
    foreach ($line in [regex]::Split($renderText, '\r?\n')) {
      try {
        $event = $line | ConvertFrom-Json -ErrorAction Stop
        if ($event.type -eq 'complete' -and $event.manifestWritten -eq $true) {
          $manifestWritten = Test-Path -LiteralPath $event.artifactPath -PathType Leaf
        }
      } catch { }
    }
    $renderOk = $renderExit -eq 0 -and $manifestWritten
  } else {
    $renderOk = $false
    $renderText = 'Render skipped because project export failed.'
  }
  Add-Step 'render' $renderOk $(if ($renderOk) { 'render wrote its manifest in the Sandbox work folder.' } else { "render failed with exit $renderExit or did not write its manifest." })
} catch {
  foreach ($id in @('launch', 'import', 'export', 'doctor', 'render')) {
    if (@($steps.ToArray() | Where-Object { $_.id -eq $id }).Count -eq 0) {
      Add-Step $id $false ('Stopped after error: ' + $_.Exception.Message)
    }
  }
} finally {
  if ($null -ne $app -and -not $app.HasExited) {
    [void]$app.CloseMainWindow()
    if (-not $app.WaitForExit(15000)) { try { $app.Kill() } catch { } }
  }
  Write-Evidence $network
}

if (@($steps.ToArray() | Where-Object { $_.result -ne 'pass' }).Count -gt 0 -or
  $network.networkingDisabled -ne $true -or $network.adapterPresent -ne $false -or $network.adapterCount -ne 0) {
  exit 1
}
exit 0
