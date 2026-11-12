param(
  [Parameter(Mandatory = $true)]
  [string]$Base,

  [switch]$ScanOnly,

  [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  Write-Output ("> $Name " + ($Arguments -join ' '))
  & $Name @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Name exited with code $LASTEXITCODE"
  }
}

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $result = & git -C $script:repoRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') exited with code $LASTEXITCODE"
  }
  return $result
}

try {
  if ($RepositoryRoot) {
    $script:repoRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
  } else {
    $script:repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
  }
  Set-Location -LiteralPath $script:repoRoot
  $null = Invoke-Git -Arguments @('rev-parse', '--verify', ($Base + '^{commit}'))

  $changedFiles = @(
    Invoke-Git -Arguments @('diff', '--name-only', '--diff-filter=ACMRTUXB', '--no-renames', $Base) |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -ne '' } |
      Sort-Object -Unique
  )
  $packageRoots = @(
    $changedFiles |
      ForEach-Object {
        if ($_ -match '^(apps|packages)/([^/]+)/') { "$($matches[1])/$($matches[2])" }
      } |
      Where-Object { $_ } |
      Sort-Object -Unique
  )

  if (-not $ScanOnly) {
    Invoke-CheckedCommand -Name 'pnpm' -Arguments @('typecheck')
    Invoke-CheckedCommand -Name 'pnpm' -Arguments @('lint')

    if ($changedFiles.Count -gt 0) {
      Invoke-CheckedCommand -Name 'pnpm' -Arguments (@('exec', 'prettier', '--check', '--ignore-unknown') + $changedFiles)
    } else {
      Write-Output 'No changed files for Prettier.'
    }

    if ($packageRoots.Count -gt 0) {
      Invoke-CheckedCommand -Name 'pnpm' -Arguments (@('exec', 'vitest', 'run') + $packageRoots)
    } else {
      Write-Output 'No app or package paths changed; Vitest skipped.'
    }
  }

  $diff = Invoke-Git -Arguments @('diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=0', $Base)
  $forbiddenPaths = @(
    ('C:\Users\' + 'HadiMoti'),
    ('C:\Users\' + 'HadiMoti\joy-media'),
    ('C:\Users\' + 'HadiMoti\joy-media-assets'),
    ('C:\Users\' + 'HadiMoti\AppData\Roaming\' + '@joy-media'),
    ('C:\Users\' + 'HadiMoti\Documents\' + 'JOY Projects'),
    ('E:\workspaces\' + 'joy-vps')
  )
  $forbiddenPatterns = @(
    @{ Label = 'owner path'; Pattern = [regex]::Escape($forbiddenPaths[0]) },
    @{ Label = 'owner path'; Pattern = [regex]::Escape($forbiddenPaths[2]) },
    @{ Label = 'owner path'; Pattern = [regex]::Escape($forbiddenPaths[3]) },
    @{ Label = 'owner path'; Pattern = [regex]::Escape($forbiddenPaths[4]) },
    @{ Label = 'owner path'; Pattern = [regex]::Escape($forbiddenPaths[5]) },
    @{ Label = 'e-mail address'; Pattern = '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b' },
    @{ Label = 'key-like string'; Pattern = [regex]::Escape(('sk' + '-')) },
    @{ Label = 'key-like string'; Pattern = [regex]::Escape(('Bearer ' + 'ey')) }
  )

  $hitCount = 0
  $diffLineNumber = 0
  foreach ($line in $diff) {
    $diffLineNumber++
    if ($line -match '^(\+\+\+|---) ') { continue }
    if ($line -notmatch '^[+-]') { continue }

    foreach ($pattern in $forbiddenPatterns) {
      if ($line -match $pattern.Pattern) {
        $hitCount++
        Write-Output ("Sensitive {0} detected in diff near diff line {1}." -f $pattern.Label, $diffLineNumber)
        break
      }
    }
  }

  if ($hitCount -gt 0) {
    Write-Output "Merge check failed: $hitCount sensitive diff hit(s)."
    exit 1
  }

  Write-Output 'Merge check passed: no sensitive diff hits.'
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
