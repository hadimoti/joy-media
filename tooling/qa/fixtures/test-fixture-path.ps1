# T-A04 review: checks the output-folder guard without Pester.
# Run: pwsh tooling/qa/fixtures/test-fixture-path.ps1
# Exit code 0 when every case behaves as expected, 1 otherwise.
#
# Every refused case is refused by Resolve-FixtureOutDir, which make-fixtures.ps1
# calls before its first mkdir or write. The only things this test creates are
# scratch folders and one junction under the temp directory, all removed at the end.

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
# The owner's folders come from the profile at run time, never as literal paths in the repository.
Assert-Refused (Join-Path $env:USERPROFILE 'Documents') 'owner documents'
Assert-Refused (Join-Path $env:USERPROFILE 'joy-media-assets') 'owner library'
# Three .. from C:\jgp\v111\fixtures reach C:\, then the profile's own path.
$profilePath = Split-Path -Path $env:USERPROFILE -NoQualifier
Assert-Refused ('C:\jgp\v111\fixtures\..\..\..' + $profilePath + '\Documents') 'dot-dot escape from the fixture folder'
Assert-Refused 'C:\jgp\v111\fixtures\..\..\..\Windows' 'dot-dot escape to the system folder'
Assert-Refused 'C:\jgp\v111\fixtures-evil' 'sibling with the same prefix'
Assert-Refused 'C:\jgp\v111\fixtures-evil\x' 'child of a sibling with the same prefix'
Assert-Refused 'C:\jgp\v111' 'parent of the fixture folder'
Assert-Refused 'C:\jgp\v111\fixtures\..\fixtures-evil' 'dot-dot into a sibling'
Assert-Refused $temp 'the temp directory itself'
Assert-Refused (Join-Path $temp 'some-other-folder') 'a temp folder that is not joy-fixtures-*'
Assert-Refused '' 'empty path'
Assert-Refused '   ' 'blank path'

# Refused: UNC and extended-length forms, which name the same disk but not by the plain C:\ path.
Assert-Refused '\\localhost\C$\jgp\v111\fixtures' 'UNC path to the fixture folder'
Assert-Refused '\\localhost\C$\Windows' 'UNC path to the system folder'
Assert-Refused '\\?\C:\jgp\v111\fixtures' 'extended-length path to the fixture folder'
Assert-Refused '\\?\C:\jgp\v111\fixtures\run-2' 'extended-length child of the fixture folder'
Assert-Refused '\\?\UNC\localhost\C$\jgp\v111\fixtures' 'extended-length UNC path'

# Refused: forward slashes that leave the fixture folder. Normalised first, then checked like backslashes.
Assert-Refused 'C:/jgp/v111/fixtures-evil' 'forward slashes to a sibling with the same prefix'
Assert-Refused ('C:/jgp/v111/fixtures/../../..' + ($profilePath -replace '\\', '/') + '/Documents') 'forward-slash escape to the owner profile'
Assert-Refused 'C:\jgp\v111\fixtures/../fixtures-evil' 'mixed separators escaping into a sibling'

# Refused: an 8.3 short-name alias of a folder outside the root (the owner's Documents folder, when the volume has one).
$fso = New-Object -ComObject Scripting.FileSystemObject
$documents = Join-Path $env:USERPROFILE 'Documents'
$shortDocuments = $fso.GetFolder($documents).ShortPath
if ($shortDocuments -eq $documents) {
  Write-Output 'skipped: this volume gives the profile Documents folder no 8.3 alias'
} else {
  Assert-Refused $shortDocuments '8.3 short-name alias of a folder outside the root'
}

# Accepted: the fixture folder, its children, and a joy-fixtures-* scratch folder under temp.
Assert-Accepted 'C:\jgp\v111\fixtures' 'the fixture folder'
Assert-Accepted 'C:\jgp\v111\fixtures\' 'the fixture folder with a trailing separator'
Assert-Accepted 'c:\JGP\v111\FIXTURES' 'the fixture folder, other case'
Assert-Accepted 'C:\jgp\v111\fixtures\run-2\deeper' 'a child that does not exist yet'
Assert-Accepted 'C:/jgp/v111/fixtures/run-3' 'forward slashes that stay inside the fixture folder'
Assert-Accepted (Join-Path $temp 'joy-fixtures-selftest') 'a scratch folder under temp'

# A junction inside an allowed scratch folder that points outside it. Created under the temp
# directory only; the junction is removed with Directory.Delete (which removes the link, not the
# target contents) and both scratch folders are removed afterwards.
$tag = [guid]::NewGuid().ToString('N').Substring(0, 8)
$scratch = Join-Path $temp "joy-fixtures-guard-$tag"
$outside = Join-Path $temp "guard-outside-$tag"
$link = Join-Path $scratch 'link'
try {
  New-Item -ItemType Directory -Path $scratch | Out-Null
  New-Item -ItemType Directory -Path $outside | Out-Null
  New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
  Assert-Accepted $scratch 'the scratch folder itself, which holds no link'
  Assert-Refused $link 'a junction inside the scratch folder that points outside it'
  Assert-Refused (Join-Path $link 'child') 'a child of that junction'
  if (@(Get-ChildItem -LiteralPath $outside -Force).Count -ne 0) {
    $failures.Add("the junction target was written to: $outside")
  }
} finally {
  if (Test-Path -LiteralPath $link) { [System.IO.Directory]::Delete($link, $false) }
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $outside -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Output "FAIL $_" }
  exit 1
}
Write-Output 'all fixture path checks passed'
exit 0
