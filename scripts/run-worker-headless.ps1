[CmdletBinding()]
param(
    [string]$ApiUrl,
    [string]$StatePath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
    $ApiUrl = if ([string]::IsNullOrWhiteSpace($env:JOY_MEDIA_API_URL)) {
        'https://joyst.ir/api'
    } else {
        $env:JOY_MEDIA_API_URL
    }
}

if ([string]::IsNullOrWhiteSpace($StatePath)) {
    $StatePath = if ([string]::IsNullOrWhiteSpace($env:JOY_MEDIA_WORKER_STATE_PATH)) {
        Join-Path $env:USERPROFILE '.joy-media\worker-state.json'
    } else {
        $env:JOY_MEDIA_WORKER_STATE_PATH
    }
}

$parsedApiUrl = [Uri]$ApiUrl
if ($parsedApiUrl.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($parsedApiUrl.Host)) {
    throw 'ApiUrl must be an HTTPS URL.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $repoRoot 'apps\worker\dist\index.js'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Built Worker entry point not found: $entryPoint"
}

$stateDirectory = Split-Path -Parent $StatePath
$logPath = Join-Path $stateDirectory 'logs\worker.log'
New-Item -ItemType Directory -Force -Path $stateDirectory, (Split-Path -Parent $logPath) | Out-Null

$nodeCandidates = @(
    $env:JOY_MEDIA_NODE_PATH,
    (Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'),
    ((Get-Command node.exe -ErrorAction SilentlyContinue).Source)
) | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf)
}
$nodePath = $nodeCandidates | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nodePath)) {
    throw 'Node.js was not found. Install Node 22+ or set JOY_MEDIA_NODE_PATH.'
}

$env:JOY_MEDIA_API_URL = $ApiUrl
$env:JOY_MEDIA_WORKER_STATE_PATH = $StatePath
Set-Location -LiteralPath $repoRoot

try {
    & $nodePath $entryPoint *>> $logPath
    exit $LASTEXITCODE
} catch {
    $_ | Out-String | Add-Content -LiteralPath $logPath
    exit 1
}
