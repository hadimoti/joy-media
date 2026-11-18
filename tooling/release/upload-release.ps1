# Uploads the release files to a GitHub DRAFT release, one file per call, and tries again every 30 seconds
# until each file shows as uploaded. A half-uploaded asset of the same name is removed from the draft first.
# Usage: .\upload-release.ps1 -Tag v1.1.1 -Dir C:\jgp\v111\candidate-3ec5b951 [-Repo hadimoti/joy-media] [-MaxTries 120]
# It never publishes, never touches a published release, and never deletes a file from the release folder.
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Dir,
    [string]$Repo = 'hadimoti/joy-media',
    [int]$MaxTries = 120,
    [int]$WaitSeconds = 30
)
$ErrorActionPreference = 'Continue'
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { throw "Folder not found: $Dir" }

$release = gh release view $Tag --repo $Repo --json isDraft,id 2>$null | ConvertFrom-Json
if ($null -eq $release) { throw "Release $Tag not found in $Repo" }
if (-not $release.isDraft) { throw "Release $Tag is already published; this script only fills a draft." }

$failed = @()
foreach ($file in (Get-ChildItem -LiteralPath $Dir -File | Sort-Object Name)) {
    $name = $file.Name
    $done = $false
    for ($try = 1; $try -le $MaxTries -and -not $done; $try++) {
        $state = gh release view $Tag --repo $Repo --json assets -q ".assets[]|select(.name==`"$name`")|.state" 2>$null
        if ($state -eq 'uploaded') {
            Write-Output "$name already uploaded"
            $done = $true
            break
        }
        # A half-uploaded asset of the same name (draft only) is removed before the next try.
        $assetId = gh api "repos/$Repo/releases/$($release.id)/assets" --jq ".[]|select(.name==`"$name`")|.id" 2>$null
        if ($assetId) { gh api -X DELETE "repos/$Repo/releases/assets/$assetId" 2>&1 | Out-Null }
        Write-Output "try $try uploading $name ($($file.Length) bytes)"
        gh release upload $Tag $file.FullName --repo $Repo --clobber 2>&1 | Select-Object -Last 2
        $state = gh release view $Tag --repo $Repo --json assets -q ".assets[]|select(.name==`"$name`")|.state" 2>$null
        if ($state -eq 'uploaded') { $done = $true; Write-Output "$name uploaded"; break }
        Start-Sleep -Seconds $WaitSeconds
    }
    if (-not $done) { $failed += $name }
}
gh release view $Tag --repo $Repo --json assets -q '.assets[]|"\(.name) \(.size) \(.state)"'
if ($failed.Count -gt 0) { throw "Not uploaded: $($failed -join ', ')" }
