[CmdletBinding()]
param(
    [string]$OutputPath = '',
    [string]$NodePath = '',
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$BuildMarker = 'source'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot 'apps\worker\bin\joy-worker.exe'
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
}
if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'Node.js 22+ was not found. Set -NodePath to the Node executable used for the Worker build.'
}

$entryPoint = Join-Path $repoRoot 'apps\worker\dist\index.js'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Built Worker entrypoint not found: $entryPoint. Run pnpm --filter @joy-media/worker build first."
}
$postject = Join-Path $repoRoot 'node_modules\.bin\postject.cmd'
$postjectScript = $null
$postjectWrapperTarget = Join-Path $repoRoot 'node_modules\postject\dist\cli.js'
if ((Test-Path -LiteralPath $postject -PathType Leaf) -and
    (Test-Path -LiteralPath $postjectWrapperTarget -PathType Leaf)) {
    $postjectScript = $postject
} else {
    $postjectScript = (Get-ChildItem -LiteralPath (Join-Path $repoRoot 'node_modules\.pnpm') -Directory -Filter 'postject@*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules\postject\dist\cli.js' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1)
}
if ([string]::IsNullOrWhiteSpace($postjectScript)) {
    throw 'postject is not installed. Run pnpm install before building joy-worker.exe.'
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$scratch = Join-Path $env:TEMP ('joy-worker-sea-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
    $blobPath = Join-Path $scratch 'sea-prep.blob'
    $configPath = Join-Path $scratch 'sea-config.json'
    # Stamp the marker into a scratch copy of the bootstrap so an update built
    # from identical source still produces distinct package bytes. The release
    # gate requires that distinction to prove the update really was replaced.
    $bootstrapPath = Join-Path $scratch 'worker-sea-bootstrap.cjs'
    $bootstrapSource = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\worker-sea-bootstrap.cjs') -Raw
    $markerLiteral = ConvertTo-Json $BuildMarker -Compress
    if (-not $bootstrapSource.Contains("'__JOY_MEDIA_BUILD_MARKER__'")) {
        throw 'worker-sea-bootstrap.cjs no longer carries the build marker placeholder.'
    }
    $bootstrapSource = $bootstrapSource.Replace("'__JOY_MEDIA_BUILD_MARKER__'", $markerLiteral)
    [System.IO.File]::WriteAllText($bootstrapPath, $bootstrapSource, (New-Object System.Text.UTF8Encoding($false)))
    $config = [ordered]@{
        main = $bootstrapPath
        output = $blobPath
        disableExperimentalSEAWarning = $true
        useSnapshot = $false
    } | ConvertTo-Json -Compress
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
    & $NodePath --experimental-sea-config $configPath
    if ($LASTEXITCODE -ne 0) { throw "Node SEA preparation failed with exit code $LASTEXITCODE." }

    Copy-Item -LiteralPath $NodePath -Destination $OutputPath -Force
    if ($postjectScript -like '*.cmd') {
        & $postjectScript $OutputPath NODE_SEA_BLOB $blobPath --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
    } else {
        $previousNodePath = $env:NODE_PATH
        try {
            $commanderNodeModules = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'node_modules\.pnpm') -Directory -Filter 'commander@9.*' -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'node_modules' } |
                Where-Object { Test-Path -LiteralPath (Join-Path $_ 'commander') -PathType Container } |
                Select-Object -First 1
            if ($commanderNodeModules) {
                $env:NODE_PATH = (@($commanderNodeModules, $previousNodePath) |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [System.IO.Path]::PathSeparator
            }
            & $NodePath $postjectScript $OutputPath NODE_SEA_BLOB $blobPath --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
        } finally {
            $env:NODE_PATH = $previousNodePath
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "SEA resource injection failed with exit code $LASTEXITCODE." }

    $selfTest = & $OutputPath --joy-worker-self-test
    if ($LASTEXITCODE -ne 0 -or $selfTest -notmatch '"ok"\s*:\s*true' -or
        $selfTest -notmatch [regex]::Escape(('"buildMarker":"' + $BuildMarker + '"'))) {
        throw 'joy-worker.exe self-test failed.'
    }
    Write-Output "Built $OutputPath"
    Write-Output $selfTest
}
finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
