# T-A04 review: checks the output-folder guard without Pester.
# Run: pwsh tooling/qa/fixtures/test-fixture-path.ps1
# Exit code 0 when every case behaves as expected, 1 otherwise. Nothing is written.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'fixture-path.ps1')

$temp = [System.IO.Path]::GetTempPath().TrimEnd('\')
$failures = New-Object System.Collections.Generic.List[string]

function Assert-Refused {
  param([string]$Path, [string]$Why)
  try {
    $resolved = Resolve-FixtureOutDir -Path $Path
    $script:failures.Add("ACCEPTED but must be refused ($Why): $Path -> $resolved")
  } catch {
    Write-Output "refused  ok  ($Why): $Path"
  }
}

function Assert-Accepted {
  param([string]$Path, [string]$Why)
  try {
    $resolved = Resolve-FixtureOutDir -Path $Path
    Write-Output "accepted ok  ($Why): $Path -> $resolved"
  } catch {
    $script:failures.Add("REFUSED but must be accepted ($Why): $Path : $($_.Exception.Message)")
  }
}

# Refused: a folder that belongs to the owner, a path that escapes with .., a sibling with the same prefix.
Assert-Refused 'C:\Users\HadiMoti\Documents' 'owner documents'
Assert-Refused 'C:\Users\HadiMoti\joy-media-assets' 'owner library'
Assert-Refused 'C:\jgp\v111\fixtures\..\..\Users\HadiMoti\Documents' 'dot-dot escape from the fixture folder'
Assert-Refused 'C:\jgp\v111\fixtures\..\..\..\Windows' 'dot-dot escape to the system folder'
Assert-Refused 'C:\jgp\v111\fixtures-evil' 'sibling with the same prefix'
Assert-Refused 'C:\jgp\v111\fixtures-evil\x' 'child of a sibling with the same prefix'
Assert-Refused 'C:\jgp\v111' 'parent of the fixture folder'
Assert-Refused 'C:\jgp\v111\fixtures\..\fixtures-evil' 'dot-dot into a sibling'
Assert-Refused $temp 'the temp directory itself'
Assert-Refused (Join-Path $temp 'some-other-folder') 'a temp folder that is not joy-fixtures-*'
Assert-Refused '' 'empty path'
Assert-Refused '   ' 'blank path'

# Accepted: the fixture folder, its children, and a joy-fixtures-* scratch folder under temp.
Assert-Accepted 'C:\jgp\v111\fixtures' 'the fixture folder'
Assert-Accepted 'C:\jgp\v111\fixtures\' 'the fixture folder with a trailing separator'
Assert-Accepted 'c:\JGP\v111\FIXTURES' 'the fixture folder, other case'
Assert-Accepted 'C:\jgp\v111\fixtures\run-2\deeper' 'a child that does not exist yet'
Assert-Accepted (Join-Path $temp 'joy-fixtures-selftest') 'a scratch folder under temp'

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Output "FAIL $_" }
  exit 1
}
Write-Output 'all fixture path checks passed'
exit 0
