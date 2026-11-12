$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$mergeCheck = Join-Path $PSScriptRoot 'merge-check.ps1'
$scratch = Join-Path $PSScriptRoot ('.merge-check-test-' + [guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $scratch | Out-Null
  Push-Location $scratch

  & git init --quiet
  if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
  & git config user.name 'Merge Check Test'
  & git config user.email ('qa' + '@' + 'example.invalid')
  if ($LASTEXITCODE -ne 0) { throw 'git config failed' }

  Set-Content -LiteralPath 'baseline.txt' -Value 'clean baseline' -NoNewline
  & git add baseline.txt
  & git commit --quiet -m 'baseline'
  if ($LASTEXITCODE -ne 0) { throw 'baseline commit failed' }
  $base = (& git rev-parse HEAD).Trim()

  Set-Content -LiteralPath 'planted-hit.txt' -Value ('const planted = "' + 'sk' + '-test0123456789";') -NoNewline
  & git add planted-hit.txt
  & git commit --quiet -m 'plant scanner test hit'
  if ($LASTEXITCODE -ne 0) { throw 'planted-hit commit failed' }

  & $mergeCheck -Base $base -ScanOnly -RepositoryRoot $scratch
  $scanExitCode = $LASTEXITCODE
  if ($scanExitCode -ne 1) {
    throw "Expected the planted key-like string to exit 1; got $scanExitCode"
  }

  Write-Output 'PASS: planted key-like diff hit exits 1.'

  # A dashed key format must be caught as well.
  $dashedScratch = Join-Path $PSScriptRoot ('.merge-check-dashed-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $dashedScratch | Out-Null
    Push-Location $dashedScratch

    & git init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
    & git config user.name 'Merge Check Test'
    & git config user.email ('qa' + '@' + 'example.invalid')
    if ($LASTEXITCODE -ne 0) { throw 'git config failed' }

    Set-Content -LiteralPath 'baseline.txt' -Value 'clean baseline' -NoNewline
    & git add baseline.txt
    & git commit --quiet -m 'baseline'
    if ($LASTEXITCODE -ne 0) { throw 'baseline commit failed' }
    $dashedBase = (& git rev-parse HEAD).Trim()

    Set-Content -LiteralPath 'dashed-hit.txt' -Value ('const planted = "' + 'sk' + '-proj-abc123def456";') -NoNewline
    & git add dashed-hit.txt
    & git commit --quiet -m 'plant dashed scanner test hit'
    if ($LASTEXITCODE -ne 0) { throw 'dashed-hit commit failed' }

    & $mergeCheck -Base $dashedBase -ScanOnly -RepositoryRoot $dashedScratch
    $dashedExitCode = $LASTEXITCODE
    if ($dashedExitCode -ne 1) {
      throw "Expected the dashed key-like string to exit 1; got $dashedExitCode"
    }

    Write-Output 'PASS: planted dashed key-like diff hit exits 1.'
  }
  finally {
    Pop-Location -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $dashedScratch -Recurse -Force -ErrorAction SilentlyContinue
  }

  # A document may legitimately contain words that merely start with the same
  # two letters ('TASK-CARDS', 'ask-before-remote'). Those must NOT trip the
  # scanner; only credential-shaped values should.
  $benignScratch = Join-Path $PSScriptRoot ('.merge-check-benign-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $benignScratch | Out-Null
    Push-Location $benignScratch

    & git init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
    & git config user.name 'Merge Check Test'
    & git config user.email ('qa' + '@' + 'example.invalid')
    if ($LASTEXITCODE -ne 0) { throw 'git config failed' }

    Set-Content -LiteralPath 'baseline.txt' -Value 'clean baseline' -NoNewline
    & git add baseline.txt
    & git commit --quiet -m 'baseline'
    if ($LASTEXITCODE -ne 0) { throw 'baseline commit failed' }
    $benignBase = (& git rev-parse HEAD).Trim()

    Set-Content -LiteralPath 'words.txt' -Value @(
      'Task: T-B01 of 03-TASK-CARDS.md:217-221'
      "privacyMode: 'ask-before-remote' | 'local-only'"
    ) -NoNewline
    & git add words.txt
    & git commit --quiet -m 'plant benign words'
    if ($LASTEXITCODE -ne 0) { throw 'benign commit failed' }

    & $mergeCheck -Base $benignBase -ScanOnly -RepositoryRoot $benignScratch
    $benignExitCode = $LASTEXITCODE
    if ($benignExitCode -ne 0) {
      throw "Expected benign words to pass the scan; got exit $benignExitCode"
    }

    Write-Output 'PASS: benign words sharing a key prefix exit 0.'
  }
  finally {
    Pop-Location -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $benignScratch -Recurse -Force -ErrorAction SilentlyContinue
  }
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
