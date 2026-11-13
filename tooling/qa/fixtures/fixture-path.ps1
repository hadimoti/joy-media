# T-A04 review: where the fixture pack may be written.
#
# The fixture script writes and overwrites files (ffmpeg -y), so the output
# folder is checked before the first write or mkdir. Dot-sourced by
# make-fixtures.ps1 and by test-fixture-path.ps1.
#
# Allowed:
#   - the fixture folder C:\jgp\v111\fixtures, or any folder inside it;
#   - a scratch folder named joy-fixtures-* directly inside the system temp
#     directory (for tests), or any folder inside one.
# Refused: everything else, including a sibling with the same prefix
# (C:\jgp\v111\fixtures-evil), a path that escapes with .. after resolving,
# and any path that passes through a symbolic link or junction.

$script:FixtureRoot = 'C:\jgp\v111\fixtures'

function Test-PathInside {
  # True when $Candidate equals $Base or is inside it. Both must be full paths
  # without a trailing separator. The separator is part of the comparison, so
  # C:\base-evil is not inside C:\base.
  param([string]$Candidate, [string]$Base)
  if ($Candidate.Equals($Base, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $Candidate.StartsWith($Base + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-FixtureOutDir {
  # Returns the canonical full path of an allowed output folder, or throws.
  # Nothing is created or written here; only existing folders are inspected.
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$TempRoot = [System.IO.Path]::GetTempPath()
  )
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Refused: the output folder is empty.' }

  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [System.IO.Path]::GetFullPath($script:FixtureRoot).TrimEnd('\')
  $temp = [System.IO.Path]::GetFullPath($TempRoot).TrimEnd('\')

  $allowedBase = $null
  if (Test-PathInside -Candidate $full -Base $root) {
    $allowedBase = $root
  } elseif (Test-PathInside -Candidate $full -Base $temp) {
    # Only a joy-fixtures-* folder directly under the temp directory.
    $first = $full.Substring([Math]::Min($full.Length, $temp.Length + 1)).Split('\')[0]
    if ($first -like 'joy-fixtures-*' -and $full -ne $temp) {
      $allowedBase = Join-Path $temp $first
    }
  }
  if ($null -eq $allowedBase) {
    throw "Refused: $full is outside $root and is not a joy-fixtures-* folder under $temp."
  }

  # No symbolic link or junction on the way from the output folder up to the drive root.
  # The walk goes through folders that do not exist yet: a missing child of a junction
  # must be refused too, or mkdir would create it through the link.
  $cursor = $full
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refused: $cursor is a symbolic link or junction."
      }
    }
    $parent = Split-Path -Path $cursor -Parent
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}
