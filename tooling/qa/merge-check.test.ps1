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

  Set-Content -LiteralPath 'planted-hit.txt' -Value ('const planted = "' + 'sk' + '-test";') -NoNewline
  & git add planted-hit.txt
  & git commit --quiet -m 'plant scanner test hit'
  if ($LASTEXITCODE -ne 0) { throw 'planted-hit commit failed' }

  & $mergeCheck -Base $base -ScanOnly -RepositoryRoot $scratch
  $scanExitCode = $LASTEXITCODE
  if ($scanExitCode -ne 1) {
    throw "Expected the planted key-like string to exit 1; got $scanExitCode"
  }

  Write-Output 'PASS: planted key-like diff hit exits 1.'
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
